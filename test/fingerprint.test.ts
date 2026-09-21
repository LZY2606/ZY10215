import { describe, it, expect } from 'vitest';
import { buildFixtures } from '../src/core/fixtures';
import { buildStandard } from '../src/core/standard';
import { defaultConfigFor, applyTruncatedPreset, runBatch } from '../src/core/pipeline';

describe('结果指纹', () => {
  it('限界版本进入指纹：不同 std.version 指纹不同', () => {
    const fx = buildFixtures('STD-WP-1.0');
    const std2 = buildStandard('STD-WP-1.1');
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    const r1 = runBatch(fx.profiles, fx.standard, cfg, 'r', 't');
    const r2 = runBatch(fx.profiles, std2, cfg, 'r', 't');
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('同口径重放指纹一致（确定性）', () => {
    const fx = buildFixtures();
    let cfg = defaultConfigFor(fx.profiles, '1A-L');
    cfg = applyTruncatedPreset(cfg, [fx.expected.truncatedProfileId]);
    const a = runBatch(fx.profiles, fx.standard, cfg, 'r', 't').fingerprint;
    const b = runBatch(fx.profiles, fx.standard, cfg, 'r', 't').fingerprint;
    expect(a).toBe(b);
  });

  it('选择不同候选改变指纹', () => {
    const fx = buildFixtures();
    const cfg1 = defaultConfigFor(fx.profiles, '1A-L');
    const cfg2 = applyTruncatedPreset(structuredClone(cfg1), [fx.expected.truncatedProfileId]);
    applyTruncatedPreset(cfg1, [fx.expected.truncatedProfileId]);
    const run1 = runBatch(fx.profiles, fx.standard, cfg1, 'r', 't');
    const retained = run1.results[2].candidates.filter((c) => c.retained);
    cfg2.profiles[2].chosenCandidateRank = retained[1].rank;
    const run2 = runBatch(fx.profiles, fx.standard, cfg2, 'r', 't');
    expect(run1.fingerprint).not.toBe(run2.fingerprint);
  });

  it('排除污点改变指纹', () => {
    const fx = buildFixtures();
    const cfg1 = defaultConfigFor(fx.profiles, '1A-L');
    applyTruncatedPreset(cfg1, [fx.expected.truncatedProfileId]);
    const cfg2 = structuredClone(cfg1);
    applyTruncatedPreset(cfg2, [fx.expected.truncatedProfileId]);
    cfg2.profiles[2].excludedIntervals = [{ s0: 36, s1: 52 }];
    const a = runBatch(fx.profiles, fx.standard, cfg1, 'r', 't').fingerprint;
    const b = runBatch(fx.profiles, fx.standard, cfg2, 'r', 't').fingerprint;
    expect(a).not.toBe(b);
  });
});
