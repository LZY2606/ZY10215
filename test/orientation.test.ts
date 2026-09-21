import { describe, expect, it } from 'vitest';
import { generateFixture } from '../src/data/fixture.js';
import { decideOrientation, canonicalize, rebuildByArcLength } from '../src/domain/rebuild.js';
import type { Point } from '../src/domain/types.js';

/** 坐标排序（错误做法）：仅按 x 排序，不做语义翻转。 */
function coordinateSort(points: Point[]): Point[] {
  return points.slice().sort((a, b) => a.x - b.x);
}

describe('点序方向：语义翻转而非坐标排序', () => {
  const inputs = generateFixture();

  it('正向、反向、截短三期方向判定正确', () => {
    const byEpoch = new Map(inputs.map((p) => [p.epoch, p]));
    expect(decideOrientation(byEpoch.get('T0')!.rawPoints).orientation).toBe('forward');
    expect(decideOrientation(byEpoch.get('T1')!.rawPoints).orientation).toBe('reverse');
    expect(decideOrientation(byEpoch.get('T2')!.rawPoints).orientation).toBe('forward');
  });

  it('反向输入被显式翻转（reverse()），而不是坐标排序', () => {
    const t1 = inputs.find((p) => p.epoch === 'T1')!;
    const decision = decideOrientation(t1.rawPoints);
    expect(decision.reversed).toBe(true);
    const flipped = canonicalize(t1.rawPoints, decision);
    // 显式翻转 == 原数组的精确逆序（元素恒等，顺序逐位相反）
    expect(flipped).toEqual(t1.rawPoints.slice().reverse());
    // 坐标排序绝不可能等于语义翻转（证明不是靠 x 排序）
    expect(coordinateSort(t1.rawPoints)).not.toEqual(flipped);
  });

  it('旋转/平移不改变方向判定', () => {
    const t0 = inputs.find((p) => p.epoch === 'T0')!;
    const c = Math.cos(1.234);
    const s = Math.sin(1.234);
    const moved = t0.rawPoints.map((p) => ({
      x: c * p.x - s * p.y + 50,
      y: s * p.x + c * p.y - 30,
    }));
    expect(decideOrientation(moved).orientation).toBe('forward');
  });

  it('按实际弧长重建：累积弦长单调、等距重采样', () => {
    const t2 = inputs.find((p) => p.epoch === 'T2')!;
    const dec = decideOrientation(t2.rawPoints);
    const canon = canonicalize(t2.rawPoints, dec);
    const rb = rebuildByArcLength(canon, 0.5);
    expect(rb.s.length).toBe(rb.points.length);
    for (let i = 1; i < rb.s.length; i++) expect(rb.s[i]).toBeGreaterThan(rb.s[i - 1]);
    // 等距
    const gaps = rb.s.slice(1).map((v, i) => v - rb.s[i]);
    const g0 = gaps[0];
    for (const g of gaps) expect(Math.abs(g - g0)).toBeLessThan(1e-6);
  });

  it('截短三期弧长短于全段，且不通过端点填充恢复长度', () => {
    const t0 = inputs.find((p) => p.epoch === 'T0')!;
    const t2 = inputs.find((p) => p.epoch === 'T2')!;
    const len0 = rebuildByArcLength(canonicalize(t0.rawPoints, decideOrientation(t0.rawPoints))).totalLength;
    const len2 = rebuildByArcLength(canonicalize(t2.rawPoints, decideOrientation(t2.rawPoints))).totalLength;
    expect(len2).toBeLessThan(len0);
    // 截短至少缺失两端约 14% 起、14% 止
    expect(len2 / len0).toBeLessThan(0.85);
  });
});
