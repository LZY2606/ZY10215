import type {
  ExceedanceRegion,
  Point,
  RigidTransform,
  SegmentTag,
  StandardProfile,
  WearSample,
} from './types.js';
import { applyTransform } from './geometry.js';
import { projectToStandard } from './projection.js';

export interface WearOptions {
  appliedBias: number;
  excludeOutliers: boolean;
  maxPairDistance: number;
  /** mm 级绝对跳点阈值；缓变磨耗（连续、平滑）不会被判为污点。 */
  outlierJumpMm: number;
  /** 参与磨耗的基准段；投影落在这些段之外一律不产生磨耗。 */
  allowedSegments?: SegmentTag[];
  /** 是否要求垂足严格在边内部（拒绝任何端点/段边界钳制）。默认 true。 */
  requireInterior?: boolean;
}

export interface WearOutput {
  samples: WearSample[];
  exceedances: ExceedanceRegion[];
  excludedCount: number;
  residualRms: number;
  residualMax: number;
  residualMean: number;
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const a = v.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 在标准廓形每个弧长采样处计算法向磨耗。
 * - 只有存在“内部投影”的测量点才给出磨耗；标准廓形弧长之外的截短段保持 null，
 *   绝不用端点平移/钳制填满。
 * - 污点排除基于“相对局部平滑廓形的孤立大幅跳点”，缓变磨耗不被误判。
 * - 磨耗厚度 = 有符号法向距离 − 选定测头偏差（材料损失方向为正）。
 */
export function computeWear(
  measuredCanonical: Point[],
  transform: RigidTransform,
  std: StandardProfile,
  opts: WearOptions,
): WearOutput {
  const transformed = measuredCanonical.map((p) => applyTransform(p, transform));

  interface Hit {
    qi: number;
    s: number;
    signed: number;
    distance: number;
    beyond: boolean;
    present: boolean;
  }
  const allowed = opts.allowedSegments ? new Set<SegmentTag>(opts.allowedSegments) : undefined;
  const requireInterior = opts.requireInterior ?? true;
  const hits: Hit[] = transformed.map((q, qi) => {
    const h = projectToStandard(q, std, allowed, opts.maxPairDistance);
    if (!h) return { qi, s: NaN, signed: NaN, distance: NaN, beyond: false, present: false };
    // 拒绝：整段折线外端点钳制、段边界钳制（非内部垂足）。
    const boundaryClamp = h.beyondExtent || (requireInterior && !h.interior);
    return { qi, s: h.s, signed: h.signedNormal, distance: h.distance, beyond: boundaryClamp, present: true };
  });
  const validHits = hits.filter((h) => h.present && !h.beyond);

  // 污点：沿弧长排序后，偏移相对“紧邻点中位数”出现孤立大幅跳点。
  const byS = validHits.slice().sort((a, b) => a.s - b.s);
  const outlierIdx = new Set<number>();
  if (opts.excludeOutliers) {
    for (let i = 0; i < byS.length; i++) {
      const neighbors: number[] = [];
      for (let k = 1; k <= 4; k++) {
        if (byS[i - k] && Math.abs(byS[i - k].s - byS[i].s) < 6) neighbors.push(byS[i - k].signed);
        if (byS[i + k] && Math.abs(byS[i + k].s - byS[i].s) < 6) neighbors.push(byS[i + k].signed);
      }
      if (neighbors.length < 3) continue;
      const local = median(neighbors);
      if (Math.abs(byS[i].signed - local) > opts.outlierJumpMm) outlierIdx.add(byS[i].qi);
    }
  }

  const stdSpacing = std.s[1] - std.s[0];
  // 测量采样更粗（~0.9mm），匹配邻域放宽到约一个测量间距，避免标准采样点落空。
  const matchWindow = Math.max(stdSpacing, 1.0);

  const samples: WearSample[] = [];
  const validSigned: number[] = [];
  const validWear: number[] = [];

  for (let i = 0; i < std.points.length; i++) {
    const s = std.s[i];
    let best: Hit | null = null;
    let bestD = Infinity;
    for (const h of validHits) {
      if (outlierIdx.has(h.qi)) continue;
      if (Math.abs(h.s - s) > matchWindow) continue;
      if (h.distance < bestD) {
        bestD = h.distance;
        best = h;
      }
    }
    const threshold = std.limit.thresholds[std.tags[i]];
    if (best) {
      const signedDistance = best.signed;
      // 法向指向材料外侧；材料损失使点内移，signedNormal 为负，故磨耗厚度取 -signed。
      // 测头沿 outward 的正偏置使点外移，扣除 appliedBias（>0 外偏）。
      const wear = -signedDistance - opts.appliedBias;
      const exceedsLimit = wear > threshold;
      validSigned.push(signedDistance);
      validWear.push(wear);
      samples.push({
        s,
        standardPoint: std.points[i],
        normal: std.normal[i],
        tag: std.tags[i],
        signedDistance,
        wear,
        valid: true,
        exceedsLimit,
        threshold,
      });
    } else {
      samples.push({
        s,
        standardPoint: std.points[i],
        normal: std.normal[i],
        tag: std.tags[i],
        signedDistance: null,
        wear: null,
        valid: false,
        exceedsLimit: false,
        threshold,
      });
    }
  }

  // 连续超限区段（标准限界交集）。
  const exceedances: ExceedanceRegion[] = [];
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart < 0) return;
    const region = samples.slice(runStart, end + 1);
    const wears = region.map((r) => r.wear as number);
    const maxWear = Math.max(...wears);
    const meanWear = wears.reduce((a, b) => a + b, 0) / wears.length;
    const tag = region[0].tag;
    const s0 = region[0].s;
    const s1 = region[region.length - 1].s;
    const threshold = region[0].threshold;
    exceedances.push({
      tag,
      s0,
      s1,
      arcLength: s1 - s0,
      maxWear,
      meanWear,
      limitVersion: std.limit.limitVersion,
      explanation: `${segmentLabel(tag)}在弧长 ${s0.toFixed(1)}~${s1.toFixed(
        1,
      )}mm 段法向磨耗峰值 ${maxWear.toFixed(2)}mm，超过限界 ${threshold.toFixed(
        1,
      )}mm（限界版本 ${std.limit.limitVersion}）。`,
    });
    runStart = -1;
  };
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].exceedsLimit) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i - 1);
    }
  }
  flush(samples.length - 1);

  const rms = validWear.length
    ? Math.sqrt(validWear.reduce((a, b) => a + b * b, 0) / validWear.length)
    : 0;
  const residualMax = validSigned.length ? Math.max(...validSigned.map(Math.abs)) : 0;
  return {
    samples,
    exceedances,
    excludedCount: outlierIdx.size,
    residualRms: rms,
    residualMax,
    residualMean: validSigned.length ? median(validSigned) : 0,
  };
}

function segmentLabel(tag: string): string {
  const map: Record<string, string> = {
    rim_inner: '轮缘内侧面',
    flange_face: '轮缘喉面',
    flange_root: '轮缘根部',
    tread: '踏面',
    outer_chamfer: '外端倒角',
  };
  return map[tag] ?? tag;
}
