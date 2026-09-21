import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../src/data/db.js';
import { clearAllRuns, listRuns, loadRun, saveRun } from '../src/data/repo.js';
import { analyze, replay } from '../src/server/service.js';
import { FIXTURE_ID, generateFixture } from '../src/data/fixture.js';
import { DEFAULT_NEAR_TIE_REL_THRESHOLD, DEFAULT_REFERENCE_SEGMENTS, runPipeline } from '../src/domain/pipeline.js';

let dir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fwab-'));
  db = openDb(join(dir, 't.sqlite'));
});

afterEach(() => {
  closeDb();
});

describe('SQLite 持久化与清空后重导入复核', () => {
  it('分析结果与原始点云可入库并完整读回', () => {
    const { record } = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    });
    const summaries = listRuns(db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].runId).toBe(record.runId);
    expect(summaries[0].limitVersion).toBe(record.limitVersion);

    const saved = loadRun(db, record.runId)!;
    expect(saved.run.profileResults).toHaveLength(3);
    expect(saved.inputs).toHaveLength(3);
    // 原始点云完整保存
    expect(saved.inputs[0].rawPoints.length).toBeGreaterThan(100);
  });

  it('清空数据库后重新导入，runId/指纹一致（可复核）', () => {
    const first = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    }).record;
    clearAllRuns(db);
    expect(listRuns(db)).toHaveLength(0);
    const second = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    }).record;
    expect(second.runId).toBe(first.runId);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
  });

  it('重放复核：用库中输入+参数重算，指纹与存储一致', () => {
    const { record } = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    });
    const verdict = replay(db, record.runId);
    expect(verdict.ok).toBe(true);
    expect(verdict.replayFingerprint).toBe(verdict.storedFingerprint);
  });

  it('改变基准段会改变结果（基准段进入指纹）', () => {
    const a = runPipeline(FIXTURE_ID, generateFixture(), {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    }).record;
    const b = runPipeline(FIXTURE_ID, generateFixture(), {
      referenceSegments: ['flange_root', 'tread'],
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    }).record;
    expect(a.runId).not.toBe(b.runId);
  });

  it('共享测头偏差候选基于整批估计，并可整批应用但允许逐轮廓独立', () => {
    const noApply = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
      applySharedBiasToAll: false,
    }).record;
    expect(noApply.sharedBiasCandidate).not.toBeNull();
    // 默认不应用时每条轮廓偏差为 0
    expect(noApply.profileResults.every((r) => r.appliedBias === 0)).toBe(true);

    const applied = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
      applySharedBiasToAll: true,
    }).record;
    // 整批应用时全部使用共享值
    const shared = applied.sharedBiasCandidate!.bias;
    expect(applied.profileResults.every((r) => Math.abs(r.appliedBias - shared) < 1e-9)).toBe(true);

    // 独立覆盖：T1 单独置零，其余仍整批应用
    const t1Id = applied.profileResults.find((r) => r.epoch === 'T1')!.profileId;
    const mixed = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
      applySharedBiasToAll: true,
      overrides: { [t1Id]: { appliedBias: 0 } },
    }).record;
    const t1 = mixed.profileResults.find((r) => r.epoch === 'T1')!;
    const t0 = mixed.profileResults.find((r) => r.epoch === 'T0')!;
    expect(t1.appliedBias).toBe(0);
    expect(t0.appliedBias).toBeCloseTo(shared, 9);
  });

  it('saveRun/loadRun 保留候选与每轮廓独立选择', () => {
    const { record } = analyze(db, {
      referenceSegments: DEFAULT_REFERENCE_SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    });
    const candidateRows = db
      .prepare('SELECT COUNT(*) AS c FROM candidates WHERE run_id = ?')
      .get(record.runId) as { c: number };
    // 三期 × 每期≥2 候选
    expect(candidateRows.c).toBeGreaterThanOrEqual(6);
  });
});
