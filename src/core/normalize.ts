import {
  add,
  buildPolyline,
  centroid,
  dist,
  optimalRotation,
  reversePolyline,
  rotate,
  sub,
  type ClosestResult,
} from './geometry';
import { closestOnPolyline } from './geometry';
import type {
  NormalizedProfile,
  Polyline,
  Pt,
  RawProfile,
  RigidXform,
  SegmentRange,
  SegmentTag,
  StandardProfile,
} from './types';

export interface CircleFit {
  c: Pt;
  r: number;
  /** 该组点在圆上的角度（质心角） */
  midAngle: number;
  /** 角度跨度 */
  sweep: number;
  rmse: number;
}

/** 代数最小二乘圆拟合（Kasa 法），返回圆心、半径与 RMSE。 */
export function fitCircle(pts: Pt[]): CircleFit | null {
  const n = pts.length;
  if (n < 5) return null;
  let sx = 0;
  let sy = 0;
  let sx2 = 0;
  let sy2 = 0;
  let sxy = 0;
  let sx3 = 0;
  let sy3 = 0;
  let sx2y = 0;
  let sxy2 = 0;
  for (const p of pts) {
    const x = p.x;
    const y = p.y;
    const x2 = x * x;
    const y2 = y * y;
    sx += x;
    sy += y;
    sx2 += x2;
    sy2 += y2;
    sxy += x * y;
    sx3 += x2 * x;
    sy3 += y2 * y;
    sx2y += x2 * y;
    sxy2 += x * y2;
  }
  const M = [
    [sx2, sxy, sx],
    [sxy, sy2, sy],
    [sx, sy, n],
  ];
  const rhs = [
    -(sx3 + sxy2),
    -(sx2y + sy3),
    -(sx2 + sy2),
  ];
  const a = solve3(M, rhs);
  if (!a) return null;
  const cx = -a[0] / 2;
  const cy = -a[1] / 2;
  const r2 = (a[0] * a[0] + a[1] * a[1]) / 4 - a[2];
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let se = 0;
  const angles: number[] = [];
  for (const p of pts) {
    const d = Math.abs(dist(p, { x: cx, y: cy }) - r);
    se += d * d;
    angles.push(Math.atan2(p.y - cy, p.x - cx));
  }
  // 角度跨度（unwrap 后）
  const sorted = angles.slice().sort((u, v) => u - v);
  let maxGap = 0;
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  const wrapGap = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1];
  maxGap = Math.max(maxGap, wrapGap);
  const sweep = 2 * Math.PI - maxGap;
  let meanSin = 0;
  let meanCos = 0;
  for (const ang of angles) {
    meanSin += Math.sin(ang);
    meanCos += Math.cos(ang);
  }
  return {
    c: { x: cx, y: cy },
    r,
    midAngle: Math.atan2(meanSin / n, meanCos / n),
    sweep,
    rmse: Math.sqrt(se / n),
  };
}

function solve3(M: number[][], b: number[]): [number, number, number] | null {
  const A = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < 4; k++) A[r][k] -= f * A[col][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

/**
 * 鲁棒加权圆拟合（IRLS + Kasa）：
 * 每轮按点到当前圆的径向残差施加 Huber 权重，局部浅凹/毛刺点被降权，
 * 用于在含轻微表面缺陷的 root 弧上恢复无偏的圆心、半径与中角。
 */
/**
 * 鲁棒加权圆拟合（IRLS + Kasa）。
 * cutoffMm：残差（mm）超过该值的点权重置零（Tukey 硬截断），
 * 其余点用 Huber 降权；用于在含浅凹/毛刺的 root 弧上恢复无偏圆。
 */
export function robustFitCircle(pts: Pt[], cutoffMm = 0.08, iterations = 12): CircleFit | null {
  let cur = fitCircle(pts);
  if (!cur) return null;
  for (let it = 0; it < iterations; it++) {
    const resid = pts.map((p) => Math.hypot(p.x - cur!.c.x, p.y - cur!.c.y) - cur!.r);
    const sorted = resid.map((d) => Math.abs(d)).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1] ?? 0;
    const scale = Math.max(0.005, 1.4826 * med);
    const w = resid.map((d) => {
      const ad = Math.abs(d);
      if (ad > cutoffMm) return 0; // 浅凹/毛刺：硬截断
      const z = ad / scale;
      return z <= 1.345 ? 1 : 1.345 / Math.max(z, 1e-9);
    });
    if (w.reduce((a, b) => a + b, 0) < pts.length * 0.5) break; // 内点过少则放弃
    const next = weightedFitCircle(pts, w);
    if (!next) break;
    if (
      Math.abs(next.c.x - cur.c.x) < 1e-6 &&
      Math.abs(next.c.y - cur.c.y) < 1e-6 &&
      Math.abs(next.r - cur.r) < 1e-6
    ) {
      cur = next;
      break;
    }
    cur = next;
  }
  return cur;
}

