import { add, applyXform, closestOnPolyline, rotate, normalAt } from './geometry';
import type { Pt, RigidXform } from './types';
import { findArcByRadius, roughRegister, stdRootCircle } from './normalize';
import { estimateRootCircle, rootTrophyXform } from './bias-compensate';
import type {
  AlignCandidate,
  AlignOptions,
  BasisSegment,
  NormalizedProfile,
  StandardProfile,
} from './types';
import type { SegmentTag } from './types';

const ROOT_R = 14;

export function basisStandardRanges(std: StandardProfile, basis: BasisSegment) {
  switch (basis) {
    case 'tread':
      return std.segments.filter((s) => s.tag === 'tread');
    case 'flange-root-lock':
      return std.segments.filter((s) => s.tag === 'flange-root');
    case 'flange-tip':
      return std.segments.filter((s) => s.tag === 'flange-tip');
    case 'full':
    default:
      return std.segments;
  }
}

/** 配准评分段：unworn-flange 只取 root/tip/face（fixture 与一般工况下磨耗集中在踏面）。 */
function registerRanges(std: StandardProfile, opts: AlignOptions) {
  const scope = opts.registerScope ?? (opts.lockRoot ? 'unworn-flange' : 'basis');
  if (scope === 'unworn-flange') {
    const tags: SegmentTag[] = ['flange-root', 'flange-tip', 'flange-face'];
    return std.segments.filter((z) => tags.includes(z.tag));
  }
  return basisStandardRanges(std, opts.basis);
}

function scoreXform(
  np: NormalizedProfile,
  std: StandardProfile,
  opts: AlignOptions,
  xform: RigidXform,
  fixedBias = 0,
): number {
  const ranges = registerRanges(std, opts);
  // root-lock：使用 root 半径恢复得到的整体法向偏差（固定，与候选无关），
  // 沿标准法向扣除后评分，使刚体分数只反映几何错配；
  // 非锁定：逐候选估计贴合层偏差。
  const bias = opts.lockRoot
    ? fixedBias
    : estimateScopeBias(np, std, opts, xform, ranges);
  let se = 0;
  let n = 0;
  for (let i = 0; i < np.poly.pts.length; i++) {
    const s = np.poly.cumS[i];
    if (opts.excludedIntervals.some((e) => s >= e.s0 - 1e-9 && s <= e.s1 + 1e-9)) continue;
    const q0 = applyXform(np.poly.pts[i], xform);
    const cp = closestOnPolyline(q0, std.poly);
    if (cp.atEndpoint) continue;
    if (!ranges.some((r) => cp.s >= r.s0 - 0.25 && cp.s <= r.s1 + 0.25)) continue;
    const nrm = normalAt(std.poly, cp.s);
    // 测量点向内偏 bias（材料侧），还原到标准应沿外侧法向加回：q = p + bias*n
    const q = { x: q0.x + bias * nrm.x, y: q0.y + bias * nrm.y };
    const d = Math.hypot(q.x - cp.q.x, q.y - cp.q.y);
    se += d ** 2;
    n++;
  }
  return n ? Math.sqrt(se / n) : NaN;
}

