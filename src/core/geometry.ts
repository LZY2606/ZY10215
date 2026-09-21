import type { Pt, Polyline, RigidXform } from './types';

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
export const len = (a: Pt): number => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const unit = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

export function rotate(p: Pt, theta: number): Pt {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}

export function applyXform(p: Pt, t: RigidXform): Pt {
  return add(rotate(p, t.theta), { x: t.tx, y: t.ty });
}

export function invertXform(t: RigidXform): RigidXform {
  const c = Math.cos(-t.theta);
  const s = Math.sin(-t.theta);
  const x = c * t.tx - s * t.ty;
  const y = s * t.tx + c * t.ty;
  return { theta: -t.theta, tx: -x, ty: -y };
}

/**
 * 按实际弧长重建点序：
 * 1. 不做坐标排序；
 * 2. 以弧长（相邻欧氏距离累积）为唯一参数；
 * 3. 方向语义由调用方（orientation）决定，反向时显式整体翻转。
 */
export function buildPolyline(points: Pt[]): Polyline {
  if (points.length < 2) {
    return { pts: points.slice(), cumS: points.map(() => 0), totalLength: 0 };
  }
  const cumS: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumS.push(cumS[i - 1] + dist(points[i - 1], points[i]));
  }
  return { pts: points.slice(), cumS, totalLength: cumS[cumS.length - 1] };
}

/** 显式语义翻转：整条点序逆序（而不是按 x/y 排序）。 */
export function reversePolyline(poly: Polyline): Polyline {
  const pts = poly.pts.slice().reverse();
  const L = poly.totalLength;
  const cumS = poly.cumS.slice().reverse().map((s) => L - s);
  return { pts, cumS, totalLength: L };
}

export function pointAt(poly: Polyline, s: number): Pt {
  const { pts, cumS } = poly;
  if (s <= 0) return pts[0];
  if (s >= poly.totalLength) return pts[pts.length - 1];
  let lo = 0;
  let hi = cumS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumS[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const s0 = cumS[i - 1];
  const s1 = cumS[i];
  const f = s1 <= s0 ? 0 : (s - s0) / (s1 - s0);
  return {
    x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
    y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
  };
}

/** 弧长 s 处单位切向（沿弧长方向）。 */
export function tangentAt(poly: Polyline, s: number): Pt {
  const e = 1e-3;
  const a = pointAt(poly, Math.max(0, s - e));
  const b = pointAt(poly, Math.min(poly.totalLength, s + e));
  return unit(sub(b, a));
}

/**
 * 单位法向，指向“材料外侧（空气侧）”。
 * canonical 点序 face->tip->root->tread 下，轮体材料位于廓形右侧
 * （踏面向 +x 时材料在 +y，即切向的左侧），故外侧法向取右法向 (ty,-tx)。
 */
export function normalAt(poly: Polyline, s: number): Pt {
  const t = tangentAt(poly, s);
  return { x: t.y, y: -t.x };
}

/** 左法向（部分中间过程使用）。 */
export function leftNormalAt(poly: Polyline, s: number): Pt {
  const t = tangentAt(poly, s);
  return { x: -t.y, y: t.x };
}

export interface ClosestResult {
  q: Pt;
  s: number;
  /** 最近点是否落在端点（外推区） */
  atEndpoint: boolean;
  /** 端点索引：-1 内部，0 起点，1 终点 */
  endpoint: -1 | 0 | 1;
  dist: number;
}

/** 点到折线最近点；返回弧长、端点标记与有符号距离（沿最近段左法向）。 */
export function closestOnPolyline(p: Pt, poly: Polyline): ClosestResult {
  let best: ClosestResult = {
    q: poly.pts[0],
    s: 0,
    atEndpoint: true,
    endpoint: 0,
    dist: Infinity,
  };
  for (let i = 1; i < poly.pts.length; i++) {
    const a = poly.pts[i - 1];
    const b = poly.pts[i];
    const ab = sub(b, a);
    const segLen2 = dot(ab, ab);
    let f = segLen2 <= 0 ? 0 : dot(sub(p, a), ab) / segLen2;
    let endpoint: -1 | 0 | 1 = -1;
    if (f <= 0) {
      f = 0;
      endpoint = 0;
    } else if (f >= 1) {
      f = 1;
      endpoint = 1;
    }
    const q = add(a, scale(ab, f));
    const d = dist(p, q);
    if (d < best.dist) {
      best = {
        q,
        s: poly.cumS[i - 1] + Math.sqrt(segLen2) * f,
        atEndpoint: endpoint !== -1,
        endpoint,
        dist: d,
      };
    }
  }
  return best;
}

/** 有符号距离：正 = p 在折线左侧（材料外侧）。 */
export function signedDistance(p: Pt, poly: Polyline): { d: number; s: number; atEndpoint: boolean; endpoint: -1 | 0 | 1 } {
  const c = closestOnPolyline(p, poly);
  const seg = nearestSegment(poly, c.s);
  const n = seg ? { x: -seg.y, y: seg.x } : { x: 0, y: 0 };
  const d = dot(sub(p, c.q), n);
  return { d, s: c.s, atEndpoint: c.atEndpoint, endpoint: c.endpoint };
}

function nearestSegment(poly: Polyline, s: number): Pt | null {
  const { cumS, pts } = poly;
  for (let i = 1; i < cumS.length; i++) {
    if (s <= cumS[i]) return unit(sub(pts[i], pts[i - 1]));
  }
  const n = pts.length;
  return n >= 2 ? unit(sub(pts[n - 1], pts[n - 2])) : null;
}

export function rms(values: number[]): number {
  if (!values.length) return NaN;
  const sum = values.reduce((a, b) => a + b * b, 0);
  return Math.sqrt(sum / values.length);
}

/** 由两组对应点（质心重合后）求最优旋转角 theta，使 sum |R a_i - b_i|^2 最小。 */
export function optimalRotation(a: Pt[], b: Pt[]): number {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < a.length; i++) {
    s1 += a[i].x * b[i].y - a[i].y * b[i].x;
    s2 += a[i].x * b[i].x + a[i].y * b[i].y;
  }
  return Math.atan2(s1, s2);
}

export function centroid(pts: Pt[]): Pt {
  const c = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: c.x / pts.length, y: c.y / pts.length };
}
