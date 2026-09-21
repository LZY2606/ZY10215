import type {
  AlignmentCandidate,
  ProfileInput,
  ProfileResult,
  ProbeBiasCandidate,
  RunRecord,
  SegmentTag,
} from './types.js';
import { buildStandardProfile } from './standard.js';
import { canonicalize, decideOrientation, rebuildByArcLength } from './rebuild.js';
import { alignProfile } from './alignment.js';
import { computeWear } from './wear.js';
import { median, stableHash } from './geometry.js';
import { fingerprintInputs } from '../data/fixture.js';

export interface PipelineOptions {
  referenceSegments: SegmentTag[];
  lockRoot: boolean;
  excludeOutliers: boolean;
  nearTieRelThreshold: number;
  maxPairDistance?: number;
  outlierNormSigma?: number;
  /** 是否把整批共享测头偏差候选应用到每条轮廓（默认否；每条仍可独立选择）。 */
  applySharedBiasToAll?: boolean;
  /** 单条轮廓对候选/偏差的独立覆盖选择。 */
  overrides?: Record<string, { candidateId?: string; appliedBias?: number; appliedBiasSource?: string }>;
}

export const DEFAULT_NEAR_TIE_REL_THRESHOLD = 0.3;

export const DEFAULT_REFERENCE_SEGMENTS: SegmentTag[] = [
  'rim_inner',
  'flange_face',
  'flange_root',
  'tread',
];

/**
 * 从整批对齐后的“无偏基准段（踏面中段）”法向残差稳健估计共享测头偏差。
 * 测头偏差是跨期共享的系统偏置；用踏面中段（磨耗最小区域）的残差中位数近似。
 */
export function estimateSharedBias(
  inputs: ProfileInput[],
  referenceSegments: SegmentTag[],
  lockRoot: boolean,
  excludeOutliers: boolean,
  nearTieRelThreshold: number,
): ProbeBiasCandidate {
  const std = buildStandardProfile();
  const perProfile: { id: string; value: number }[] = [];
  for (const inp of inputs) {
    const dec = decideOrientation(inp.rawPoints);
    const canon = canonicalize(inp.rawPoints, dec);
    const rb = rebuildByArcLength(canon);
    const aligned = alignProfile(rb.s, rb.points, std, {
      referenceSegments,
      lockRoot,
      nearTieRelThreshold,
      maxPairDistance: 8,
      outlierNormSigma: 4,
    });
    const wear = computeWear(rb.points, aligned.selected.transform, std, {
      appliedBias: 0,
      excludeOutliers,
      maxPairDistance: 8,
      outlierJumpMm: 3.0,
      allowedSegments: ['tread'],
      requireInterior: true,
    });
    // 踏面中段（相对未磨耗）残差中位数作为该期的偏差估计。
    const treadMid = wear.samples
      .filter((smp) => smp.tag === 'tread' && smp.s > 92 && smp.s < 122 && smp.valid)
      .map((smp) => smp.signedDistance as number);
    if (treadMid.length >= 5) perProfile.push({ id: inp.id, value: median(treadMid) });
  }
  const values = perProfile.map((p) => p.value);
  const bias = values.length ? median(values) : 0;
  return {
    candidateId: stableHash({ kind: 'shared-probe-bias', values: values.map((v) => Math.round(v * 1e4)) }),
    bias: Math.round(bias * 1000) / 1000,
    source: '整批踏面中段(s∈90~120mm)法向残差中位数的跨期中位数（稳健估计）',
    basedOn: perProfile.map((p) => p.id),
    note: '可对整批一键应用，但每条轮廓保留独立接受/覆盖/置零的选择。',
  };
}

export interface PipelineRun {
  record: RunRecord;
  std: ReturnType<typeof buildStandardProfile>;
}

