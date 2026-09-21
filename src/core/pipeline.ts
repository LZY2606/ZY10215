import { createHash } from 'node:crypto';
import { alignProfile } from './alignment';
import { normalizeProfile } from './normalize';
import {
  applyProbeBiasToWear,
  estimateProbeBias,
  limitIntersections,
  normalWear,
  residualSeries,
} from './wear';
import { rms } from './geometry';
import type {
  AlignOptions,
  AlignmentResult,
  NormalizedProfile,
  RawProfile,
  StandardProfile,
} from './types';

export interface BatchProfileConfig {
  profileId: string;
  /** 每条轮廓独立选择：是否应用批次共享测头偏差；false 时用独立估计 */
  useSharedBias: boolean;
  /** 独立选择的候选序号（1-based）；null 表示取最优 */
  chosenCandidateRank: number | null;
  /** 独立选择的污点排除弧长区间（测量廓形规范化后自身弧长） */
  excludedIntervals: Array<{ s0: number; s1: number }>;
  /** 本条覆盖基准段 */
  basisOverride?: AlignOptions['basis'];
  /** 本条覆盖 root-lock */
  lockRootOverride?: boolean;
}

export interface BatchConfig {
  wheelPosition: string;
  options: AlignOptions;
  /** 共享测头偏差（mm）：null 表示尚未估计/不设置 */
  sharedProbeBias: number | null;
  profiles: BatchProfileConfig[];
}

export interface BatchRun {
  runId: string;
  createdAt: string;
  stdVersion: string;
  config: BatchConfig;
  normalized: Array<NormalizedProfile>;
  results: AlignmentResult[];
  fingerprint: string;
}

/**
 * 全批次分析：
 *  1. 规范化（弧长重建 + 语义翻转 + 截断标记）；
 *  2. 多候选对齐（近似同分保留）；
 *  3. 先估测头偏差：取各轮廓基准残差中位数的批次中位数作为“共享候选”；
 *  4. 每条轮廓独立决定使用共享偏差还是自身独立偏差；
 *  5. 法向磨耗、限界交集、指纹（限界版本入指纹）。
 */
export function runBatch(
  raws: RawProfile[],
  std: StandardProfile,
  config: BatchConfig,
  runId: string,
  createdAt: string,
): BatchRun {
  const normalized = raws.map((r) => normalizeProfile(r, std));

  // 第一轮对齐（无偏差修正）以估计偏差
  const firstPass = normalized.map((np) => {
    const cfg = config.profiles.find((p) => p.profileId === np.raw.id);
    const opts = perOptions(config, cfg);
    const candidates = alignProfile(np, std, opts);
    return { np, candidates, opts, cfg };
  });

  const independentBiases = firstPass.map(({ np, candidates, opts }) => {
    const best = candidates[0];
    return estimateProbeBias(np, std, best.xform, opts.excludedIntervals);
  });
  const sortedBias = independentBiases.slice().sort((a, b) => a - b);
  const mid = sortedBias.length >> 1;
  const estimatedShared = sortedBias.length
    ? sortedBias.length % 2
      ? sortedBias[mid]
      : (sortedBias[mid - 1] + sortedBias[mid]) / 2
    : 0;
  const sharedBias = config.sharedProbeBias ?? estimatedShared;

  const results: AlignmentResult[] = firstPass.map(({ np, candidates }, idx) => {
    const cfg = config.profiles.find((p) => p.profileId === np.raw.id)!;
    const opts = perOptions(config, cfg);
    const chosenRank = cfg.chosenCandidateRank ?? candidates[0].rank;
    const chosen = candidates.find((c) => c.rank === chosenRank) ?? candidates[0];

    // 共享偏差候选：用户显式设定则用设定值，否则用批次估计候选；
    // useSharedBias=false 的轮廓保留独立估计（每条轮廓独立选择）。
    const useShared = cfg.useSharedBias;
    const ownBias = independentBiases[idx];
    const bias = useShared ? sharedBias : ownBias;
    const biasSource: AlignmentResult['probeBiasSource'] = useShared
      ? 'shared'
      : Math.abs(ownBias) > 1e-9
        ? 'independent'
        : 'none';

    let wear = normalWear(np, std, chosen.xform, opts.excludedIntervals);
    wear = applyProbeBiasToWear(wear, bias);
    const residuals = residualSeries(wear);
    const violations = limitIntersections(wear, std);

    return {
      profileId: np.raw.id,
      chosenCandidateRank: chosen.rank,
      candidates,
      wear,
      violations,
      residuals,
      rms: rms(residuals.map((r) => r.d)),
      probeBiasApplied: bias,
      probeBiasSource: biasSource,
    };
  });

  const fingerprint = computeFingerprint({
    std,
    config,
    sharedBias,
    normalized,
    results,
  });

  return {
    runId,
    createdAt,
    stdVersion: std.version,
    config,
    normalized,
    results,
    fingerprint,
  };
}

