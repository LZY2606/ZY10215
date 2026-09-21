import type { Pt, SegmentTag, StandardProfile, WearLimit } from './types';
import { buildPolyline, dist, sub, unit } from './geometry';

/**
 * 标准（无磨耗）轮缘-踏面廓形，单位 mm，教学型几何（不对应真实车型图纸）。
 *
 * canonical 点序（沿实际弧长 s 递增）：
 *   flange-face -> flange-tip -> flange-root -> tread
 * 相邻段在连接点处切向一致（tip/root 圆弧与直线相切）。
 *
 * 几何参数：
 *   tread       1:20 锥度直线，rootEnd=(40,0) -> (100,-3)
 *   flange-root R14 锦标圆角（root-lock 配准锚点），扫 70°
 *   flange-tip  R6 顶部圆角，扫 80°
 *   flange-face 近垂直直线，长 25mm
 */
export function buildStandard(version = 'STD-WP-1.0'): StandardProfile {
  // ---- tread ----
  const rootEnd: Pt = { x: 40, y: 0 };
  const treadEnd: Pt = { x: 100, y: -3 };
  const treadAng = Math.atan2(treadEnd.y - rootEnd.y, treadEnd.x - rootEnd.x);

  // ---- root R14（CCW，tread 走向上左侧凸出）----
  const rootR = 14;
  const rootSweep = (70 * Math.PI) / 180;
  const rootAngEnd = treadAng - Math.PI / 2;
  const rootAngStart = rootAngEnd - rootSweep;
  const rootC: Pt = {
    x: rootEnd.x - rootR * Math.cos(rootAngEnd),
    y: rootEnd.y - rootR * Math.sin(rootAngEnd),
  };
  // rootStart 处 CCW 切向 = angle(rootAngStart) + 90°
  const rootStartTan = rootAngStart + Math.PI / 2;

  // ---- tip R6：与 root 在连接点相切，故 tip 半径角与 root 半径角相同 ----
  const joint: Pt = {
    x: rootC.x + rootR * Math.cos(rootAngStart),
    y: rootC.y + rootR * Math.sin(rootAngStart),
  };
  const tipR = 6;
  const tipSweep = (80 * Math.PI) / 180;
  // tip 在连接点处必须 CW 到达（从 tip 走向 root），因此 tip 圆弧整体 CCW 时，
  // 连接点是 tip 的起点；tip 圆心位于 root 圆心对侧。
  const tipC: Pt = {
    x: joint.x + tipR * Math.cos(rootAngStart),
    y: joint.y + tipR * Math.sin(rootAngStart),
  };
  const tipAngStart = rootAngStart + Math.PI; // tip 起点半径角（从 tipC 指向 joint）
  const tipAngEnd = tipAngStart + tipSweep;
  const tipEnd: Pt = {
    x: tipC.x + tipR * Math.cos(tipAngEnd),
    y: tipC.y + tipR * Math.sin(tipAngEnd),
  };
  const tipEndTan = tipAngEnd + Math.PI / 2;

  // ---- face：与 tip 末端切向一致的直线，向“下”走 25mm（即 -tan 方向）----
  const faceVec: Pt = unit({ x: Math.cos(tipEndTan), y: Math.sin(tipEndTan) });
  const faceBottom: Pt = {
    x: tipEnd.x - faceVec.x * 25,
    y: tipEnd.y - faceVec.y * 25,
  };
  void rootStartTan;

  const N_FACE = 60;
  const N_TIP = 60;
  const N_ROOT = 90;
  const N_TREAD = 120;

  const all: Pt[] = [];
  // face：faceBottom -> tipEnd（canonical 向上）
  for (let i = 0; i <= N_FACE; i++) {
    const f = i / N_FACE;
    all.push({
      x: faceBottom.x + (tipEnd.x - faceBottom.x) * f,
      y: faceBottom.y + (tipEnd.y - faceBottom.y) * f,
    });
  }
  // tip：joint 是 tip 的终点；采样从 tipEnd -> joint（角递减）
  for (let i = 1; i <= N_TIP; i++) {
    const a = tipAngEnd - (tipSweep * i) / N_TIP;
    all.push({ x: tipC.x + tipR * Math.cos(a), y: tipC.y + tipR * Math.sin(a) });
  }
  // root：joint -> rootEnd（角递增）
  for (let i = 1; i <= N_ROOT; i++) {
    const a = rootAngStart + (rootSweep * i) / N_ROOT;
    all.push({ x: rootC.x + rootR * Math.cos(a), y: rootC.y + rootR * Math.sin(a) });
  }
  // tread
  for (let i = 1; i <= N_TREAD; i++) {
    const f = i / N_TREAD;
    all.push({
      x: rootEnd.x + (treadEnd.x - rootEnd.x) * f,
      y: rootEnd.y + (treadEnd.y - rootEnd.y) * f,
    });
  }

  const poly = buildPolyline(all);

  // ---- 相切/连接自检 ----
  const segTan = (i: number) => unit(sub(all[i + 1], all[i - 1]));
  const para = (u: Pt, v: Pt) => Math.abs(u.x * v.x + u.y * v.y) > 0.9995;
  const iTip0 = N_FACE;
  const iRoot0 = N_FACE + N_TIP;
  const iTread0 = N_FACE + N_TIP + N_ROOT;
  if (
    !para(segTan(iTip0 - 1), segTan(iTip0 + 1)) ||
    !para(segTan(iRoot0 - 1), segTan(iRoot0 + 1)) ||
    !para(segTan(iTread0 - 1), segTan(iTread0 + 1))
  ) {
    throw new Error('standard profile tangency check failed');
  }
  if (
    dist(all[iRoot0], joint) > 1e-6 ||
    dist(all[iTread0], rootEnd) > 1e-6
  ) {
    throw new Error('standard profile junction check failed');
  }

  const at = (i: number) => poly.cumS[Math.max(0, Math.min(i, poly.cumS.length - 1))];
  const iEnd = poly.cumS.length - 1;
  const segments = [
    { tag: 'flange-face' as SegmentTag, s0: at(0), s1: at(iTip0) },
    { tag: 'flange-tip' as SegmentTag, s0: at(iTip0), s1: at(iRoot0) },
    { tag: 'flange-root' as SegmentTag, s0: at(iRoot0), s1: at(iTread0) },
    { tag: 'tread' as SegmentTag, s0: at(iTread0), s1: at(iEnd) },
  ];

  const limits: WearLimit[] = [
    { tag: 'flange-face', warning: 2.0, critical: 3.5 },
    { tag: 'flange-tip', warning: 1.5, critical: 2.5 },
    { tag: 'flange-root', warning: 1.0, critical: 1.8 },
    { tag: 'tread', warning: 3.0, critical: 5.0 },
  ];

  return { version, poly, segments, limits };
}

export function segmentAtS(std: StandardProfile, s: number): SegmentTag {
  for (const seg of std.segments) {
    if (s >= seg.s0 - 1e-9 && s <= seg.s1 + 1e-9) return seg.tag;
  }
  return 'outside-cut';
}

export function limitFor(std: StandardProfile, tag: SegmentTag): WearLimit | undefined {
  return std.limits.find((l) => l.tag === tag);
}
