import type { Point, SegmentTag, StandardProfile } from './types.js';
import { sub, dot, scale, add, normalize } from './geometry.js';

export interface ProjectionHit {
  /** 命中的边起点索引（points[a] -> points[a+1]）。 */
  segIndex: number;
  point: Point; // 标准廓形上的垂足
  t: number; // 边参数 [0,1]
  s: number; // 垂足弧长
  distance: number;
  signedNormal: number; // (q-p)·n 有符号法向距离
  normal: Point;
  tag: SegmentTag;
  interior: boolean; // 垂足是否在边内部（非端点钳制）
  beyondExtent: boolean; // 是否仅能钳制到整段折线的最外端点（标准廓形之外）
}

/** 将点投影到标准折线（可限定区段）。不会在标准廓形弧长范围之外制造配准。 */
export function projectToStandard(
  q: Point,
  std: StandardProfile,
  allowed?: Set<SegmentTag>,
  maxDistance = 12,
): ProjectionHit | null {
  let best: ProjectionHit | null = null;
  const n = std.points.length;
  for (let i = 0; i < n - 1; i++) {
    const tag = std.tags[i];
    if (allowed && !allowed.has(tag)) continue;
    const a = std.points[i];
    const b = std.points[i + 1];
    const ab = sub(b, a);
    const len2 = dot(ab, ab);
    let t = len2 < 1e-12 ? 0 : dot(sub(q, a), ab) / len2;
    const clamped = t < 0 || t > 1;
    t = Math.max(0, Math.min(1, t));
    const foot = add(a, scale(ab, t));
    const d = Math.hypot(q.x - foot.x, q.y - foot.y);
    if (d > maxDistance) continue;
    if (!best || d < best.distance) {
      const s = std.s[i] + t * (std.s[i + 1] - std.s[i]);
      // 边内法向（线性）
      const nrm = normalize({
        x: std.normal[i].x + (std.normal[i + 1].x - std.normal[i].x) * t,
        y: std.normal[i].y + (std.normal[i + 1].y - std.normal[i].y) * t,
      });
      const globalEnd =
        (i === 0 && t <= 1e-6) || (i === n - 2 && t >= 1 - 1e-6);
      best = {
        segIndex: i,
        point: foot,
        t,
        s,
        distance: d,
        signedNormal: dot(sub(q, foot), nrm),
        normal: nrm,
        tag: std.tags[t > 0.5 ? i + 1 : i],
        interior: !clamped,
        beyondExtent: clamped && globalEnd,
      };
    }
  }
  return best;
}
