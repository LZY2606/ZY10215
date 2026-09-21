import { api, type Candidate, type ProfileResult, type RawProfile, type RunRecord, type StandardPayload } from './api.js';
import { drawProfile } from './render.js';

const SEGMENT_LABELS: Record<string, string> = {
  rim_inner: '轮缘内侧',
  flange_face: '喉面',
  flange_root: '根弧',
  tread: '踏面',
  outer_chamfer: '外倒角',
};
const ALL_SEGMENTS = ['rim_inner', 'flange_face', 'flange_root', 'tread', 'outer_chamfer'];

let std: StandardPayload | null = null;
let current: RunRecord | null = null;
let rawByProfile = new Map<string, RawProfile>();
// 每条轮廓的独立选择（候选/测头偏差），独立于整批应用。
const choice = new Map<string, { candidateId?: string; appliedBias?: number }>();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2200);
}

function readSettings(): {
  referenceSegments: string[];
  lockRoot: boolean;
  excludeOutliers: boolean;
  nearTieRelThreshold: number;
  applySharedBiasToAll: boolean;
  overrides: Record<string, { candidateId?: string; appliedBias?: number }>;
} {
  const referenceSegments = ALL_SEGMENTS.filter(
    (tag) => ($(`seg-${tag}`) as HTMLInputElement | null)?.checked,
  );
  const overrides: Record<string, { candidateId?: string; appliedBias?: number }> = {};
  for (const [id, ch] of choice) overrides[id] = ch;
  return {
    referenceSegments,
    lockRoot: ($('lock-root') as HTMLInputElement).checked,
    excludeOutliers: ($('exclude-outliers') as HTMLInputElement).checked,
    nearTieRelThreshold: Number(($('near-tie') as HTMLInputElement).value),
    applySharedBiasToAll: ($('apply-bias-all') as HTMLInputElement).checked,
    overrides,
  };
}

async function runAnalyze(): Promise<void> {
  if (!std) return;
  const settings = readSettings();
  try {
    const record = await api.analyze(settings);
    current = record;
    await hydrateInputs(record.runId);
    renderAll();
    toast(`分析完成 runId=${record.runId.slice(0, 8)}（限界 ${record.limitVersion}）`);
    await refreshRuns();
  } catch (e) {
    toast('分析失败：' + (e as Error).message);
  }
}

async function hydrateInputs(runId: string): Promise<void> {
  const detail = await api.run(runId);
  rawByProfile = new Map(detail.inputs.map((p) => [p.id, p]));
}

function candidateFor(result: ProfileResult): Candidate {
  const chosen = choice.get(result.profileId)?.candidateId;
  return (
    result.candidates.find((c) => c.candidateId === chosen) ??
    result.candidates.find((c) => c.candidateId === result.selectedCandidateId) ??
    result.candidates[0]
  );
}

function renderAll(): void {
  if (!current || !std) return;
  $('versions').textContent = `标准 ${current.standardVersion} · 限界 ${current.limitVersion} · 输入指纹 ${current.inputFingerprint.slice(0, 10)}`;
  renderBias();
  renderEpochs();
  renderGlobalExplain();
}

function renderBias(): void {
  const b = current!.sharedBiasCandidate;
  if (!b) {
    $('bias-info').textContent = '未估计到共享偏差。';
    return;
  }
  $('bias-info').innerHTML =
    `候选 <b>${b.bias.toFixed(3)} mm</b>（法向外偏）<br>` +
    `<span class="muted">${b.source}<br>依据 ${b.basedOn.length} 条轮廓：${b.basedOn.map((x) => x.split('-').pop()).join('、')}</span>`;
}

