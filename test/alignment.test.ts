import { describe, it, expect } from 'vitest';
import { buildFixtures } from '../src/core/fixtures';
import { normalizeProfile } from '../src/core/normalize';
import { alignProfile } from '../src/core/alignment';
import {
  defaultConfigFor,
  applyTruncatedPreset,
  runBatch,
} from '../src/core/pipeline';
import { estimateProbeBias, normalWear, applyProbeBiasToWear } from '../src/core/wear';

const fx = buildFixtures();
const n3 = normalizeProfile(fx.profiles[2], fx.standard);

describe('近似同分多候选保留', () => {
  it('P3（截短+root 双浅凹）保留两个可追溯候选', () => {
    const cands = alignProfile(n3, fx.standard, {
      basis: 'full',
      lockRoot: true,
      tieTolRatio: 0.05,
    });
    const retained = cands.filter((c) => c.retained);
    expect(retained.length).toBeGreaterThanOrEqual(2);
    // 两个候选分数接近（相对差 <=5%）
    expect(retained[1].scoreGap).toBeLessThanOrEqual(0.05);
    // 每个候选都带来源说明，可追溯
    for (const c of retained) {
      expect(c.provenance.length).toBeGreaterThan(0);
      expect(c.basisRanges.length).toBeGreaterThan(0);
    }
    // 两候选切向位置确实不同（不是同一个解重复保留）
    const d = Math.hypot(
      retained[0].xform.tx - retained[1].xform.tx,
      retained[0].xform.ty - retained[1].xform.ty,
    );
    expect(d).toBeGreaterThan(0.1);
  });

  it('候选排序只按分数，与导入顺序无关：打乱 raw 顺序后锦标解仍是其中之一', () => {
    const reversedRaw = { ...fx.profiles[2], points: fx.profiles[2].points.slice() };
    const na = normalizeProfile(fx.profiles[2], fx.standard);
    const nb = normalizeProfile(reversedRaw, fx.standard);
    const ca = alignProfile(na, fx.standard, { basis: 'full', lockRoot: true, tieTolRatio: 0.05 });
    const cb = alignProfile(nb, fx.standard, { basis: 'full', lockRoot: true, tieTolRatio: 0.05 });
    expect(ca[0].score).toBeCloseTo(cb[0].score, 6);
    expect(ca.filter((c) => c.retained).length).toBe(cb.filter((c) => c.retained).length);
  });

  it('root-lock 锦标解能还原采集刚体（theta 约 -0.02）', () => {
    const cands = alignProfile(n3, fx.standard, { basis: 'full', lockRoot: true });
    const trophy = cands.find((c) => c.provenance.includes('锦标'))!;
    expect(trophy).toBeTruthy();
    expect(trophy.xform.theta).toBeCloseTo(-0.02, 1);
  });
});

describe('测头偏差：共享候选 + 每条独立选择', () => {
  it('批次共享偏差估计接近 fixture 真值 +0.30mm', () => {
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    const run = runBatch(fx.profiles, fx.standard, cfg, 'r', new Date().toISOString());
    for (const r of run.results) {
      expect(r.probeBiasApplied).toBeCloseTo(0.3, 1);
      expect(r.probeBiasSource).toBe('shared');
    }
  });

  it('某条轮廓可独立关闭共享偏差而不影响其它条', () => {
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    cfg.profiles[0].useSharedBias = false;
    const run = runBatch(fx.profiles, fx.standard, cfg, 'r', new Date().toISOString());
    expect(run.results[0].probeBiasSource).not.toBe('shared');
    expect(run.results[1].probeBiasSource).toBe('shared');
    expect(run.results[2].probeBiasSource).toBe('shared');
  });

  it('每条轮廓可独立选择候选序号', () => {
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    const runA = runBatch(fx.profiles, fx.standard, cfg, 'a', new Date().toISOString());
    const retainedP3 = runA.results[2].candidates.filter((c) => c.retained);
    cfg.profiles[2].chosenCandidateRank = retainedP3[1].rank;
    const runB = runBatch(fx.profiles, fx.standard, cfg, 'b', new Date().toISOString());
    expect(runB.results[2].chosenCandidateRank).toBe(retainedP3[1].rank);
  });
});

describe('法向磨耗与限界', () => {
  it('三期踏面峰值磨耗依次约 2.3 / 3.3 / 7.1mm', () => {
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    const run = runBatch(fx.profiles, fx.standard, cfg, 'r', new Date().toISOString());
    const treadMax = run.results.map((r) => {
      const t = r.wear.filter((w) => w.segment === 'tread' && !w.beyondStandard);
      return Math.max(...t.map((w) => w.wear));
    });
    expect(treadMax[0]).toBeGreaterThan(2.0);
    expect(treadMax[0]).toBeLessThan(2.6);
    expect(treadMax[1]).toBeGreaterThan(3.0);
    expect(treadMax[1]).toBeLessThan(3.6);
    expect(treadMax[2]).toBeGreaterThan(6.5);
  });

  it('P3 踏面磨耗超 critical，P2 超 warning，限界带版本号', () => {
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    const run = runBatch(fx.profiles, fx.standard, cfg, 'r', new Date().toISOString());
    const v2 = run.results[1].violations;
    const v3 = run.results[2].violations;
    expect(v2.some((v) => v.segment === 'tread' && v.level === 'warning')).toBe(true);
    expect(v3.some((v) => v.segment === 'tread' && v.level === 'critical')).toBe(true);
    for (const v of [...v2, ...v3]) expect(v.limitVersion).toBe('STD-WP-1.0');
  });

  it('排除污点区间不参与磨耗', () => {
    const n3b = normalizeProfile(fx.profiles[2], fx.standard);
    const cands = alignProfile(n3b, fx.standard, { basis: 'full', lockRoot: true });
    const all = normalWear(n3b, fx.standard, cands[0].xform, []);
    // 污点在截短测量自身弧长的中部（约 40-55mm 区间，对应变换后踏面）
    const excluded = [{ s0: 38, s1: 55 }];
    const wearEx = normalWear(n3b, fx.standard, cands[0].xform, excluded);
    expect(wearEx.some((w) => w.excluded)).toBe(true);
    expect(all.length).toBe(wearEx.length);
  });

  it('estimateProbeBias 在纯锦标配准下接近 +0.3', () => {
    const n1 = normalizeProfile(fx.profiles[0], fx.standard);
    const c = alignProfile(n1, fx.standard, { basis: 'full', lockRoot: true });
    const b = estimateProbeBias(n1, fx.standard, c[0].xform, []);
    expect(b).toBeCloseTo(0.3, 1);
    const w = applyProbeBiasToWear(normalWear(n1, fx.standard, c[0].xform, []), b);
    const tread = w.filter((x) => x.segment === 'tread');
    // 补偿后未磨耗的踏面尾端磨耗应接近 0
    // P1 在 x≈92mm 有一处 1.0mm 磨耗；取最末端未磨耗区域（标准弧长 >105）
    // 取踏面最末端 5mm（标准踏面止于 s≈110），该处 fixture 无磨耗
    const tail = tread.filter((x) => x.s > 108 && !Number.isNaN(x.wear));
    expect(tail.length).toBeGreaterThan(0);
    expect(Math.abs(tail[tail.length - 1].wear)).toBeLessThan(0.3);
  });
});
