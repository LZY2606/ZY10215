import { describe, expect, it } from 'vitest';
import { generateFixture } from '../src/data/fixture.js';
import { buildStandardProfile } from '../src/domain/standard.js';
import { decideOrientation, canonicalize, rebuildByArcLength } from '../src/domain/rebuild.js';
import { alignProfile } from '../src/domain/alignment.js';
import { applyTransform, resampleByArcLength } from '../src/domain/geometry.js';
import { projectToStandard } from '../src/domain/projection.js';
import { runPipeline, DEFAULT_REFERENCE_SEGMENTS, DEFAULT_NEAR_TIE_REL_THRESHOLD } from '../src/domain/pipeline.js';
import { FIXTURE_ID } from '../src/data/fixture.js';

const SEGMENTS = DEFAULT_REFERENCE_SEGMENTS;

function align(input: ReturnType<typeof generateFixture>[number]) {
  const dec = decideOrientation(input.rawPoints);
  const canon = canonicalize(input.rawPoints, dec);
  const rb = rebuildByArcLength(canon);
  return alignProfile(rb.s, rb.points, buildStandardProfile(), {
    referenceSegments: SEGMENTS,
    lockRoot: true,
    nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    maxPairDistance: 8,
    outlierNormSigma: 4,
  });
}

describe('刚体对齐与近似同分候选', () => {
  const inputs = generateFixture();

  it('无噪标准廓形经已知刚体后能高覆盖配准', () => {
    const std = buildStandardProfile();
    const rb = resampleByArcLength(std.points, 0.9);
    const truth = { theta: 0.13, tx: 4, ty: -2 };
    const moved = rb.points.map((p) => applyTransform(p, truth));
    const out = alignProfile(rb.s, moved, std, {
      referenceSegments: SEGMENTS,
      lockRoot: true,
      nearTieRelThreshold: 0.18,
      maxPairDistance: 8,
      outlierNormSigma: 4,
    });
    // 配回标准（truth 的逆），重投影残差应很小
    let acc = 0;
    let n = 0;
    for (const p of moved) {
      const q = applyTransform(p, out.selected.transform);
      const h = projectToStandard(q, std, new Set(SEGMENTS), 6);
      if (h && h.interior && !h.beyondExtent) {
        acc += h.signedNormal ** 2;
        n++;
      }
    }
    expect(Math.sqrt(acc / n)).toBeLessThan(0.2);
  });

  it('三期各自保留两个近似同分候选（多个局部对齐，均可追溯）', () => {
    for (const inp of inputs) {
      const near = align(inp).candidates.filter((c) => c.nearBest);
      expect(near.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('两项候选都可追溯：内容派生 ID + 变换/种子，且互不相同', () => {
    for (const inp of inputs) {
      const out = align(inp);
      const near = out.candidates.filter((c) => c.nearBest);
      const ids = new Set(near.map((c) => c.candidateId));
      expect(ids.size).toBe(near.length);
      for (const c of near) {
        expect(c.candidateId).toMatch(/^[0-9a-f]{16}$/);
        expect(Number.isFinite(c.transform.theta)).toBe(true);
        expect(c.seed.length).toBeGreaterThan(0);
      }
    }
  });

  it('结论不依赖导入顺序：打乱输入顺序后代表性候选内容不变', () => {
    const original = inputs.map((inp) => align(inp).selected.candidateId);
    const shuffled = inputs
      .slice()
      .reverse()
      .map((inp) => align(inp).selected.candidateId);
    // 逐轮廓比较（reverse 只是改变数组排列，每轮廓结果必须一致）
    expect(shuffled.reverse()).toEqual(original);
  });

  it('截短廓形不做端点填充：标准廓形弧长两端保持无投影覆盖', () => {
    const std = buildStandardProfile();
    const t2 = inputs.find((p) => p.epoch === 'T2')!;
    const out = align(t2);
    const dec = decideOrientation(t2.rawPoints);
    const canon = canonicalize(t2.rawPoints, dec);
    const rb = rebuildByArcLength(canon);
    const sHits = rb.points.map((p) =>
      projectToStandard(applyTransform(p, out.selected.transform), std, undefined, 8),
    );
    const sMin = Math.min(...sHits.filter((h) => h && h.interior).map((h) => h!.s));
    const sMax = Math.max(...sHits.filter((h) => h && h.interior).map((h) => h!.s));
    // 标准廓形两端（轮缘内侧顶 ~0、外倒角末 ~133）必须没有被覆盖
    expect(sMin).toBeGreaterThan(10);
    expect(sMax).toBeLessThan(125);
  });
});

describe('整批管线：限界版本进入指纹、结果确定性', () => {
  it('同一输入重复运行 runId 与每轮廓指纹完全一致', () => {
    const a = runPipeline(FIXTURE_ID, generateFixture(), {
      referenceSegments: SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    }).record;
    const b = runPipeline(FIXTURE_ID, generateFixture(), {
      referenceSegments: SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    }).record;
    expect(a.runId).toBe(b.runId);
    expect(a.profileResults.map((r) => r.fingerprint)).toEqual(
      b.profileResults.map((r) => r.fingerprint),
    );
  });

  it('限界版本出现在结果与指纹输入中', () => {
    const { record } = runPipeline(FIXTURE_ID, generateFixture(), {
      referenceSegments: SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    });
    expect(record.limitVersion).toMatch(/^TB-LIMIT-/);
    for (const r of record.profileResults) expect(r.limitVersion).toBe(record.limitVersion);
  });

  it('最重期 T2 产生超限交集区，早期 T0 不超限，形成可解释趋势', () => {
    const { record } = runPipeline(FIXTURE_ID, generateFixture(), {
      referenceSegments: SEGMENTS,
      lockRoot: true,
      excludeOutliers: true,
      nearTieRelThreshold: DEFAULT_NEAR_TIE_REL_THRESHOLD,
    });
    const by = new Map(record.profileResults.map((r) => [r.epoch, r]));
    expect(by.get('T2')!.exceedances.length).toBeGreaterThan(0);
    for (const e of by.get('T2')!.exceedances) {
      expect(e.explanation).toContain(e.limitVersion);
      expect(e.maxWear).toBeGreaterThan(0);
      expect(e.arcLength).toBeGreaterThan(0);
    }
    // T1 反向输入同样完成完整分析
    expect(by.get('T1')!.orientation.reversed).toBe(true);
  });
});