function weightedFitCircle(pts: Pt[], weights: number[]): CircleFit | null {
  let sx = 0;
  let sy = 0;
  let sx2 = 0;
  let sy2 = 0;
  let sxy = 0;
  let sx3 = 0;
  let sy3 = 0;
  let sx2y = 0;
  let sxy2 = 0;
  let W = 0;
  for (let k = 0; k < pts.length; k++) {
    const wi = weights[k];
    const { x, y } = pts[k];
    const x2 = x * x;
    const y2 = y * y;
    W += wi;
    sx += wi * x;
    sy += wi * y;
    sx2 += wi * x2;
    sy2 += wi * y2;
    sxy += wi * x * y;
    sx3 += wi * x2 * x;
    sy3 += wi * y2 * y;
    sx2y += wi * x2 * y;
    sxy2 += wi * x * y2;
  }
  const M = [
    [sx2, sxy, sx],
    [sxy, sy2, sy],
    [sx, sy, W],
  ];
  const rhs = [-(sx3 + sxy2), -(sx2y + sy3), -(sx2 + sy2)];
  const a = solve3(M, rhs);
  if (!a) return null;
  const cx = -a[0] / 2;
  const cy = -a[1] / 2;
  const r2 = (a[0] * a[0] + a[1] * a[1]) / 4 - a[2];
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let se = 0;
  const angles: number[] = [];
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    se += d * d;
    angles.push(Math.atan2(p.y - cy, p.x - cx));
  }
  const sortedA = angles.slice().sort((u, v) => u - v);
  let maxGap = 0;
  for (let i = 1; i < sortedA.length; i++) maxGap = Math.max(maxGap, sortedA[i] - sortedA[i - 1]);
  maxGap = Math.max(maxGap, sortedA[0] + 2 * Math.PI - sortedA[sortedA.length - 1]);
  const sweep = 2 * Math.PI - maxGap;
  let meanSin = 0;
  let meanCos = 0;
  for (const ang of angles) {
    meanSin += Math.sin(ang);
    meanCos += Math.cos(ang);
  }
  return {
    c: { x: cx, y: cy },
    r,
    midAngle: Math.atan2(meanSin / pts.length, meanCos / pts.length),
    sweep,
    rmse: Math.sqrt(se / pts.length),
  };
}

/** 离散曲率（切向转角/弧长），长度与 pts 相同，端点置 0。 */
export function curvatureProfile(poly: Polyline): number[] {
  const { pts, cumS } = poly;
  const k = new Array(pts.length).fill(0);
  for (let i = 1; i < pts.length - 1; i++) {
    const t0 = unitS(sub(pts[i], pts[i - 1]));
    const t1 = unitS(sub(pts[i + 1], pts[i]));
    const cross = t0.x * t1.y - t0.y * t1.x;
    const dot = t0.x * t1.x + t0.y * t1.y;
    const ds = (cumS[i + 1] - cumS[i - 1]) / 2 || 1e-6;
    k[i] = Math.atan2(cross, dot) / ds;
  }
  return k;
}

