import type { ArcLengthRebuild, OrientationDecision, Point, ScanOrientation } from './types.js';
import { arcLength, resampleByArcLength } from './geometry.js';
import { RESAMPLE_SPACING } from './standard.js';

/** 按实际弧长重建点序：累积弦长为弧长，等距线性插值重采样（不改变语义顺序）。 */
export function rebuildByArcLength(points: Point[], spacing: number = RESAMPLE_SPACING): ArcLengthRebuild {
  const { s, total, monotonic } = arcLength(points);
  if (points.length < 2) {
    return { s, points: points.slice(), totalLength: total, monotonic, resampleSpacing: spacing };
  }
  const r = resampleByArcLength(points, spacing);
  return {
    s: r.s,
    points: r.points,
    totalLength: r.totalLength,
    monotonic,
    resampleSpacing: spacing,
  };
}

/**
 * 判定采集点序语义方向。
 *
 * 关键约束：输入转向相反时必须“显式翻转数组”，而不能仅按 x/y 坐标排序。
 * 因此判据必须是“点序方向”的有符号不变量，而不能是坐标单调性。
 *
 * 主判据：把开放折线用“末点->首点弦”闭合后求有符号面积（Shoelace）。
 *   - 它在任意旋转/平移下不变，点序反向时严格变号（反射不变量）；
 *   - 对轮缘—踏面这类单侧凸起廓形，标准方向（轮缘 -> 踏面）有确定符号；
 *   - 截短（两端缺失）只改变幅度不改变符号；
 *   - 不读 x/y 排序，故满足“语义翻转而非坐标排序”。
 * 辅判据：质心相对“首->尾有向弦”的有符号侧（与面积同号），用于置信度与一致性校验。
 */
export function decideOrientation(points: Point[]): OrientationDecision {
  const rebuilt = rebuildByArcLength(points);
  const ps = rebuilt.points;
  const n = ps.length;

  let twiceArea = 0;
  for (let i = 0; i < n; i++) {
    const a = ps[i];
    const b = ps[(i + 1) % n]; // 末 -> 首弦闭合
    twiceArea += a.x * b.y - a.y * b.x;
  }
  const signedArea = twiceArea / 2;

  let cx = 0;
  let cy = 0;
  for (const p of ps) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const chordX = ps[n - 1].x - ps[0].x;
  const chordY = ps[n - 1].y - ps[0].y;
  const centroidSide = (cx - ps[0].x) * chordY - (cy - ps[0].y) * chordX;

  const agree = signedArea * centroidSide >= 0;
  // 归一化强度（相对廓形尺度平方），用于置信度
  const chordLen = Math.hypot(chordX, chordY) || 1;
  const strength = Math.min(1, Math.abs(signedArea) / (chordLen * chordLen * 2 + 1e-9));

  // 本坐标系下：标准方向（轮缘 -> 踏面）有符号面积为正。
  const orientation: ScanOrientation = signedArea >= 0 ? 'forward' : 'reverse';
  const confidence = Math.min(1, 0.55 + strength * 1.4 + (agree ? 0.08 : 0));

  return {
    orientation,
    method:
      '开放折线弦闭合有符号面积(Shoelace)+质心有向弦侧一致性；旋转平移不变、点序反向严格变号，不依赖坐标排序',
    evidence: {
      startEnergy: signedArea,
      endEnergy: centroidSide,
      startMaxCurv: strength,
      endMaxCurv: agree ? 1 : 0,
    },
    confidence,
    reversed: orientation === 'reverse',
  };
}

/**
 * 依据语义判定显式翻转为标准方向（轮缘 -> 踏面）。
 * reverse 时对整个数组 reverse()（语义翻转），绝不做坐标排序。
 */
export function canonicalize(points: Point[], decision: OrientationDecision): Point[] {
  if (!decision.reversed) return points.slice();
  return points.slice().reverse();
}
