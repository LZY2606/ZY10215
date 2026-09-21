import { applyXform, closestOnPolyline, dot, normalAt, sub, unit } from './geometry';
import { segmentAtS } from './standard';
import type {
  AlignCandidate,
  LimitViolation,
  NormalWearSample,
  NormalizedProfile,
  RigidXform,
  StandardProfile,
} from './types';

/**
 * 法向磨耗厚度。
 *
 * 约定：n 为标准表面指向材料外侧（空气）的单位法向；
 * 测量点相对标准点向内偏移（材料被磨去）时 (p-q)·n < 0，
 * 故 wear = -(p-q)·n，>0 表示材料被磨去。
 *
 * 截断保护：当测量点最近点落在标准折线端点时标记 beyondStandard=true，
 * 该样本不参与磨耗与限界统计——禁止用端点平移/外推填满截断段。
 */
export function normalWear(
  np: NormalizedProfile,
  std: StandardProfile,
  xform: RigidXform,
  excludedIntervals: Array<{ s0: number; s1: number }>,
): NormalWearSample[] {
  const out: NormalWearSample[] = [];
  for (let i = 0; i < np.poly.pts.length; i++) {
    const sMeas = np.poly.cumS[i];
    const excluded = excludedIntervals.some((e) => sMeas >= e.s0 - 1e-9 && sMeas <= e.s1 + 1e-9);
    const p = applyXform(np.poly.pts[i], xform);
    const cp = closestOnPolyline(p, std.poly);
    const n = normalAt(std.poly, cp.s);
    const sStd = cp.s;
    const wear = cp.atEndpoint ? NaN : -dot(sub(p, cp.q), n);
    out.push({
      s: sStd,
      p,
      q: cp.q,
      n,
      wear,
      segment: segmentAtS(std, sStd),
      excluded,
      beyondStandard: cp.atEndpoint,
    });
  }
  return out;
}

/**
 * 标准限界交集：沿标准弧长将非排除、非截断外推区的磨耗样本聚类成连续超限段。
 * 限界版本随结果进入指纹。
 */
export function limitIntersections(
  wear: NormalWearSample[],
  std: StandardProfile,
): LimitViolation[] {
  const considered = wear
    .filter((w) => !w.excluded && !w.beyondStandard && !Number.isNaN(w.wear))
    .sort((a, b) => a.s - b.s);
  const violations: LimitViolation[] = [];
  let run: Array<{ s: number; wear: number; level: 'warning' | 'critical'; segment: import('./types').SegmentTag }> = [];

  const flush = () => {
    if (!run.length) return;
    // critical 段覆盖时按 critical 报，否则 warning
    const hasCritical = run.some((r) => r.level === 'critical');
    const level = hasCritical ? 'critical' : 'warning';
    const maxItem = run.reduce((a, b) => (b.wear > a.wear ? b : a));
    violations.push({
      segment: maxItem.segment,
      s0: run[0].s,
      s1: run[run.length - 1].s,
      maxWear: maxItem.wear,
      level,
      limitVersion: std.version,
    });
    run = [];
  };

  for (const w of considered) {
    const lim = std.limits.find((l) => l.tag === w.segment);
    if (!lim) {
      flush();
      continue;
    }
    const level: 'warning' | 'critical' | null =
      w.wear >= lim.critical ? 'critical' : w.wear >= lim.warning ? 'warning' : null;
    if (!level) {
      flush();
      continue;
    }
    const last = run[run.length - 1];
    if (last && w.s - last.s > 2.0) flush(); // 弧长间隔 >2mm 视为另一段
    run.push({ s: w.s, wear: w.wear, level, segment: w.segment });
  }
  flush();
  return violations;
}

/**
 * 测头偏差估计：基准段上（测量→标准）有符号法向残差的稳健中位数。
 * 正值表示测头读数整体偏向外（需减去 bias 才能贴合）。
 * 截断外推点与污点不参与估计。
 */
export function estimateProbeBias(
  np: NormalizedProfile,
  std: StandardProfile,
  xform: RigidXform,
  excludedIntervals: Array<{ s0: number; s1: number }>,
): number {
  const w = normalWear(np, std, xform, excludedIntervals);
  const vals = w
    .filter((v) => !v.excluded && !v.beyondStandard && !Number.isNaN(v.wear))
    .map((v) => v.wear)
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** 将测头偏差沿测量点处法向（变换后）施加：p' = p - bias * n。 */
export function applyProbeBiasToWear(samples: NormalWearSample[], bias: number): NormalWearSample[] {
  return samples.map((sm) => {
    if (sm.beyondStandard || Number.isNaN(sm.wear)) return sm;
    const n = unit(sm.n);
    return {
      ...sm,
      p: { x: sm.p.x - bias * n.x, y: sm.p.y - bias * n.y },
      wear: sm.wear - bias,
    };
  });
}

export interface ResidualPoint {
  s: number;
  d: number;
}

export function residualSeries(
  wear: NormalWearSample[],
): ResidualPoint[] {
  return wear
    .filter((w) => !w.excluded && !w.beyondStandard && !Number.isNaN(w.wear))
    .map((w) => ({ s: w.s, d: w.wear }))
    .sort((a, b) => a.s - b.s);
}

export function pickCandidate(
  candidates: AlignCandidate[],
  rank: number,
): AlignCandidate {
  return candidates.find((c) => c.rank === rank) ?? candidates[0];
}