function unitS(v: Pt): Pt {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: v.x / l, y: v.y / l };
}

/**
 * 在弧长序列上寻找与目标半径最接近的圆弧窗口。
 * root 圆弧 R≈14 的曲率约 1/14；tip R≈6 曲率约 1/6。
 */
export function findArcByRadius(
  poly: Polyline,
  targetR: number,
  tol = 4.0,
): { fit: CircleFit; idx0: number; idx1: number } | null {
  const k = curvatureProfile(poly);
  const targetK = 1 / targetR;
  const mask = k.map((ki) => (ki === 0 ? false : Math.abs(1 / Math.abs(ki) - targetR) < tol));
  // 找曲率半径匹配的候选索引
  const candIdx: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) candIdx.push(i);
  if (candIdx.length < 8) return null;

  // 精确策略：枚举所有固定窗口，按拟合圆半径与目标的接近程度选种子；
  // 再仅用严格半径容差（0.08mm）内的连续索引点重拟合一次，
  // 避免相邻 tip 圆角/踏面直线混入导致中角偏移。
  // 枚举 45 点窗口：只把“半径对且 RMSE 极低（真正落在圆弧上）”的窗口作种子，
  // 种子分 = RMSE 优先，其次窗口中点的曲率一致性；取全局最优种子。
  const WIN = 45;
  let seed: { i0: number; fit: CircleFit } | null = null;
  for (let i = 0; i + WIN <= poly.pts.length; i++) {
    const fit = fitCircle(poly.pts.slice(i, i + WIN));
    if (!fit) continue;
    if (Math.abs(fit.r - targetR) > 0.8) continue;
    if (fit.rmse > 0.02) continue; // 混有直线/异半径弧时 RMSE 迅速增大
    if (!seed || fit.rmse < seed.fit.rmse) seed = { i0: i, fit };
  }
  if (!seed) {
    // 退化为更宽容差的最长候选块
    const block = longestContiguous(candIdx, 3);
    if (block.length < 20) return null;
    const fit = fitCircle(block.map((i) => poly.pts[i]));
    if (!fit || Math.abs(fit.r - targetR) > tol) return null;
    return { fit, idx0: block[0], idx1: block[block.length - 1] + 1 };
  }

  // 切点处相邻异半径弧点到 root 圆心的径向偏差极小（<0.01mm），
  // 半径过滤/弦长差均无法分界。可靠特征是“半径角增量”：
  // 同一圆弧上相邻均匀采样点相对圆心的角增量恒定（=Δs/r），
  // 越过切点进入异半径弧/直线时角增量立刻成比例跳变。
  const c = seed.fit.c;
  const angAt = (i: number) => Math.atan2(poly.pts[i].y - c.y, poly.pts[i].x - c.x);
  const incAt = (i: number) => {
    let d = angAt(i) - angAt(i - 1);
    if (d < -Math.PI) d += 2 * Math.PI;
    if (d > Math.PI) d -= 2 * Math.PI;
    return d;
  };
  // 种子窗口内角增量的中位数（纯 root 弧）
  const seedIncs: number[] = [];
  for (let i = seed.i0 + 1; i < seed.i0 + WIN; i++) seedIncs.push(Math.abs(incAt(i)));
  seedIncs.sort((a, b) => a - b);
  const dMed = seedIncs[seedIncs.length >> 1];

  // 要求增量方向一致（同弧角单调）且量级与中位数偏差 < 15%
  const signs: number[] = [];
  for (let i = seed.i0 + 1; i < seed.i0 + WIN; i++) signs.push(Math.sign(incAt(i)));
  const sign = signs.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
  const belongs = (i: number) => {
    const d = incAt(i);
    if (Math.sign(d) !== sign) return false;
    return Math.abs(Math.abs(d) - dMed) < 0.15 * dMed;
  };

  let i0 = seed.i0;
  let i1 = seed.i0 + WIN;
  while (i0 > 0 && belongs(i0)) i0--;
  while (i1 < poly.pts.length && belongs(i1)) i1++;

  const block: number[] = [];
  for (let i = i0; i < i1; i++) block.push(i);
  if (block.length < 40) return null;
  const fit = fitCircle(block.map((i) => poly.pts[i]));
  if (!fit || Math.abs(fit.r - targetR) > tol) return null;
  return { fit, idx0: i0, idx1: i1 };
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function longestContiguous(idx: number[], maxGap: number): number[] {
  let best: number[] = [];
  let cur = [idx[0]];
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] - idx[i - 1] <= maxGap + 1) cur.push(idx[i]);
    else {
      if (cur.length > best.length) best = cur;
      cur = [idx[i]];
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

/**
 * 规范化单条测量轮廓。
 *
 * 关键规则（验收点）：
 *  1. 点序按“实际弧长”重建，绝不按 x/y 坐标排序；
 *  2. 输入转向相反时，对整条点序做显式语义翻转（reversePolyline），
 *     并在结果 flipped=true 留痕；
 *  3. 判向依据是旋转/平移不变的曲率签名（root R14 圆弧所在弧长侧），
 *     而非导入顺序或坐标大小；
 *  4. 标准廓形之外的截断段只做缺口标记（missingStartS/missingEndS），
 *     不以端点平移/外推填充。
 */
export function normalizeProfile(raw: RawProfile, std: StandardProfile): NormalizedProfile {
  let poly = buildPolyline(raw.points);

  // ---- 方向判定：root 圆弧（R14）应位于弧长 ~ 65% 处（tip 与 tread 之间） ----
  // 分别在正序与逆序上寻找 root，比较曲率-半径匹配质量；
  // 同时要求 root 相对弧长中点位于 tip 侧之后（canonical: face,tip | root,tread）。
  const rev = reversePolyline(poly);
  const fwd = findArcByRadius(poly, STD_ROOT_R, 4.5);
  const back = findArcByRadius(rev, STD_ROOT_R, 4.5);

  const scoreArc = (
    found: { fit: CircleFit; idx0: number; idx1: number } | null,
    p: Polyline,
  ): number => {
    if (!found) return -Infinity;
    const midS = (p.cumS[found.idx0] + p.cumS[found.idx1 - 1]) / 2;
    const pos = midS / p.totalLength; // canonical 中 root 中心约在 0.38（face25/tip8 之后）
    const posPenalty = Math.abs(pos - 0.38);
    return -found.fit.rmse * 4 - posPenalty;
  };

  const fwdScore = scoreArc(fwd, poly);
  const revScore = scoreArc(back, rev);
  const geometricReverse = revScore > fwdScore;

  // declared 方向仅作为佐证；几何判据优先，但记录冲突。
  const declaredReverse = raw.declaredDirection === 'reverse';
  let flipped = geometricReverse;
  if (raw.declaredDirection !== 'unknown' && declaredReverse !== geometricReverse) {
    // 几何与申报冲突：以几何签名为准（曲率签名旋转不变且稳定）
    flipped = geometricReverse;
  }

  let orientationScore = 1 - Math.min(1, Math.abs(fwdScore - revScore) / 2);
  orientationScore = 0.5 + Math.min(0.5, Math.abs(fwdScore - revScore) / 4);

  if (flipped) poly = rev;

  // ---- 粗注册（rough transform）到标准坐标系，用于截断检测与分段 ----
  const xform = roughRegister(poly, std);

  // ---- 截断检测：变换后端点投影到标准廓形弧长 ----
  const p0 = applyT(poly.pts[0], xform);
  const p1 = applyT(poly.pts[poly.pts.length - 1], xform);
  const c0 = closestOnPolyline(p0, std.poly);
  const c1 = closestOnPolyline(p1, std.poly);
  const sMin = Math.min(c0.s, c1.s);
  const sMax = Math.max(c0.s, c1.s);
  const missingStartS = Math.max(0, sMin);
  const missingEndS = Math.max(0, std.poly.totalLength - sMax);

  // 测量廓形自身弧长上的语义分段：1mm 分箱多数表决，再做短段平滑
  const binSize = 1;
  const nb = Math.max(1, Math.ceil(poly.totalLength / binSize));
  const votes = new Array(nb).fill(0).map(() => new Map<string, number>());
  for (let i = 0; i < poly.pts.length; i++) {
    const cp = closestOnPolyline(applyT(poly.pts[i], xform), std.poly);
    const tag = tagAt(std, cp.s);
    const b = Math.min(nb - 1, Math.floor(poly.cumS[i] / binSize));
    votes[b].set(tag, (votes[b].get(tag) ?? 0) + 1);
  }
  const binTag = votes.map((m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] as SegmentTag);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < nb - 1; i++) {
      if (binTag[i - 1] === binTag[i + 1] && binTag[i] !== binTag[i - 1]) binTag[i] = binTag[i - 1];
    }
  }
  const segments: SegmentRange[] = [];
  let curTag = binTag[0];
  let segS0 = 0;
  for (let b = 1; b <= nb; b++) {
    const tag = b < nb ? binTag[b] : ('__end__' as unknown as SegmentTag);
    if (tag !== curTag) {
      const s1 = Math.min(poly.totalLength, b * binSize);
      segments.push({ tag: curTag, s0: segS0, s1 });
      curTag = tag as SegmentTag;
      segS0 = b * binSize;
    }
  }

  return {
    raw,
    poly,
    flipped,
    orientationScore,
    segments: mergeSegments(segments),
    missingStartS,
    missingEndS,
  };
}

