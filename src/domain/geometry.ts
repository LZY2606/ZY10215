import { createHash } from 'node:crypto';
import type { Point, RigidTransform } from './types.js';

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
export const norm = (a: Point): number => Math.hypot(a.x, a.y);
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export function normalize(a: Point): Point {
  const n = norm(a);
  return n < 1e-12 ? { x: 0, y: 0 } : { x: a.x / n, y: a.y / n };
}

/** 应用刚体变换 q = R(theta) p + t。 */
export function applyTransform(p: Point, tr: RigidTransform): Point {
  const c = Math.cos(tr.theta);
  const s = Math.sin(tr.theta);
  return { x: c * p.x - s * p.y + tr.tx, y: s * p.x + c * p.y + tr.ty };
}

/** 从两组对应点求刚体变换（q = R p + t），2D 闭式（Kabsch）。 */
export function rigidFromCorrespondences(src: Point[], dst: Point[]): RigidTransform {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return { theta: 0, tx: 0, ty: 0 };
  let cs = { x: 0, y: 0 };
  let cd = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    cs = add(cs, src[i]);
    cd = add(cd, dst[i]);
  }
  cs = scale(cs, 1 / n);
  cd = scale(cd, 1 / n);
  let h00 = 0;
  let h01 = 0;
  let h10 = 0;
  let h11 = 0;
  for (let i = 0; i < n; i++) {
    const a = sub(src[i], cs);
    const b = sub(dst[i], cd);
    h00 += a.x * b.x;
    h01 += a.x * b.y;
    h10 += a.y * b.x;
    h11 += a.y * b.y;
  }
  const theta = Math.atan2(h01 + h10, h00 + h11);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const tx = cd.x - (c * cs.x - sn * cs.y);
  const ty = cd.y - (sn * cs.x + c * cs.y);
  return { theta, tx, ty };
}

/** 组合变换：先 a 后 b。 */
export function composeTransform(a: RigidTransform, b: RigidTransform): RigidTransform {
  return {
    theta: a.theta + b.theta,
    tx: b.tx + Math.cos(b.theta) * a.tx - Math.sin(b.theta) * a.ty,
    ty: b.ty + Math.sin(b.theta) * a.tx + Math.cos(b.theta) * a.ty,
  };
}

/** 累积弦长弧长参数。 */
export function arcLength(points: Point[]): { s: number[]; total: number; monotonic: boolean } {
  const s = [0];
  let monotonic = true;
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i], points[i - 1]);
    if (d <= 1e-9) monotonic = false;
    s.push(s[i - 1] + d);
  }
  return { s, total: s[s.length - 1] ?? 0, monotonic };
}

/** 线性插值（按弧长）重采样为等距点序，沿实际弧长重建。 */
export function resampleByArcLength(points: Point[], spacing: number): { s: number[]; points: Point[]; totalLength: number } {
  if (points.length < 2) return { s: [0], points: points.slice(), totalLength: 0 };
  const { s, total } = arcLength(points);
  const outS: number[] = [];
  const outP: Point[] = [];
  const steps = Math.max(1, Math.round(total / spacing));
  let j = 0;
  for (let k = 0; k <= steps; k++) {
    const target = (total * k) / steps;
    while (j < s.length - 2 && s[j + 1] < target) j++;
    const s0 = s[j];
    const s1 = s[j + 1];
    const f = s1 - s0 < 1e-12 ? 0 : (target - s0) / (s1 - s0);
    outS.push(target);
    outP.push({
      x: points[j].x + (points[j + 1].x - points[j].x) * f,
      y: points[j].y + (points[j + 1].y - points[j].y) * f,
    });
  }
  return { s: outS, points: outP, totalLength: total };
}

/** 由相邻切向转角按弧长估计曲率（有符号转角的绝对值）。 */
export function curvatureByArc(s: number[], points: Point[]): number[] {
  const n = points.length;
  const k = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : i;
    const b = i < n - 1 ? i + 1 : i;
    if (b === a) continue;
    const ds = s[b] - s[a];
    if (ds < 1e-9) continue;
    const tA = normalize(sub(points[i], points[a]));
    const tB = normalize(sub(points[b], points[i]));
    const turn = Math.atan2(cross(tA, tB), Math.max(-1, Math.min(1, dot(tA, tB))));
    k[i] = Math.abs(turn) / ds;
  }
  return k;
}

/** 点到线段投影，返回 {投影点, 参数 t∈[0,1], 距离, 端点索引 a}。 */
export function projectToSegment(p: Point, a: Point, b: Point) {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  let t = len2 < 1e-12 ? 0 : dot(sub(p, a), ab) / len2;
  t = Math.max(0, Math.min(1, t));
  const q = add(a, scale(ab, t));
  return { point: q, t, distance: dist(p, q), a: undefined as number | undefined };
}

/** 稳定内容指纹（与数组顺序无关可用 sortedKeys 预处理）。 */
export function stableHash(obj: unknown): string {
  const canonical = sortKeys(obj);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 中位数。 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
