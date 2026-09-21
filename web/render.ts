import type { Candidate, ProfileResult, Pt, StandardPayload, WearSample } from './api.js';

const TAG_COLOR: Record<string, string> = {
  rim_inner: '#5b7a99',
  flange_face: '#4ea1ff',
  flange_root: '#c084fc',
  tread: '#37d39a',
  outer_chamfer: '#9aa7b5',
};

function apply(p: Pt, t: { theta: number; tx: number; ty: number }): Pt {
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  return { x: c * p.x - s * p.y + t.tx, y: s * p.x + c * p.y + t.ty };
}

interface DrawOpts {
  std: StandardPayload;
  rawPoints: Pt[];
  result: ProfileResult;
  candidate: Candidate;
  showResidual?: boolean;
}

export function drawProfile(canvas: HTMLCanvasElement, opts: DrawOpts): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  // 将原始测量点用所选变换对齐到标准坐标。
  const moved = opts.rawPoints.map((p) => apply(p, opts.candidate.transform));
  const all = [...opts.std.points, ...moved];
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 14;
  const sx = (W - pad * 2) / (maxX - minX || 1);
  const sy = (H - pad * 2) / (maxY - minY || 1);
  const sc = Math.min(sx, sy);
  const ox = pad - minX * sc + (W - pad * 2 - (maxX - minX) * sc) / 2;
  const oy = pad - minY * sc + (H - pad * 2 - (maxY - minY) * sc) / 2;
  const X = (x: number) => x * sc + ox;
  const Y = (y: number) => H - (y * sc + oy);

  // 标准廓形按区段着色
  ctx.lineWidth = 1.5;
  for (let i = 0; i < opts.std.points.length - 1; i++) {
    const a = opts.std.points[i];
    const b = opts.std.points[i + 1];
    ctx.strokeStyle = TAG_COLOR[opts.std.tags[i]] ?? '#7d8ca3';
    ctx.beginPath();
    ctx.moveTo(X(a.x), Y(a.y));
    ctx.lineTo(X(b.x), Y(b.y));
    ctx.stroke();
  }

  // 根弧锦标
  const root = opts.std.rootChampionship.point;
  ctx.fillStyle = '#c084fc';
  ctx.beginPath();
  ctx.arc(X(root.x), Y(root.y), 3.2, 0, Math.PI * 2);
  ctx.fill();

  // 超限点（在标准点上按法向偏移绘制）
  for (const smp of opts.result.wear) {
    if (!smp.exceedsLimit) continue;
    const q = {
      x: smp.standardPoint.x - smp.normal.x * (smp.wear ?? 0),
      y: smp.standardPoint.y - smp.normal.y * (smp.wear ?? 0),
    };
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(X(q.x) - 1.4, Y(q.y) - 1.4, 2.8, 2.8);
  }

  // 对齐后的测量折线（淡蓝细线上叠加点）
  ctx.strokeStyle = 'rgba(78,161,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  moved.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.x), Y(p.y)) : ctx.lineTo(X(p.x), Y(p.y))));
  ctx.stroke();

  // 用磨耗有效性/污点给测量点分类着色
  const excludedSet = new Set<number>();
  opts.result.wear.forEach(() => void 0);
  moved.forEach((p, i) => {
    // 污点通过残差无法直接映射回索引，这里用候选覆盖以外的点做保守显示
    ctx.fillStyle = 'rgba(78,161,255,0.9)';
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), 1.1, 0, Math.PI * 2);
    ctx.fill();
    void i;
    void excludedSet;
  });

  // 残差曲线（下方小图）
  if (opts.showResidual) drawResidualStrip(ctx, W, H, opts.result, opts.std);
}

function drawResidualStrip(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  result: ProfileResult,
  std: StandardPayload,
): void {
  const stripH = 46;
  const top = H - stripH - 2;
  ctx.fillStyle = 'rgba(11,16,22,0.85)';
  ctx.fillRect(0, top, W, stripH);
  ctx.strokeStyle = '#2a3748';
  ctx.strokeRect(0.5, top + 0.5, W - 1, stripH - 1);
  ctx.fillStyle = '#93a3b5';
  ctx.font = '9px sans-serif';
  ctx.fillText('法向磨耗厚度 (mm)', 6, top + 11);

  const valid = result.wear.filter((w: WearSample) => w.valid);
  if (!valid.length) return;
  const maxV = Math.max(2, ...valid.map((w) => Math.abs(w.wear ?? 0)));
  const baseY = top + stripH - 8;
  const amp = stripH - 20;
  const xOf = (s: number) => {
    const s0 = std.s[0];
    const s1 = std.s[std.s.length - 1];
    return 6 + ((s - s0) / (s1 - s0)) * (W - 12);
  };
  // 0 线
  ctx.strokeStyle = '#3a475a';
  ctx.beginPath();
  ctx.moveTo(6, baseY);
  ctx.lineTo(W - 6, baseY);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  result.wear.forEach((w, i) => {
    if (!w.valid || w.wear === null) return;
    const x = xOf(w.s);
    const y = baseY - (w.wear / maxV) * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    if (w.exceedsLimit) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  });
  ctx.strokeStyle = '#4ea1ff';
  ctx.stroke();
}
