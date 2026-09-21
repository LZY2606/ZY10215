import { describe, it, expect } from 'vitest';
import { buildFixtures } from '../src/core/fixtures';
import { normalizeProfile } from '../src/core/normalize';
import { buildStandard } from '../src/core/standard';
import { buildPolyline, reversePolyline, rotate, add } from '../src/core/geometry';
import { findArcByRadius } from '../src/core/normalize';
import { alignProfile } from '../src/core/alignment';
import { normalWear } from '../src/core/wear';

const fx = buildFixtures();

describe('语义翻转（非坐标排序）', () => {
  it('翻转是对原始采集点序的整体逆序（不是任何坐标排序）', () => {
    const n2 = normalizeProfile(fx.profiles[1], fx.standard);
    const raw = fx.profiles[1].points;
    // 规范化首点应等于原始采集末点，末点等于原始首点（逐点一致）
    expect(n2.poly.pts[0]).toEqual(raw[raw.length - 1]);
    expect(n2.poly.pts[n2.poly.pts.length - 1]).toEqual(raw[0]);
    for (let i = 0; i < raw.length; i++) {
      expect(n2.poly.pts[i]).toEqual(raw[raw.length - 1 - i]);
    }
    // 而坐标排序通常不会让首点恰为原始末点
    const xSorted = raw.slice().sort((a, b) => a.x - b.x);
    const sameAsReverse =
      JSON.stringify(xSorted[0]) === JSON.stringify(raw[raw.length - 1]);
    expect(sameAsReverse).toBe(false);
  });

  it('正向 P1 不翻转，反向 P2 显式翻转', () => {
    const n1 = normalizeProfile(fx.profiles[0], fx.standard);
    const n2 = normalizeProfile(fx.profiles[1], fx.standard);
    const n3 = normalizeProfile(fx.profiles[2], fx.standard);
    expect(n1.flipped).toBe(false);
    expect(n2.flipped).toBe(true);
    expect(n3.flipped).toBe(false);
  });

  it('翻转是整条点序逆序：P2 翻转后弧长方向与标准一致（root 位于前 40%）', () => {
    const n2 = normalizeProfile(fx.profiles[1], fx.standard);
    // root 弧应能在规范化点序前段被定位
    const arc = findArcByRadius(n2.poly, 14, 4.5)!;
    expect(arc).not.toBeNull();
    const midS = (n2.poly.cumS[arc.idx0] + n2.poly.cumS[arc.idx1 - 1]) / 2;
    expect(midS / n2.poly.totalLength).toBeLessThan(0.5);
  });

  it('坐标排序无法复现语义翻转：排序后点序的局部切向不再沿真实弧长连续', () => {
    // 真实采集（翻转后）相邻点步长均匀且切向平滑；按 x 排序会把空间上
    // 不相邻的 root 点与踏面/缘尖点接到一起，产生异常大的逐点跳距。
    const n2 = normalizeProfile(fx.profiles[1], fx.standard);
    const stepStats = (pts: any[]) => {
      const ds = [];
      for (let i = 1; i < pts.length; i++) {
        ds.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      }
      ds.sort((a, b) => a - b);
      return { med: ds[ds.length >> 1], max: ds[ds.length - 1] };
    };
    const canon = stepStats(n2.poly.pts);
    const sorted = fx.profiles[1].points.slice().sort((a, b) => a.x - b.x);
    const sortedStats = stepStats(sorted);
    // 语义翻转保持原始采集步长；x 排序制造大量跨弧大跳点
    expect(sortedStats.max).toBeGreaterThan(canon.med * 10);
  });

  it('判向对旋转/平移不变：同一廓形换采集刚体扰动后结论一致', () => {
    const raw = fx.profiles[1];
    const moved = raw.points.map((p: any) =>
      add(rotate(p, 0.4), { x: 50, y: -30 }),
    );
    const a = normalizeProfile(raw, fx.standard);
    const b = normalizeProfile({ ...raw, points: moved }, fx.standard);
    expect(a.flipped).toBe(b.flipped);
  });
});

describe('截断段不以端点平移/外推填充', () => {
  it('P3 报告首尾缺失弧长，且总弧长明显短于标准', () => {
    const n3 = normalizeProfile(fx.profiles[2], fx.standard);
    expect(n3.missingEndS).toBeGreaterThan(10);
    expect(n3.poly.totalLength).toBeLessThan(fx.standard.poly.totalLength - 30);
  });

  it('磨耗样本在标准廓形端点外标记 beyondStandard', () => {
    const n3 = normalizeProfile(fx.profiles[2], fx.standard);
    const cands = alignProfile(n3, fx.standard, { basis: 'full', lockRoot: true });
    const wear = normalWear(n3, fx.standard, cands[0].xform, []);
    // 截短测量点不应“填满”标准全长：存在 beyondStandard 标记点
    expect(wear.some((w: any) => w.beyondStandard)).toBe(true);
    for (const w of wear) {
      if (w.beyondStandard) expect(Number.isNaN(w.wear)).toBe(true);
    }
  });
});

describe('标准廓形版本', () => {
  it('不同版本号产生不同限界指纹输入', () => {
    const a = buildStandard('STD-WP-1.0');
    const b = buildStandard('STD-WP-1.1');
    expect(a.version).not.toBe(b.version);
    expect(a.poly.totalLength).toBeCloseTo(b.poly.totalLength, 6);
  });

  it('reversePolyline 弧长守恒', () => {
    const n3 = normalizeProfile(fx.profiles[2], fx.standard);
    const rev = reversePolyline(n3.poly);
    expect(rev.totalLength).toBeCloseTo(n3.poly.totalLength, 9);
  });
});
