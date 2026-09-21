import type { LimitSpec, Point, SegmentTag, StandardProfile } from './types.js';
import { arcLength, curvatureByArc, normalize, resampleByArcLength, sub } from './geometry.js';

export const STANDARD_VERSION = 'TB-STD-2024.1';
export const LIMIT_VERSION = 'TB-LIMIT-2024.1';
export const RESAMPLE_SPACING = 0.5;

/** 各段法向磨耗报警阈值（mm，材料损失方向）。 */
export const LIMIT_THRESHOLDS: Record<SegmentTag, number> = {
  rim_inner: 9.0,
  flange_face: 4.0,
  flange_root: 2.5,
  tread: 1.8,
  outer_chamfer: 6.0,
};

/**
 * 标准廓形控制点（沿弧长由轮缘内侧顶 -> 踏面外侧）。
 * x 为车轴方向（轮缘->踏面外侧为正），y 为径向（向上）。
 * 数值为教学用磨耗型踏面（TB/1:20 风格）简化几何，单位 mm。
 */
interface Control {
  p: Point;
  tag: SegmentTag;
}

const CONTROLS: Control[] = [
  { p: { x: -40, y: 26 }, tag: 'rim_inner' }, // 轮缘内侧顶附近
  { p: { x: -32.5, y: 28 }, tag: 'rim_inner' }, // 轮缘顶部圆峰
  { p: { x: -27, y: 26 }, tag: 'flange_face' }, // 轮缘外肩
  { p: { x: -21, y: 14 }, tag: 'flange_face' }, // 喉面斜线
  { p: { x: -17, y: 5.5 }, tag: 'flange_face' }, // 喉面下端
  { p: { x: -13.5, y: 1.0 }, tag: 'flange_root' }, // 根弧起点（锚点邻域）
  { p: { x: -9.5, y: 0.0 }, tag: 'flange_root' }, // 根弧最凹（锦标锚点）
  { p: { x: -5.0, y: 0.4 }, tag: 'flange_root' }, // 根弧接踏面
  { p: { x: 0, y: 0.0 }, tag: 'tread' }, // 踏面（1:20 锥度，微降）
  { p: { x: 30, y: -1.2 }, tag: 'tread' },
  { p: { x: 60, y: -2.4 }, tag: 'tread' },
  { p: { x: 72, y: -4.0 }, tag: 'outer_chamfer' }, // 外端倒角
  { p: { x: 76, y: -7.0 }, tag: 'outer_chamfer' },
];

/** 以细间距把控制点折线离散，再按实际弧长等距重采样。 */
function densify(controls: Control[], fine: number): { points: Point[]; tags: SegmentTag[] } {
  const points: Point[] = [];
  const tags: SegmentTag[] = [];
  for (let i = 0; i < controls.length - 1; i++) {
    const a = controls[i];
    const b = controls[i + 1];
    const segLen = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y);
    const n = Math.max(1, Math.ceil(segLen / fine));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      points.push({ x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f });
      tags.push(a.tag);
    }
  }
  const last = controls[controls.length - 1];
  points.push(last.p);
  tags.push(last.tag);
  return { points, tags };
}

/** 依据每段弧长区间为重采样后的点分配标签。 */
function assignTagsByArc(
  densePoints: Point[],
  denseTags: SegmentTag[],
  resampledS: number[],
  resampledPoints: Point[],
): SegmentTag[] {
  const denseArc = arcLength(densePoints).s;
  const tags: SegmentTag[] = [];
  for (let i = 0; i < resampledPoints.length; i++) {
    // 找到最近的稠密点标签（弧长最近）
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < densePoints.length; j++) {
      const d = Math.abs(denseArc[j] - resampledS[i]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    tags.push(denseTags[best]);
  }
  return tags;
}

export function buildStandardProfile(
  limitOverride?: Partial<LimitSpec>,
): StandardProfile {
  const limit: LimitSpec = {
    limitVersion: limitOverride?.limitVersion ?? LIMIT_VERSION,
    thresholds: { ...LIMIT_THRESHOLDS, ...(limitOverride?.thresholds ?? {}) },
  };
  const { points: densePoints, tags: denseTags } = densify(CONTROLS, 0.05);
  const rebuilt = resampleByArcLength(densePoints, RESAMPLE_SPACING);
  const tags = assignTagsByArc(densePoints, denseTags, rebuilt.s, rebuilt.points);

  const n = rebuilt.points.length;
  const tangent: Point[] = [];
  const normal: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = rebuilt.points[Math.max(0, i - 1)];
    const b = rebuilt.points[Math.min(n - 1, i + 1)];
    const t = normalize(sub(b, a));
    tangent.push(t);
    // 弧长方向为轮缘->踏面；材料侧（轮体）在曲线下方/内侧。
    // outward 法向：右旋切向 (+90°)。经核验根弧处指向外侧空气。
    normal.push({ x: -t.y, y: t.x });
  }

  const curv = curvatureByArc(rebuilt.s, rebuilt.points);
  // 轮缘根部锦标锚点：根弧区段内的最低凹点（弧底），磨损后仍稳定可检。
  let rootIdx = 0;
  let rootLow = Infinity;
  for (let i = 0; i < n; i++) {
    if (tags[i] === 'flange_root' && rebuilt.points[i].y < rootLow) {
      rootLow = rebuilt.points[i].y;
      rootIdx = i;
    }
  }

  const segmentRanges: StandardProfile['segmentRanges'] = [];
  const order: SegmentTag[] = ['rim_inner', 'flange_face', 'flange_root', 'tread', 'outer_chamfer'];
  for (const tag of order) {
    const idx = tags
      .map((t, i) => (t === tag ? i : -1))
      .filter((i) => i >= 0);
    if (idx.length) {
      segmentRanges.push({ tag, s0: rebuilt.s[idx[0]], s1: rebuilt.s[idx[idx.length - 1]] });
    }
  }

  return {
    version: STANDARD_VERSION,
    s: rebuilt.s,
    points: rebuilt.points,
    tags,
    tangent,
    normal,
    rootChampionship: {
      s: rebuilt.s[rootIdx],
      point: rebuilt.points[rootIdx],
      curvature: curv[rootIdx],
    },
    segmentRanges,
    limit,
  };
}
