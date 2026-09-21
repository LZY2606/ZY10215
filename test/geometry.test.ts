import { describe, it, expect } from 'vitest';
import {
  buildPolyline,
  reversePolyline,
  pointAt,
  normalAt,
  applyXform,
  closestOnPolyline,
  optimalRotation,
} from '../src/core/geometry';
import type { Pt } from '../src/core/types';

describe('弧长重建与翻转', () => {
  it('按相邻欧氏距离累积弧长，而非坐标排序', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 3, y: 4 }, // 故意乱序的 x，但采集连接顺序在 10->(3,4)
      { x: 3, y: 9 },
    ];
    const poly = buildPolyline(pts);
    expect(poly.totalLength).toBeCloseTo(10 + Math.hypot(-7, 4) + 5, 9);
    expect(poly.cumS[2]).toBeCloseTo(10 + Math.hypot(-7, 4), 9);
  });

  it('reversePolyline 显式逆序点序（语义翻转），不排序坐标', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 9 },
    ];
    const poly = buildPolyline(pts);
    const rev = reversePolyline(poly);
    expect(rev.pts[0]).toEqual({ x: 3, y: 9 });
    expect(rev.pts[2]).toEqual({ x: 0, y: 0 });
    expect(rev.totalLength).toBeCloseTo(poly.totalLength, 9);
    // 同一弧长位置在翻转后取到相反端点
    expect(pointAt(rev, 0)).toEqual({ x: 3, y: 9 });
  });

  it('外侧法向在踏面指向空气侧（-y 主导）', () => {
    const std = (globalThis as any).__std;
    const tread = std.segments.find((s: any) => s.tag === 'tread');
    const n = normalAt(std.poly, (tread.s0 + tread.s1) / 2);
    expect(n.y).toBeLessThan(0);
  });
});

describe('刚体配准原语', () => {
  it('optimalRotation 恢复已知旋转', () => {
    const a: Pt[] = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
    ];
    const th = 0.37;
    const b = a.map((p) => ({
      x: p.x * Math.cos(th) - p.y * Math.sin(th),
      y: p.x * Math.sin(th) + p.y * Math.cos(th),
    }));
    expect(optimalRotation(a, b)).toBeCloseTo(th, 6);
  });

  it('closestOnPolyline 标记端点外推', () => {
    const poly = buildPolyline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const inside = closestOnPolyline({ x: 5, y: 2 }, poly);
    expect(inside.atEndpoint).toBe(false);
    const beyond = closestOnPolyline({ x: 15, y: 2 }, poly);
    expect(beyond.atEndpoint).toBe(true);
    expect(beyond.endpoint).toBe(1);
    void applyXform;
  });
});