/** 运行整批分析，产出可持久化/可重放的 RunRecord。 */
export function runPipeline(
  fixtureId: string,
  inputs: ProfileInput[],
  options: PipelineOptions,
): PipelineRun {
  const std = buildStandardProfile();
  const referenceSegments = options.referenceSegments;
  const lockRoot = options.lockRoot;
  const excludeOutliers = options.excludeOutliers;
  const nearTieRelThreshold = options.nearTieRelThreshold;
  const maxPairDistance = options.maxPairDistance ?? 8;
  const outlierNormSigma = options.outlierNormSigma ?? 4;

  // 整批共享测头偏差候选（始终估计并呈现；是否应用由每条轮廓独立决定）。
  const sharedBias = estimateSharedBias(
    inputs,
    referenceSegments,
    lockRoot,
    excludeOutliers,
    nearTieRelThreshold,
  );

  const profileResults: ProfileResult[] = inputs.map((inp) => {
    const dec = decideOrientation(inp.rawPoints);
    const canon = canonicalize(inp.rawPoints, dec);
    const rb = rebuildByArcLength(canon);

    const aligned = alignProfile(rb.s, rb.points, std, {
      referenceSegments,
      lockRoot,
      nearTieRelThreshold,
      maxPairDistance,
      outlierNormSigma,
    });

    // 该轮廓独立选用的候选（默认代表性候选；可被 override 切换到任一保留候选）。
    const ov = options.overrides?.[inp.id] ?? {};
    const selectedCandidate: AlignmentCandidate =
      aligned.candidates.find((c) => c.candidateId === ov.candidateId) ?? aligned.selected;

    // 该轮廓独立选用的测头偏差（默认 0；可接受整批共享值或自定义）。
    let appliedBias = 0;
    let appliedBiasSource = 'none(独立置零，未应用共享测头偏差)';
    if (options.applySharedBiasToAll && ov.appliedBias === undefined) {
      appliedBias = sharedBias.bias;
      appliedBiasSource = `shared:${sharedBias.candidateId}（整批应用，轮廓可独立覆盖）`;
    }
    if (ov.appliedBias !== undefined) {
      appliedBias = ov.appliedBias;
      appliedBiasSource =
        ov.appliedBiasSource ?? `override(${ov.appliedBias}mm，轮廓独立选择)`;
    }

    const wear = computeWear(rb.points, selectedCandidate.transform, std, {
      appliedBias,
      excludeOutliers,
      maxPairDistance,
      outlierJumpMm: 3.0,
      allowedSegments: undefined,
      requireInterior: true,
    });

    const fingerprint = stableHash({
      standardVersion: std.version,
      limitVersion: std.limit.limitVersion,
      referenceSegments: referenceSegments.slice().sort(),
      lockRoot,
      excludeOutliers,
      nearTieRelThreshold,
      profileId: inp.id,
      selectedCandidate: {
        id: selectedCandidate.candidateId,
        theta: selectedCandidate.transform.theta,
        tx: selectedCandidate.transform.tx,
        ty: selectedCandidate.transform.ty,
      },
      appliedBias: Math.round(appliedBias * 1e6),
      candidateIds: aligned.candidates.map((c) => c.candidateId).sort(),
    });

    return {
      profileId: inp.id,
      wheelPosition: inp.wheelPosition,
      epoch: inp.epoch,
      orientation: dec,
      rebuild: {
        totalLength: rb.totalLength,
        spacing: rb.resampleSpacing,
        pointCount: rb.points.length,
      },
      candidates: aligned.candidates,
      selectedCandidateId: selectedCandidate.candidateId,
      selectedTransform: selectedCandidate.transform,
      alignmentResidual: {
        rms: wear.residualRms,
        max: wear.residualMax,
        mean: wear.residualMean,
      },
      excludeOutliers,
      excludedPointCount: wear.excludedCount,
      appliedBias,
      appliedBiasSource,
      wear: wear.samples,
      exceedances: wear.exceedances,
      limitVersion: std.limit.limitVersion,
      standardVersion: std.version,
      fingerprint,
    };
  });

  const runId = stableHash({
    fixture: fixtureId,
    standardVersion: std.version,
    limitVersion: std.limit.limitVersion,
    referenceSegments,
    lockRoot,
    excludeOutliers,
    nearTieRelThreshold,
    inputs: fingerprintInputs(inputs),
  });

  const record: RunRecord = {
    runId,
    createdAt: new Date(0).toISOString(), // 由持久化层写入真实时间
    fixtureId,
    standardVersion: std.version,
    limitVersion: std.limit.limitVersion,
    referenceSegments,
    lockRoot,
    excludeOutliers,
    nearTieRelThreshold,
    sharedBiasCandidate: sharedBias,
    profileResults,
    inputFingerprint: fingerprintInputs(inputs),
  };

  return { record, std };
}
