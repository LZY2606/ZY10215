import { add, buildPolyline, pointAt, rotate, sub, unit } from './geometry';
import { buildStandard } from './standard';
import type { Pt, Polyline, RawProfile, SegmentTag, StandardProfile } from './types';

/**
 * 固定 fixture（由标准廓形确定性派生，无随机数，保证可重放）：
 *
 *  P1 epoch-1 forward   正向采集；刚体扰动 + 批次共享测头偏差 +0.30mm；
 *  P2 epoch-2 reverse   反向采集：点序显式逆序后再施加相同刚体扰动与共享偏差；
 *  P3 epoch-3 truncated 被截短：截去轮缘内侧 face 下部与踏面尾端，
 *     叠加法向磨耗使 tread 段超 critical，并含一段污点；
 *     截短后 root+踏面的组合在踏面切向上存在平移简并，
 *     产生两个近似同分的对齐候选。
 */

export interface FixtureBundle {
  standard: StandardProfile;
  profiles: RawProfile[];
  expected: {
    sharedProbeBias: number;
    truncatedProfileId: string;
    reverseProfileId: string;
    /** P3 两个候选的来源：沿踏面切向的滑动起点 */
    p3TieTangentialOffsetsMm: [number, number];
  };
}

const WHEEL = '1A-L';
const SHARED_BIAS = 0.3;

export function buildFixtures(version = 'STD-WP-1.0'): FixtureBundle {
  const standard = buildStandard(version);
  const poly = standard.poly;

  const t1 = { theta: 0.06, tx: 3.2, ty: -1.7 };
  const t2 = { theta: -0.045, tx: -2.1, ty: 2.4 };
  const t3 = { theta: 0.02, tx: 1.1, ty: 0.8 };

  // P1 磨耗集中在踏面；轮缘侧（face/tip/root）保持标称，作为 root 锦标锚点。
  const p1Worn = deform(standard, (s, segTag) => {
    if (segTag !== 'tread') return 0;
    let w = 0;
    w += gaussian(s, xToS(standard, 72), 12, 2.2);
    return w;
  });

  const p2Worn = deform(standard, (s, segTag) => {
    if (segTag !== 'tread') return 0;
    let w = 0;
    w += gaussian(s, xToS(standard, 75), 14, 3.2); // 超过踏面 warning 3.0
    w += gaussian(s, xToS(standard, 92), 6, 1.4);
    return w;
  });

  const sFaceMid = midS(standard, 'flange-face');
  const sKeep0 = sFaceMid + 6;
  const sKeep1 = standard.poly.totalLength - 18;
  const treadSeg = standard.segments.find((z) => z.tag === 'tread')!;
  const rootSegP3 = standard.segments.find((z) => z.tag === 'flange-root')!;
  const rootMidP3 = (rootSegP3.s0 + rootSegP3.s1) / 2;
  const p3Worn = deform(standard, (s, segTag) => {
    let w = 0;
    if (segTag === 'tread') {
      w += gaussian(s, xToS(standard, 70), 10, 5.6);
      w += gaussian(s, xToS(standard, 85), 12, 2.0);
    }
    if (segTag === 'flange-root') {
      // root 弧中部的对称双浅凹（真实表面微缺陷，不是可排除的污点）：
      // 切向平移约 1mm 时两个浅凹相对标准弧的错配几乎相同，
      // 在 root 锦标评分下形成两个可追溯的近似同分对齐候选。
                              w += gaussian(s, rootMidP3 - 0.5, 0.4, 0.07);
      w += gaussian(s, rootMidP3 + 0.5, 0.4, 0.07);
    }
    return w;
  });
  void treadSeg;

  const pts1 = capture(p1Worn, t1, { reverse: false, bias: SHARED_BIAS });
  const pts2 = capture(p2Worn, t2, { reverse: true, bias: SHARED_BIAS });
  const stainCenter = (sKeep0 + sKeep1) / 2;
  const pts3 = capture(p3Worn, t3, {
    reverse: false,
    sRange: [sKeep0, sKeep1],
    bias: SHARED_BIAS,
    stain: { s0: stainCenter - 1.2, s1: stainCenter + 1.2, amp: 0.9 },
  });

  const profiles: RawProfile[] = [
    {
      id: `${WHEEL}#1`,
      wheelPosition: WHEEL,
      epoch: '2026-08-01',
      seq: 1,
      declaredDirection: 'forward',
      points: pts1,
      note: '正向采集，踏面局部磨耗',
    },
    {
      id: `${WHEEL}#2`,
      wheelPosition: WHEEL,
      epoch: '2026-09-01',
      seq: 2,
      declaredDirection: 'reverse',
      points: pts2,
      note: '反向采集（语义翻转），磨耗发展',
    },
    {
      id: `${WHEEL}#3`,
      wheelPosition: WHEEL,
      epoch: '2026-09-20',
      seq: 3,
      declaredDirection: 'forward',
      points: pts3,
      note: '被截短采集（face/tread 末端缺失），踏面超限，含污点，配准双候选近似同分',
    },
  ];

  return {
    standard,
    profiles,
    expected: {
      sharedProbeBias: SHARED_BIAS,
      truncatedProfileId: `${WHEEL}#3`,
      reverseProfileId: `${WHEEL}#2`,
      p3TieTangentialOffsetsMm: [-3, 3],
    },
  };
}