function perOptions(config: BatchConfig, cfg?: BatchProfileConfig): AlignOptions {
  return {
    basis: cfg?.basisOverride ?? config.options.basis,
    lockRoot: cfg?.lockRootOverride ?? config.options.lockRoot,
    excludedIntervals: cfg?.excludedIntervals ?? config.options.excludedIntervals,
    tieTolRatio: config.options.tieTolRatio,
  };
}

/**
 * 结果指纹：限界版本（std.version）、基准、root-lock、排除区间、
 * 共享偏差来源、每条轮廓的翻转标记/截断缺口/选定候选/变换参数/残差 RMS
 * 全部参与 SHA-256。任何口径改变都会改变指纹。
 */
export function computeFingerprint(args: {
  std: StandardProfile;
  config: BatchConfig;
  sharedBias: number;
  normalized: NormalizedProfile[];
  results: AlignmentResult[];
}): string {
  const { std, config, sharedBias, normalized, results } = args;
  const h = createHash('sha256');
  h.update('flange-bench|v1\n');
  h.update(`stdVersion=${std.version}\n`);
  h.update(
    `limits=${JSON.stringify(
      std.segments.map((seg) => {
        const lim = std.limits.find((l) => l.tag === seg.tag);
        return { tag: seg.tag, warning: lim?.warning, critical: lim?.critical };
      }),
    )}\n`,
  );
  h.update(
    `basis=${config.options.basis}|lockRoot=${config.options.lockRoot}|tie=${config.options.tieTolRatio}|sharedBias=${round(sharedBias)}\n`,
  );
  for (const np of normalized) {
    h.update(
      `prof=${np.raw.id}|flip=${np.flipped}|miss=${round(np.missingStartS)},${round(np.missingEndS)}|pts=${np.poly.pts.length}|len=${round(np.poly.totalLength)}\n`,
    );
  }
  for (const r of results) {
    const cfg = config.profiles.find((p) => p.profileId === r.profileId);
    const chosen = r.candidates.find((c) => c.rank === r.chosenCandidateRank)!;
    h.update(
      `res=${r.profileId}|rank=${r.chosenCandidateRank}|ncand=${r.candidates.length}|retained=${r.candidates
        .filter((c) => c.retained)
        .map((c) => c.rank)
        .join('.')}|theta=${round(chosen.xform.theta)}|t=${round(chosen.xform.tx)},${round(chosen.xform.ty)}|bias=${round(r.probeBiasApplied)}(${r.probeBiasSource})|rms=${round(r.rms)}|excl=${JSON.stringify(cfg?.excludedIntervals ?? [])}|viol=${r.violations
        .map((v) => `${v.segment}:${v.level}:${round(v.maxWear)}@${v.limitVersion}`)
        .join(',')}\n`,
    );
  }
  return h.digest('hex');
}

function round(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  return x.toFixed(6);
}

export function defaultConfigFor(raws: RawProfile[], wheelPosition: string): BatchConfig {
  return {
    wheelPosition,
    options: {
      basis: 'full',
      // 默认 root 锦标锁定：圆心+中角定刚体，磨耗点不参与配准；
      // 全段作为磨耗/限界分析基准。用户可逐条改基准与非锁定。
      lockRoot: true,
      excludedIntervals: [],
      tieTolRatio: 0.05,
    },
    sharedProbeBias: null,
    profiles: raws.map((r) => ({
      profileId: r.id,
      useSharedBias: true,
      chosenCandidateRank: null,
      excludedIntervals: [],
    })),
  };
}

/**
 * 截短轮廓推荐口径：全段基准 + 轮缘根部锦标锁定（root 圆心固定旋转、
 * 只沿 root 切向 1 维滑动）。截短后 root 锦标 + 踏面纹波在切向上形成
 * 两个可解释的近似同分对齐极小。
 */
export function applyTruncatedPreset(config: BatchConfig, truncatedIds: string[]): BatchConfig {
  for (const id of truncatedIds) {
    const p = config.profiles.find((x) => x.profileId === id);
    if (p) {
      p.basisOverride = 'full';
      p.lockRootOverride = true;
    }
  }
  return config;
}
