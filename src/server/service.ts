import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../data/db.js';
import { clearAllRuns, deleteRun, listRuns, loadRun, saveRun } from '../data/repo.js';
import { FIXTURE_ID, generateFixture } from '../data/fixture.js';
import {
  DEFAULT_NEAR_TIE_REL_THRESHOLD,
  DEFAULT_REFERENCE_SEGMENTS,
  runPipeline,
  type PipelineOptions,
} from '../domain/pipeline.js';
import { buildStandardProfile } from '../domain/standard.js';
import { stableHash } from '../domain/geometry.js';
import type { RunRecord, SegmentTag } from '../domain/types.js';

export interface AnalyzeRequest {
  referenceSegments?: SegmentTag[];
  lockRoot?: boolean;
  excludeOutliers?: boolean;
  nearTieRelThreshold?: number;
  applySharedBiasToAll?: boolean;
  overrides?: PipelineOptions['overrides'];
}

export function analyze(
  db: DB,
  req: AnalyzeRequest,
): { record: RunRecord; reused: boolean } {
  const inputs = generateFixture();
  const options: PipelineOptions = {
    referenceSegments: req.referenceSegments?.length
      ? req.referenceSegments
      : DEFAULT_REFERENCE_SEGMENTS,
    lockRoot: req.lockRoot ?? true,
    excludeOutliers: req.excludeOutliers ?? true,
    nearTieRelThreshold: req.nearTieRelThreshold ?? DEFAULT_NEAR_TIE_REL_THRESHOLD,
    applySharedBiasToAll: req.applySharedBiasToAll ?? false,
    overrides: req.overrides ?? {},
  };
  const { record } = runPipeline(FIXTURE_ID, inputs, options);
  // 幂等：相同参数+相同输入指纹则复用既有 runId，但仍记录本次运行时间。
  const existing = listRuns(db).find(
    (r) =>
      r.inputFingerprint === record.inputFingerprint &&
      r.standardVersion === record.standardVersion &&
      r.limitVersion === record.limitVersion,
  );
  record.createdAt = new Date().toISOString();
  saveRun(db, record, inputs);
  return { record, reused: !!existing };
}

/** 重放：从数据库读取原始输入与参数，重新计算并核对指纹是否一致。 */
export function replay(db: DB, runId: string): {
  ok: boolean;
  reason?: string;
  storedFingerprint?: string;
  replayFingerprint?: string;
} {
  const saved = loadRun(db, runId);
  if (!saved) return { ok: false, reason: 'run-not-found' };
  const { run, inputs } = saved;
  const { record } = runPipeline(FIXTURE_ID, inputs, {
    referenceSegments: run.referenceSegments,
    lockRoot: run.lockRoot,
    excludeOutliers: run.excludeOutliers,
    nearTieRelThreshold: run.nearTieRelThreshold,
    applySharedBiasToAll: false,
    overrides: Object.fromEntries(
      run.profileResults.map((r) => [
        r.profileId,
        { candidateId: r.selectedCandidateId, appliedBias: r.appliedBias },
      ]),
    ),
  });
  const storedFp = run.runId;
  const replayFp = record.runId;
  return {
    ok: storedFp === replayFp,
    storedFingerprint: storedFp,
    replayFingerprint: replayFp,
    reason:
      storedFp === replayFp
        ? undefined
        : '重放指纹不一致：参数/输入/限界版本发生变化',
  };
}

export function getRun(db: DB, runId: string) {
  return loadRun(db, runId);
}

export function runs(db: DB) {
  return listRuns(db);
}

export function clearDb(db: DB) {
  clearAllRuns(db);
}

export function removeRun(db: DB, runId: string) {
  deleteRun(db, runId);
}

/** 导出运行记录为 JSON 文件（含标准/限界版本、指纹、全部结果），返回文件路径。 */
export function exportRun(db: DB, runId: string, exportDir = 'exports'): string {
  const saved = loadRun(db, runId);
  if (!saved) throw new Error('run-not-found');
  mkdirSync(exportDir, { recursive: true });
  const payload = {
    exportedAt: new Date().toISOString(),
    run: saved.run,
    inputs: saved.inputs.map((i) => ({
      id: i.id,
      wheelPosition: i.wheelPosition,
      epoch: i.epoch,
      declaredOrientation: i.declaredOrientation,
      pointCount: i.rawPoints.length,
      rawPoints: i.rawPoints,
    })),
  };
  const file = join(exportDir, `run-${runId}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/** 标准廓形（供前端画布绘制底图与区段色带）。 */
export function standardProfilePayload() {
  const std = buildStandardProfile();
  return {
    version: std.version,
    limitVersion: std.limit.limitVersion,
    s: std.s,
    points: std.points,
    tags: std.tags,
    normal: std.normal,
    rootChampionship: std.rootChampionship,
    segmentRanges: std.segmentRanges,
    thresholds: std.limit.thresholds,
  };
}

export function configFingerprint(partial: Partial<AnalyzeRequest>): string {
  return stableHash(partial);
}