/* ---------------- 辅助 ---------------- */

function deform(
  std: StandardProfile,
  wearFn: (s: number, segTag: SegmentTag) => number,
): Pt[] {
  const poly = std.poly;
  return poly.pts.map((p, i) => {
    const s = poly.cumS[i];
    const n = outwardNormal(poly, s);
    const w = wearFn(s, segmentTagOf(std, s));
    // 磨去厚度 w：测量表面相对标准表面向材料内偏移，即 p_new = p_std - w*n_out
    return add(p, { x: -n.x * w, y: -n.y * w });
  });
}

function segmentTagOf(std: StandardProfile, s: number): SegmentTag {
  for (const seg of std.segments) {
    if (s >= seg.s0 - 1e-9 && s <= seg.s1 + 1e-9) return seg.tag;
  }
  return 'outside-cut';
}

function capture(
  wornPts: Pt[],
  t: { theta: number; tx: number; ty: number },
  opts: {
    reverse: boolean;
    sRange?: [number, number];
    bias: number;
    stain?: { s0: number; s1: number; amp: number };
  },
): Pt[] {
  const wp = buildPolyline(wornPts);
  let pts = wp.pts.map((p, i) => {
    const s = wp.cumS[i];
    // 测头共享偏差：读数沿外侧法向偏内 bias（与磨去材料同号），即 -bias*n_out
    let q = add(p, scaled(outwardNormal(wp, s), -opts.bias));
    if (opts.stain && s >= opts.stain.s0 && s <= opts.stain.s1) {
      const f = (s - opts.stain.s0) / (opts.stain.s1 - opts.stain.s0);
      q = add(q, scaled(outwardNormal(wp, s), -opts.stain.amp * Math.sin(Math.PI * f)));
    }
    return q;
  });

  if (opts.sRange) {
    const [a, b] = opts.sRange;
    pts = pts.filter((_, i) => wp.cumS[i] >= a - 1e-9 && wp.cumS[i] <= b + 1e-9);
  }

  // 反向采集：显式语义翻转（整条逆序），绝不按坐标排序
  if (opts.reverse) pts = pts.slice().reverse();

  // 采集刚体扰动（每次采集原点/旋转不同）
  return pts.map((p) => add(rotate(p, t.theta), { x: t.tx, y: t.ty }));
}

function outwardNormal(poly: Polyline, s: number): Pt {
  const e = 0.5;
  const a = pointAt(poly, Math.max(0, s - e));
  const b = pointAt(poly, Math.min(poly.totalLength, s + e));
  const t = unit(sub(b, a));
  return { x: t.y, y: -t.x };
}

function scaled(v: Pt, k: number): Pt {
  return { x: v.x * k, y: v.y * k };
}

function gaussian(s: number, c: number, sigma: number, amp: number): number {
  const d = (s - c) / sigma;
  return amp * Math.exp(-0.5 * d * d);
}

function xToS(std: StandardProfile, x: number): number {
  const seg = std.segments.find((s) => s.tag === 'tread')!;
  let best = seg.s0;
  let bestD = Infinity;
  for (let i = 0; i < std.poly.pts.length; i++) {
    const s = std.poly.cumS[i];
    if (s < seg.s0 || s > seg.s1) continue;
    const d = Math.abs(std.poly.pts[i].x - x);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

function midS(std: StandardProfile, tag: SegmentTag): number {
  const seg = std.segments.find((s) => s.tag === tag)!;
  return (seg.s0 + seg.s1) / 2;
}