function mergeSegments(segs: SegmentRange[]): SegmentRange[] {
  const out: SegmentRange[] = [];
  for (const seg of segs) {
    if (seg.s1 - seg.s0 < 1e-6) continue;
    const last = out[out.length - 1];
    if (last && last.tag === seg.tag) last.s1 = seg.s1;
    else out.push({ ...seg });
  }
  return out;
}

const STD_ROOT_R = 14;

function tagAt(std: StandardProfile, s: number) {
  for (const seg of std.segments) {
    if (s >= seg.s0 - 1e-9 && s <= seg.s1 + 1e-9) return seg.tag;
  }
  return 'outside-cut' as const;
}

export function applyT(p: Pt, t: RigidXform): Pt {
  return add(rotate(p, t.theta), { x: t.tx, y: t.ty });
}

/**
 * 粗注册：以 root R14 圆弧为锚。
 * 测量 root 圆心 -> 标准 root 圆心（平移），
 * 圆弧中点半径角 -> 标准 root 圆弧中点角（旋转）。
 * 截短廓形只要包含 root 即可注册；不含 root 时退化为质心+零旋转。
 */
export function roughRegister(poly: Polyline, std: StandardProfile): RigidXform {
  const found = findArcByRadius(poly, STD_ROOT_R, 4.5);
  if (!found) {
    const mc = centroid(poly.pts);
    const sc = centroid(std.poly.pts);
    return { theta: 0, tx: sc.x - mc.x, ty: sc.y - mc.y };
  }
  const stdRoot = stdRootCircle(std);
  const theta = stdRoot.midAngle - found.fit.midAngle;
  const movedC = rotate(found.fit.c, theta);
  return {
    theta,
    tx: stdRoot.c.x - movedC.x,
    ty: stdRoot.c.y - movedC.y,
  };
}

