import type { UiProfile, UiResult, UiRun, UiStandard, UiPt } from './types-ui';

const SEG_COLOR: Record<string, string> = {
  'flange-face': '#9b8cff',
  'flange-tip': '#ffd166',
  'flange-root': '#4aa8ff',
  tread: '#7fe0c8',
  'outside-cut': '#566070',
};

interface Transform2D {
  scale: number;
  ox: number;
  oy: number;
}

function fitTransform(std: UiStandard, w: number, h: number, pad = 18): Transform2D {
  const xs = std.points.map((p) => p.x);
  const ys = std.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sx = (w - 2 * pad) / (maxX - minX);
  const sy = (h - 2 * pad) / (maxY - minY);
  const scale = Math.min(sx, sy);
  return {
    scale,
    ox: pad - minX * scale + ((w - 2 * pad) - (maxX - minX) * scale) / 2,
    oy: pad - minY * scale + ((h - 2 * pad) - (maxY - minY) * scale) / 2,
  };
}

function apply(t: Transform2D, p: UiPt): UiPt {
  // y 翻转：车轮径向向上为屏幕上方
  return { x: t.ox + p.x * t.scale, y: t.oy - p.y * t.scale };
}

function polyline(
  ctx: CanvasRenderingContext2D,
  t: Transform2D,
  pts: UiPt[],
  color: string,
  width = 1.5,
  dash: number[] = [],
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const q = apply(t, p);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();
  ctx.restore();
}

/** 主图：标准廓形 + 对齐后测量廓形 + 超限区段着色 */
export function drawProfileCanvas(
  canvas: HTMLCanvasElement,
  run: UiRun,
  profile: UiProfile,
  result: UiResult,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 420;
  const h = 260;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const std = run.standard;
  const t = fitTransform(std, w, h);

  // 标准廓形按段着色
  for (const seg of std.segments) {
    const pts = std.points
      .map((p, i) => ({ p, s: std.cumS[i] }))
      .filter((o) => o.s >= seg.s0 && o.s <= seg.s1)
      .map((o) => o.p);
    polyline(ctx, t, pts, SEG_COLOR[seg.tag] ?? '#888', 2.5);
  }

  // 对齐后测量点（取所选候选变换）—wear[].p 已在标准坐标系
  const chosen = result.candidates.find((c) => c.rank === result.chosenCandidateRank) ?? result.candidates[0];
  void chosen;
  const measPts = result.wear.filter((x) => !x.beyondStandard).map((x) => x.p);
  polyline(ctx, t, measPts, '#ff8fa3', 1.2);

  // 超限区段（在测量曲线上按颜色覆盖）
  for (const v of result.violations) {
    const pts = result.wear
      .filter((x) => !x.beyondStandard && x.s >= v.s0 && x.s <= v.s1)
      .map((x) => x.p);
    if (pts.length > 1) {
      polyline(ctx, t, pts, v.level === 'critical' ? '#ff6b6b' : '#ffc857', 3);
    }
  }

  // 污点排除点
  const excl = result.wear.filter((x) => x.excluded && !x.beyondStandard).map((x) => x.p);
  ctx.fillStyle = '#b06bff';
  for (const p of excl) {
    const q = apply(t, p);
    ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
  }

  // 截短缺口提示：标准廓形两端画短虚线表示未覆盖
  if (profile.missingStartS > 1 || profile.missingEndS > 1) {
    const startGap = std.points
      .map((p, i) => ({ p, s: std.cumS[i] }))
      .filter((o) => o.s < profile.missingStartS)
      .map((o) => o.p);
    polyline(ctx, t, startGap, '#566070', 1, [4, 4]);
  }
}

/** 残差图：沿标准弧长的法向残差（磨耗厚度） */
export function drawResidualCanvas(
  canvas: HTMLCanvasElement,
  run: UiRun,
  result: UiResult,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 420;
  const h = 130;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const std = run.standard;
  const padL = 34;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const samples = result.wear
    .filter((x) => !x.excluded && !x.beyondStandard && !Number.isNaN(x.wear))
    .sort((a, b) => a.s - b.s);
  if (!samples.length) return;
  const maxW = Math.max(1, ...samples.map((x) => x.wear));
  const minW = Math.min(0, ...samples.map((x) => x.wear));
  const xAt = (s: number) => padL + (s / std.totalLength) * (w - padL - padR);
  const yAt = (v: number) =>
    padT + (1 - (v - minW) / (maxW - minW || 1)) * (h - padT - padB);

  // 段背景
  for (const seg of std.segments) {
    ctx.fillStyle = (SEG_COLOR[seg.tag] ?? '#333') + '14';
    ctx.fillRect(xAt(seg.s0), padT, xAt(seg.s1) - xAt(seg.s0), h - padT - padB);
  }

  // 限界线
  for (const lim of std.limits) {
    const seg = std.segments.find((z) => z.tag === lim.tag)!;
    for (const [val, color] of [
      [lim.warning, '#ffc857'],
      [lim.critical, '#ff6b6b'],
    ] as const) {
      if (val < minW || val > maxW) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xAt(seg.s0), yAt(val));
      ctx.lineTo(xAt(seg.s1), yAt(val));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 零线
  ctx.strokeStyle = '#46505d';
  ctx.beginPath();
  ctx.moveTo(padL, yAt(0));
  ctx.lineTo(w - padR, yAt(0));
  ctx.stroke();

  // 残差折线
  ctx.strokeStyle = '#7fe0c8';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  samples.forEach((sm, i) => {
    const x = xAt(sm.s);
    const y = yAt(sm.wear);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 超限点
  for (const sm of samples) {
    const lim = std.limits.find((l) => l.tag === sm.segment);
    if (!lim) continue;
    if (sm.wear >= lim.critical) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillRect(xAt(sm.s) - 1, yAt(sm.wear) - 1, 2, 2);
    } else if (sm.wear >= lim.warning) {
      ctx.fillStyle = '#ffc857';
      ctx.fillRect(xAt(sm.s) - 1, yAt(sm.wear) - 1, 2, 2);
    }
  }

  // 坐标文字
  ctx.fillStyle = '#8593a5';
  ctx.font = '10px sans-serif';
  ctx.fillText(maxW.toFixed(1), 4, yAt(maxW) + 3);
  ctx.fillText('0', 12, yAt(0) + 3);
  ctx.fillText(`${std.totalLength.toFixed(0)}mm`, w - 32, h - 5);
  ctx.fillText('法向磨耗 mm', 4, 9);
}
