import type { Point, RigidTransform, SegmentTag, StandardProfile } from './types.js';
import { applyTransform } from './geometry.js';
import { projectToStandard } from './projection.js';

export interface StdRootCandidate {
  index: number;
  stdPoint: Point;
  stdS: number;
  /** 去趋势后的局部内凹显著度（mm）。 */
  prominence: number;
  measuredPoint: Point;
}

interface DetectOpts {
  minProminence: number;
  maxPairDistance: number;
  minIndexSep: number;
}

/**
 * 在“粗配准后的标准坐标系”检测根弧锦标候选。
 * 先在标准 flange_root 段内对“弧长-法向偏移”做局部线性去趋势（消除磨耗盆缓坡），
 * 再在残差上寻找局部内凹峰。真根底与紧邻的孪生根凹都会作为独立候选返回；
 * 不唯一化、不按导入顺序取舍。
 */
export function detectRootsInStdFrame(
  measured: Point[],
  std: StandardProfile,
  coarse: RigidTransform,
  opts: DetectOpts,
): StdRootCandidate[] {
  const rootRange = std.segmentRanges.find((r) => r.tag === 'flange_root');
  const sLo = rootRange ? rootRange.s0 : std.rootChampionship.s - 7;
  const sHi = rootRange ? rootRange.s1 : std.rootChampionship.s + 7;
  const allowed = new Set<SegmentTag>(['flange_root']);
  const transformed = measured.map((p) => applyTransform(p, coarse));

  interface Rec {
    index: number;
    s: number;
    off: number;
    q: Point;
    p: Point;
  }
  const recs: Rec[] = [];
  for (let i = 0; i < transformed.length; i++) {
    const h = projectToStandard(transformed[i], std, allowed, opts.maxPairDistance);
    if (!h || h.beyondExtent) continue;
    if (h.s < sLo + 0.8 || h.s > sHi - 1.2) continue;
    recs.push({ index: i, s: h.s, off: h.signedNormal, q: transformed[i], p: measured[i] });
  }
  recs.sort((a, b) => a.s - b.s);

  // 逐点：用 ±(2~4)mm 环带做稳健线性去趋势，残差 < 0（相对趋势更凹）即候选显著度。
  const cands: StdRootCandidate[] = [];
  for (let i = 0; i < recs.length; i++) {
    const ring: { s: number; o: number }[] = [];
    for (let j = 0; j < recs.length; j++) {
      const d = Math.abs(recs[j].s - recs[i].s);
      if (d >= 1.2 && d <= 4) ring.push({ s: recs[j].s, o: recs[j].off });
    }
    if (ring.length < 6) continue;
    // 最小二乘直线拟合环带偏移
    const n = ring.length;
    const sm = ring.reduce((a, r) => a + r.s, 0) / n;
    const om = ring.reduce((a, r) => a + r.o, 0) / n;
    let num = 0;
    let den = 0;
    for (const r of ring) {
      num += (r.s - sm) * (r.o - om);
      den += (r.s - sm) * (r.s - sm);
    }
    const slope = den > 1e-9 ? num / den : 0;
    const trend = om + slope * (recs[i].s - sm);
    const prominence = trend - recs[i].off; // 比缓坡趋势更凹为正

    const prev = recs[i - 1];
    const next = recs[i + 1];
    const isLocalMin =
      (!prev || recs[i].off <= prev.off + 1e-6) && (!next || recs[i].off < next.off + 1e-6);
    if (!isLocalMin || prominence < opts.minProminence) continue;
    cands.push({
      index: recs[i].index,
      stdPoint: recs[i].q,
      stdS: recs[i].s,
      prominence,
      measuredPoint: recs[i].p,
    });
  }

  cands.sort((a, b) => b.prominence - a.prominence);
  const kept: StdRootCandidate[] = [];
  for (const c of cands) {
    const dup = kept.find((k) => Math.abs(k.index - c.index) < opts.minIndexSep);
    if (!dup) kept.push(c);
  }
  return kept.slice(0, 4);
}