function renderEpochs(): void {
  const wrap = $('epochs');
  wrap.innerHTML = '';
  for (const result of current!.profileResults) {
    const card = document.createElement('div');
    card.className = 'epoch-card';
    const cand = candidateFor(result);
    const reversedBadge = result.orientation.reversed
      ? '<span class="badge rev">反向·已语义翻转</span>'
      : '<span class="badge fwd">正向</span>';
    card.innerHTML = `
      <h3>${result.epoch} ${reversedBadge}</h3>
      <canvas></canvas>
      <div class="kv">
        <span class="k">轮位</span><span>${result.wheelPosition}</span>
        <span class="k">弧长/点数</span><span>${result.rebuild.totalLength.toFixed(1)} mm / ${result.rebuild.pointCount}</span>
        <span class="k">方向置信</span><span>${result.orientation.confidence.toFixed(2)}</span>
        <span class="k">残差RMS/max</span><span>${result.alignmentResidual.rms.toFixed(2)} / ${result.alignmentResidual.max.toFixed(2)} mm</span>
        <span class="k">排除污点</span><span>${result.excludedPointCount} 点</span>
        <span class="k">超限区</span><span>${result.exceedances.length} 段</span>
        <span class="k">指纹</span><span>${result.fingerprint.slice(0, 12)}</span>
      </div>
      <div class="muted" style="margin-top:6px">对齐候选（${result.candidates.length}，近似同分高亮）：</div>
      <div class="cand-list"></div>
      <div class="bias-row">
        <span class="muted">测头偏差(mm)</span>
        <input type="number" step="0.05" class="bias-input" value="${(choice.get(result.profileId)?.appliedBias ?? result.appliedBias).toFixed(3)}" />
        <button class="bias-zero">置零</button>
        <button class="bias-shared">用共享值</button>
      </div>
      <div class="expl"></div>
    `;
    wrap.appendChild(card);

    const canvas = card.querySelector('canvas') as HTMLCanvasElement;
    const raw = rawByProfile.get(result.profileId);
    if (raw) drawProfile(canvas, { std: std!, rawPoints: raw.rawPoints, result, candidate: cand, showResidual: true });

    const candList = card.querySelector('.cand-list') as HTMLElement;
    result.candidates.forEach((c) => {
      const row = document.createElement('div');
      row.className =
        'cand-row' + (c.candidateId === cand.candidateId ? ' sel' : '') + (c.nearBest ? ' near' : '');
      row.innerHTML =
        `${c.seed} · 分 ${c.score.toFixed(3)} · 差距 ${(c.relativeGap * 100).toFixed(1)}%` +
        (c.nearBest ? ' · 近似同分' : '') +
        ` <span class="muted">id ${c.candidateId.slice(0, 6)}</span>`;
      row.title = `变换 θ=${c.transform.theta.toFixed(4)} tx=${c.transform.tx.toFixed(2)} ty=${c.transform.ty.toFixed(2)}；覆盖 ${(c.coverage * 100).toFixed(0)}%`;
      row.onclick = () => {
        const prev = choice.get(result.profileId) ?? {};
        choice.set(result.profileId, { ...prev, candidateId: c.candidateId });
        renderEpochs();
      };
      candList.appendChild(row);
    });

    const biasInput = card.querySelector('.bias-input') as HTMLInputElement;
    biasInput.onchange = () => {
      const prev = choice.get(result.profileId) ?? {};
      choice.set(result.profileId, { ...prev, appliedBias: Number(biasInput.value) });
      void runAnalyze();
    };
    card.querySelector('.bias-zero')!.addEventListener('click', () => {
      const prev = choice.get(result.profileId) ?? {};
      choice.set(result.profileId, { ...prev, appliedBias: 0 });
      void runAnalyze();
    });
    card.querySelector('.bias-shared')!.addEventListener('click', () => {
      const prev = choice.get(result.profileId) ?? {};
      choice.set(result.profileId, { ...prev, appliedBias: current!.sharedBiasCandidate?.bias ?? 0 });
      void runAnalyze();
    });

    const expl = card.querySelector('.expl') as HTMLElement;
    if (result.exceedances.length) {
      expl.innerHTML = result.exceedances
        .map((e) => `<div class="reg">⚠ ${e.explanation}</div>`)
        .join('');
    } else {
      expl.innerHTML = '<div class="ok">未发现超过限界的连续区域。</div>';
    }
  }
}

function renderGlobalExplain(): void {
  const lines: string[] = [];
  for (const r of current!.profileResults) {
    if (!r.exceedances.length) continue;
    for (const e of r.exceedances) {
      lines.push(
        `<div class="reg">【${r.epoch}】${e.explanation} 磨耗均值 ${e.meanWear.toFixed(2)}mm，弧长 ${e.arcLength.toFixed(1)}mm。</div>`,
      );
    }
  }
  $('global-expl').innerHTML = lines.length
    ? lines.join('')
    : '<span class="ok">三期均未越过当前限界版本的阈值。</span>';
}

async function refreshRuns(): Promise<void> {
  const runs = (await api.runs()) as Array<{
    runId: string;
    createdAt: string;
    limitVersion: string;
    profileCount: number;
  }>;
  const body = $('runs-body');
  if (!runs.length) {
    body.innerHTML = '<tr><td colspan="3" class="muted">无</td></tr>';
    return;
  }
  body.innerHTML = runs
    .map(
      (r) =>
        `<tr><td>${new Date(r.createdAt).toLocaleString()}</td><td>${r.limitVersion}</td><td>${r.profileCount} 条 · <a href="#" data-id="${r.runId}" class="load-run" style="color:var(--accent)">载入</a></td></tr>`,
    )
    .join('');
  body.querySelectorAll('.load-run').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = (e.target as HTMLElement).getAttribute('data-id')!;
      const detail = await api.run(id);
      current = detail.run;
      rawByProfile = new Map(detail.inputs.map((p) => [p.id, p]));
      renderAll();
      toast('已载入运行 ' + id.slice(0, 8));
    }),
  );
}

function buildSegmentList(): void {
  const defaults = ['rim_inner', 'flange_face', 'flange_root', 'tread'];
  $('seg-list').innerHTML = ALL_SEGMENTS.map(
    (tag) =>
      `<label><input type="checkbox" id="seg-${tag}" ${defaults.includes(tag) ? 'checked' : ''}/>${SEGMENT_LABELS[tag]}</label>`,
  ).join('');
}

async function main(): Promise<void> {
  std = await api.standard();
  buildSegmentList();
  $('btn-run').onclick = () => void runAnalyze();
  ['lock-root', 'exclude-outliers', 'near-tie', 'apply-bias-all'].forEach((id) =>
    $(id).addEventListener('change', () => void runAnalyze()),
  );
  $('seg-list').addEventListener('change', () => void runAnalyze());
  $('btn-replay').onclick = async () => {
    if (!current) return toast('请先运行分析');
    const r = await api.replay(current.runId);
    toast(r.ok ? `重放复核通过（指纹 ${(r.replayFingerprint ?? '').slice(0, 8)}）` : `复核失败：${r.reason}`);
  };
  $('btn-export').onclick = async () => {
    if (!current) return toast('请先运行分析');
    const r = await api.exportRun(current.runId);
    toast('已导出 ' + r.file);
  };
  $('btn-clear').onclick = async () => {
    await api.clear();
    await refreshRuns();
    toast('数据库已清空，可重新导入复核');
  };
  await refreshRuns();
  await runAnalyze();
}

void main();