/** 在指定评分段上估计贴合层（距离<0.6mm）法向偏差中位数（正=向内）。 */
function estimateScopeBias(
  np: NormalizedProfile,
  std: StandardProfile,
  opts: AlignOptions,
  xform: RigidXform,
  ranges: ReturnType<typeof registerRanges>,
): number {
  const vals: number[] = [];
  for (let i = 0; i < np.poly.pts.length; i++) {
    const s = np.poly.cumS[i];
    if (opts.excludedIntervals.some((e) => s >= e.s0 - 1e-9 && s <= e.s1 + 1e-9)) continue;
    const q = applyXform(np.poly.pts[i], xform);
    const cp = closestOnPolyline(q, std.poly);
    if (cp.atEndpoint || cp.dist > 0.6) continue;
    if (!ranges.some((r) => cp.s >= r.s0 - 0.25 && cp.s <= r.s1 + 0.25)) continue;
    const nrm = normalAt(std.poly, cp.s);
    vals.push(-(q.x - cp.q.x) * nrm.x - (q.y - cp.q.y) * nrm.y);
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0;
}

/**
 * 贴合层 ICP（仅非 root-lock 时使用）：
 * 对应点必须点-曲线距离 <1.2mm（剔除严重磨耗），且每轮先扣法向偏置，
 * 让刚体只由未磨耗的贴合几何决定。
 */
function fitLayerIcp(
  np: NormalizedProfile,
  std: StandardProfile,
  opts: AlignOptions,
  initial: RigidXform,
): RigidXform {
  const ranges = registerRanges(std, opts);
  let xform = { ...initial };

  for (let iter = 0; iter < 40; iter++) {
    interface Corr {
      raw: Pt;
      q: Pt;
      target: Pt;
      n: Pt;
      gap: number;
    }
    const corrs: Corr[] = [];
    for (let i = 0; i < np.poly.pts.length; i++) {
      const s = np.poly.cumS[i];
      if (opts.excludedIntervals.some((e) => s >= e.s0 - 1e-9 && s <= e.s1 + 1e-9)) continue;
      const q = applyXform(np.poly.pts[i], xform);
      const cp = closestOnPolyline(q, std.poly);
      if (cp.atEndpoint) continue;
      if (!ranges.some((r) => cp.s >= r.s0 - 0.25 && cp.s <= r.s1 + 0.25)) continue;
      const n = normalAt(std.poly, cp.s);
      corrs.push({ raw: np.poly.pts[i], q, target: cp.q, n, gap: cp.dist });
    }
    if (corrs.length < 8) break;

    // 贴合层：距离最小的 60% 点
    const sortedGap = corrs.map((c) => c.gap).sort((a, b) => a - b);
    const cutoff = sortedGap[Math.floor(sortedGap.length * 0.6)] ?? 0.4;
    const fit = corrs.filter((c) => c.gap <= Math.max(0.25, Math.min(cutoff, 1.0)));

    // 贴合层法向偏差
    const signed = fit.map((c) => -(c.q.x - c.target.x) * c.n.x - (c.q.y - c.target.y) * c.n.y)
      .sort((a, b) => a - b);
    const bias = signed[signed.length >> 1] ?? 0;

    // 补偿后的当前点
    const aCur = fit.map((c) => ({ x: c.q.x + bias * c.n.x, y: c.q.y + bias * c.n.y }));
    const b = fit.map((c) => c.target);
    const ca = cent(aCur);
    const cb = cent(b);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < aCur.length; i++) {
      const ax = aCur[i].x - ca.x;
      const ay = aCur[i].y - ca.y;
      const bx = b[i].x - cb.x;
      const by = b[i].y - cb.y;
      s1 += ax * by - ay * bx;
      s2 += ax * bx + ay * by;
    }
    const dTheta = Math.atan2(s1, s2);
    const rotCa = rotate(ca, dTheta);
    const dTx = cb.x - rotCa.x;
    const dTy = cb.y - rotCa.y;
    const movedT = rotate({ x: xform.tx, y: xform.ty }, dTheta);
    const next = {
      theta: xform.theta + dTheta,
      tx: movedT.x + dTx,
      ty: movedT.y + dTy,
    };
    if (
      Math.abs(dTheta) < 1e-7 &&
      Math.hypot(dTx, dTy) < 1e-6
    ) {
      xform = next;
      break;
    }
    xform = next;
  }
  return xform;
}

function cent(pts: Pt[]): Pt {
  const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: c.x / pts.length, y: c.y / pts.length };
}

function angDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * 多候选刚体对齐。
 *
 * 关键设计：
 *  - 先在测量折线上用 root 半径迭代补偿共享测头偏差，得到不被偏差污染的 root 圆；
 *  - root-lock：变换严格等于 root 锦标（圆心定平移、中角定旋转），
 *    并沿 root 切向密集枚举滑动，保留两个近似同分的近简并候选，不做磨耗点迭代；
 *  - 非 lock：以锦标变换为中心做贴合层 ICP，θ 网格 ±2°，磨耗点不参与刚体；
 *  - 候选排序只按分数，分数差小于 tieTolRatio 全部 retained，
 *    绝不以导入顺序决定结论。
 */
export function alignProfile(
  np: NormalizedProfile,
  std: StandardProfile,
  options: Partial<AlignOptions> = {},
): AlignCandidate[] {
  const opts: AlignOptions = {
    basis: options.basis ?? 'full',
    lockRoot: options.lockRoot ?? false,
    excludedIntervals: options.excludedIntervals ?? [],
    tieTolRatio: options.tieTolRatio ?? 0.03,
    biasGuess: options.biasGuess ?? 0,
    registerScope: options.registerScope,
  };

  const stdRoot = stdRootCircle(std);

  // root 锦标基准变换（在原始测量折线上拟合，半径补偿只用于定位圆心/中角）
  const rootComp = estimateRootCircle(np.poly);
  const measuredRoot = rootComp?.rootFit ?? findArcByRadius(np.poly, ROOT_R, 5.0)?.fit ?? null;
  const trophy: RigidXform = measuredRoot
    ? rootTrophyXform(measuredRoot, std)
    : roughRegister(np.poly, std);

  const starts: Array<RigidXform & { provenance: string }> = [];
  if (opts.lockRoot) {
    starts.push({ ...trophy, provenance: 'root-lock 锦标（root 圆心+中角）' });
    const tangent = { x: -Math.sin(stdRoot.midAngle), y: Math.cos(stdRoot.midAngle) };
    for (const dt of [-4, -3, -2.5, -2, -1.5, -1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4]) {
      starts.push({
        theta: trophy.theta,
        tx: trophy.tx + tangent.x * dt,
        ty: trophy.ty + tangent.y * dt,
        provenance: `root-lock 切向滑动 dt=${dt}mm`,
      });
    }
  } else {
    for (const dDeg of [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]) {
      const d = (dDeg * Math.PI) / 180;
      starts.push({
        theta: trophy.theta + d,
        tx: trophy.tx,
        ty: trophy.ty,
        provenance: `锦标 θ 网格 ${dDeg >= 0 ? '+' : ''}${dDeg.toFixed(1)}°`,
      });
    }
  }

  // root 半径恢复给出的整体法向偏差（估计 bias 为“收缩量”，与 wear 同号，正=向内）
  const lockBias = rootComp ? rootComp.bias : 0;

  const rawCands = starts.map((st) => {
    const { provenance, ...init } = st;
    const finalX = opts.lockRoot ? { ...init } : fitLayerIcp(np, std, opts, init);
    const score = scoreXform(np, std, opts, finalX, lockBias);
    return { xform: finalX, score, provenance };
  });

  // 去重
  const uniq = rawCands
    .filter((c) => !Number.isNaN(c.score))
    .filter((c, i, arr) =>
      arr.findIndex(
        (o) =>
          Math.abs(angDiff(o.xform.theta, c.xform.theta)) < 0.004 &&
          Math.hypot(o.xform.tx - c.xform.tx, o.xform.ty - c.xform.ty) < 0.2,
      ) === i,
    );
  uniq.sort((a, b) => a.score - b.score);

  const best = uniq[0]?.score ?? NaN;
  const basisRanges = basisStandardRanges(std, opts.basis).map((r) => ({ s0: r.s0, s1: r.s1 }));

  return uniq.map((c, i) => {
    const gap = Number.isNaN(best) ? NaN : (c.score - best) / best;
    return {
      rank: i + 1,
      xform: c.xform,
      score: c.score,
      scoreGap: gap,
      provenance: c.provenance,
      basisRanges,
      retained: Number.isNaN(best) ? i === 0 : gap <= opts.tieTolRatio,
    };
  });
}
