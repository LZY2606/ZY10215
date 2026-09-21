import { applyXform, closestOnPolyline, normalAt } from './geometry';
import { findArcByRadius, fitCircle, fitFixedRCircle, stdRootCircle, type CircleFit } from './normalize';
import type { Polyline, Pt, RigidXform, StandardProfile } from './types';

const ROOT_R = 14;

export interface RootCompResult {
  rootFit: CircleFit;
  /** root 弧上的整体法向偏置估计（正=读数向内） */
  bias: number;
  /** 弧点索引范围（原始测量折线） */
  idx0: number;
  idx1: number;
}

/**
 * 仅在 root 弧点上估计并去除整体法向偏置，恢复无偏 root 圆（圆心/中角）。
 *
 * 方法：定位弧点窗口 → 拟合圆 → 残差 (d_i - r) 的中位数即整体法向偏置 b；
 * 把弧点沿各自“相对当前圆心的径向单位向量”向内收缩 b 后重新拟合，
 * 迭代到半径等于标称 14。非 root 点绝不移动。
 */
export function estimateRootCircle(poly: Polyline): RootCompResult | null {
  const found = findArcByRadius(poly, ROOT_R, 5.0);
  if (!found) return null;
  const { idx0, idx1 } = found;
  const arc = poly.pts.slice(idx0, idx1).map((p) => ({ x: p.x, y: p.y }));

  const kasa = fitCircle(arc);
  // 圆心与整体半径偏置用“固定标称 R”的确定性鲁棒扫描，对浅凹/毛刺不敏感。
  const fixed = fitFixedRCircle(arc, ROOT_R);

  if (!fixed || !kasa) {
    return kasa ? { rootFit: kasa, bias: ROOT_R - kasa.r, idx0, idx1 } : null;
  }

  // 中角：以固定 R 圆心为准，取内点半径角的 circular mean，
  // 不做可能被双凹拉偏的自由 Kasa 拟合。
  const inlierIdx: Pt[] = arc.filter(
    (p) => Math.abs(Math.hypot(p.x - fixed.c.x, p.y - fixed.c.y) - (ROOT_R + fixed.bias)) < 0.04,
  );
  // root 弧扫角 < π，内点角不卷绕；中点角 = 角度跨度两端平均，
  // 对双凹造成的少量内点缺失不敏感。
  const angles = inlierIdx
    .map((p) => Math.atan2(p.y - fixed.c.y, p.x - fixed.c.x))
    .sort((a, b) => a - b);
  const midAngle =
    angles.length >= 8 ? (angles[0] + angles[angles.length - 1]) / 2 : kasa.midAngle;

  const rootFit: CircleFit = {
    c: fixed.c,
    r: ROOT_R,
    midAngle,
    sweep: kasa.sweep,
    rmse: kasa.rmse,
  };
  // 约定：bias 正=读数向内（半径变小）；fixed.bias 为半径增量，取负。
  return { rootFit, bias: -fixed.bias, idx0, idx1 };
}

/** root 锦标配准：圆心定平移、中角定旋转。 */
export function rootTrophyXform(root: CircleFit, std: StandardProfile): RigidXform {
  const sr = stdRootCircle(std);
  const theta = sr.midAngle - root.midAngle;
  const moved = {
    x: root.c.x * Math.cos(theta) - root.c.y * Math.sin(theta),
    y: root.c.x * Math.sin(theta) + root.c.y * Math.cos(theta),
  };
  return { theta, tx: sr.c.x - moved.x, ty: sr.c.y - moved.y };
}

/** 在给定刚体变换下，用贴合层点估计法向偏差中位数（正=向内）。 */
export function normalBiasAt(
  poly: Polyline,
  std: StandardProfile,
  xform: RigidXform,
  excluded: Array<{ s0: number; s1: number }>,
  gapMm = 0.6,
): number {
  const vals: number[] = [];
  for (let i = 0; i < poly.pts.length; i++) {
    const s = poly.cumS[i];
    if (excluded.some((e) => s >= e.s0 - 1e-9 && s <= e.s1 + 1e-9)) continue;
    const q = applyXform(poly.pts[i], xform);
    const cp = closestOnPolyline(q, std.poly);
    if (cp.atEndpoint || cp.dist > gapMm) continue;
    const n = normalAt(std.poly, cp.s);
    vals.push(-(q.x - cp.q.x) * n.x - (q.y - cp.q.y) * n.y);
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0;
}