export function stdRootCircle(std: StandardProfile): CircleFit {
  const rootSeg = std.segments.find((s) => s.tag === 'flange-root')!;
  const pts = std.poly.pts.filter(
    (_, i) =>
      std.poly.cumS[i] >= rootSeg.s0 - 1e-6 && std.poly.cumS[i] <= rootSeg.s1 + 1e-6,
  );
  const fit = fitCircle(pts)!;
  return fit;
}


/**
 * 固定标称半径 R 的鲁棒圆心估计（确定性 b 扫描 + 解析圆心）。
 *
 * 已知 root 锦标半径 R；共享测头偏差 b 使未磨耗点半径集中在 R+b。
 * 对候选 b：
 *   内点 = {i : ||p_i-c|-R-b| < tol}（圆心 c 需一并确定）
 * 圆心由内点迭代解析更新 c = mean(p - (R+b)·unit(p-c))。
 * 在 b∈[-1,1] 上以 0.01 步长扫描，选内点加权残差 SSE 最小者，
 * 再在其附近 0.001 细化。root 浅凹/毛刺是固定半径残差离群点，被自然排除。
 */
export function fitFixedRCircle(
  pts: Pt[],
  targetR: number,
): { c: Pt; bias: number; inlierFrac: number } | null {
  if (pts.length < 8) return null;
  const init = fitCircle(pts);
  if (!init) return null;

  const TOL = 0.04;
  const solveFromSeed = (bias: number, c0: Pt) => {
    let c = { ...c0 };
    let sse = Infinity;
    let inlierIdx: number[] = [];
    for (let iter = 0; iter < 100; iter++) {
      const idx: number[] = [];
      const res: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const e = Math.hypot(pts[i].x - c.x, pts[i].y - c.y) - targetR - bias;
        if (Math.abs(e) <= TOL) {
          idx.push(i);
          res.push(e);
        }
      }
      if (idx.length < 8) return null;
      let nx = 0;
      let ny = 0;
      for (const i of idx) {
        let rx = pts[i].x - c.x;
        let ry = pts[i].y - c.y;
        const l = Math.hypot(rx, ry) || 1;
        nx += pts[i].x - (targetR + bias) * (rx / l);
        ny += pts[i].y - (targetR + bias) * (ry / l);
      }
      const nc = { x: nx / idx.length, y: ny / idx.length };
      let ss = 0;
      for (const e of res) ss += e * e;
      sse = ss;
      inlierIdx = idx;
      if (Math.hypot(nc.x - c.x, nc.y - c.y) < 1e-8) {
        c = nc;
        break;
      }
      c = nc;
    }
    return { c, sse, frac: inlierIdx.length / pts.length };
  };

  const seeds: Pt[] = [init.c];
  for (const d of [-0.6, -0.3, 0.3, 0.6]) {
    seeds.push({ x: init.c.x + d, y: init.c.y });
    seeds.push({ x: init.c.x, y: init.c.y + d });
    seeds.push({ x: init.c.x + d * 0.7, y: init.c.y + d * 0.7 });
  }
  const solveForBias = (bias: number) => {
    let bestR: { c: Pt; sse: number; frac: number } | null = null;
    for (const c0 of seeds) {
      const r = solveFromSeed(bias, c0);
      if (r && (!bestR || r.frac > bestR.frac || (r.frac === bestR.frac && r.sse < bestR.sse))) {
        bestR = r;
      }
    }
    return bestR;
  };

  type Best = { c: Pt; bias: number; inlierFrac: number; sse: number };
  const box: { best: Best | null } = { best: null };
  const consider = (bias: number): void => {
    const r = solveForBias(bias);
    if (!r) return;
    const key = -r.frac * 1e6 + r.sse;
    const candidate: Best = { c: r.c, bias, inlierFrac: r.frac, sse: key };
    if (box.best === null || key < box.best.sse) box.best = candidate;
  };
  for (let b = -1; b <= 1.0001; b += 0.01) consider(b);
  if (box.best) {
    const center = box.best.bias;
    for (let b = center - 0.01; b <= center + 0.0101; b += 0.001) consider(b);
  }
  return box.best ? { c: box.best.c, bias: box.best.bias, inlierFrac: box.best.inlierFrac } : null;
}
