import { drawProfileCanvas, drawResidualCanvas } from './render';
import type { UiProfileCfg, UiRun } from './types-ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let currentRun: UiRun | null = null;
let perProfileCfg: UiProfileCfg[] = [];

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? opts.body : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function status(msg: string, isError = false) {
  const el = $('statusBar');
  el.textContent = msg;
  el.style.color = isError ? '#ff6b6b' : '#8593a5';
}

async function analyze() {
  const run = currentRun;
  if (!run) return;
  const basis = $<HTMLSelectElement>('basis').value;
  const lockRoot = $<HTMLInputElement>('lockRoot').checked;
  const tieTolRatio = parseFloat($<HTMLSelectElement>('tieTol').value);
  const excludeStain = $<HTMLInputElement>('excludeStain').checked;

  const config = {
    ...run.config,
    options: { basis, lockRoot, tieTolRatio, excludedIntervals: [] },
    sharedProbeBias: run.config.sharedProbeBias,
    profiles: perProfileCfg.map((c) => {
      const excludedIntervals =
        excludeStain && c.profileId.endsWith('#3') ? [{ s0: 36, s1: 52 }] : [];
      const existing = run.config.profiles.find((p) => p.profileId === c.profileId);
      return {
        ...existing,
        ...c,
        excludedIntervals: c.excludedIntervals.length ? c.excludedIntervals : excludedIntervals,
      };
    }),
  };

  status('对谱中…');
  try {
    const data = (await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        wheelPosition: run.wheelPosition,
        config,
      }),
    })) as { run: UiRun };
    currentRun = data.run;
    perProfileCfg = data.run.config.profiles.map((p) => ({ ...p }));
    render();
    await loadRunList();
    status(
      `对谱完成：${data.run.results.length} 期轮廓，指纹 ${data.run.fingerprint.slice(0, 16)}…`,
    );
  } catch (e) {
    status(`对谱失败：${(e as Error).message}`, true);
  }
}

function fmt(n: number, d = 2) {
  return Number.isFinite(n) ? n.toFixed(d) : '–';
}

function render() {
  if (!currentRun) return;
  $('stdVersion').textContent = currentRun.stdVersion;
  $('fingerprint').textContent = currentRun.fingerprint.slice(0, 20);
  const sharedEst = median(
    currentRun.results.flatMap((r) => (r.probeBiasSource === 'shared' ? [r.probeBiasApplied] : [])),
  );
  $('sharedBias').textContent = fmt(sharedEst ?? 0, 3);

  const panels = $('panels');
  panels.innerHTML = '';
  for (const profile of currentRun.profiles) {
    const result = currentRun.results.find((r) => r.profileId === profile.id)!;
    const cfg = perProfileCfg.find((c) => c.profileId === profile.id)!;
    const card = document.createElement('div');
    card.className = 'profile-card';

    const maxTread = maxWear(result, 'tread');
    const maxRoot = maxWear(result, 'flange-root');
    const hasCrit = result.violations.some((v) => v.level === 'critical');
    const hasWarn = result.violations.some((v) => v.level === 'warning');

    card.innerHTML = `
      <h3>
        <span>${profile.id} · ${profile.epoch}</span>
        <span>
          ${profile.flipped ? '<span class="tag flip">语义翻转</span>' : '<span class="tag">正向</span>'}
          ${hasCrit ? '<span class="tag crit">超限</span>' : hasWarn ? '<span class="tag warn">报警</span>' : '<span class="tag">正常</span>'}
        </span>
      </h3>
      <div class="legend">
        <span style="color:#4aa8ff">root</span>
        <span style="color:#7fe0c8">tread</span>
        <span style="color:#ffd166">tip</span>
        <span style="color:#ff8fa3">测量(对齐)</span>
        <span style="color:#ff6b6b">critical</span>
        <span style="color:#ffc857">warning</span>
      </div>
      <canvas class="profile-canvas"></canvas>
      <canvas class="residual-canvas"></canvas>
      <div class="metrics">
        <div class="metric"><div class="k">踏面最大磨耗</div><div class="v">${fmt(maxTread)} mm</div></div>
        <div class="metric"><div class="k">root 最大磨耗</div><div class="v">${fmt(maxRoot)} mm</div></div>
        <div class="metric"><div class="k">配准 RMS</div><div class="v">${fmt(result.rms, 3)}</div></div>
        <div class="metric"><div class="k">测头偏差</div><div class="v">${fmt(result.probeBiasApplied, 3)}</div></div>
        <div class="metric"><div class="k">截短缺口 起/止</div><div class="v">${fmt(profile.missingStartS, 1)}/${fmt(profile.missingEndS, 1)}</div></div>
        <div class="metric"><div class="k">近同分候选</div><div class="v">${result.candidates.filter((c) => c.retained).length}</div></div>
      </div>
      <div class="per-profile">
        <label><input type="checkbox" ${cfg.useSharedBias ? 'checked' : ''} data-act="shared" /> 用共享偏差</label>
        <span>独立选择候选：</span>
        <select data-act="candidate">
          ${result.candidates
            .map(
              (c) =>
                `<option value="${c.rank}" ${c.rank === result.chosenCandidateRank ? 'selected' : ''}>#${c.rank} ${fmt(c.score, 3)}mm ${c.retained ? '(近同分)' : ''}</option>`,
            )
            .join('')}
        </select>
      </div>
      <div class="candidates">
        ${result.candidates
          .slice(0, 5)
          .map(
            (c) => `<div class="candidate ${c.retained ? 'retained' : ''} ${c.rank === result.chosenCandidateRank ? 'chosen' : ''}" data-rank="${c.rank}">
            <span class="rank">#${c.rank}</span>
            <span>${fmt(c.score, 4)} mm</span>
            <span>Δ ${(c.scoreGap * 100).toFixed(1)}%</span>
            <span class="prov">${c.provenance}</span>
          </div>`,
          )
          .join('')}
      </div>
      <div class="violations">
        ${
          result.violations.length
            ? result.violations
                .map(
                  (v) =>
                    `<div class="violation ${v.level}">${v.segment} ${v.level === 'critical' ? '超限' : '报警'}：最大 ${fmt(v.maxWear)}mm（弧长 ${fmt(v.s0, 1)}–${fmt(v.s1, 1)}，限界 ${v.limitVersion}）</div>`,
                )
                .join('')
            : '<div style="color:var(--muted)">未超标准限界</div>'
        }
      </div>
    `;

    panels.appendChild(card);
    const pc = card.querySelector('.profile-canvas') as HTMLCanvasElement;
    const rc = card.querySelector('.residual-canvas') as HTMLCanvasElement;
    requestAnimationFrame(() => {
      drawProfileCanvas(pc, currentRun!, profile, result);
      drawResidualCanvas(rc, currentRun!, result);
    });

    card.querySelector('input[data-act="shared"]')?.addEventListener('change', (e) => {
      cfg.useSharedBias = (e.target as HTMLInputElement).checked;
      void analyze();
    });
    card.querySelector('select[data-act="candidate"]')?.addEventListener('change', (e) => {
      cfg.chosenCandidateRank = parseInt((e.target as HTMLSelectElement).value, 10);
      void analyze();
    });
  }
}

function maxWear(result: UiRun['results'][number], segment: string): number {
  const vals = result.wear
    .filter((w) => w.segment === segment && !w.beyondStandard && !Number.isNaN(w.wear))
    .map((w) => w.wear);
  return vals.length ? Math.max(...vals) : NaN;
}

function median(vals: number[]): number | null {
  const v = vals.slice().sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
}

async function loadRunList() {
  const rows: { runId: string; createdAt: string; fingerprint: string; stdVersion: string }[] =
    await api('/api/runs');
  const el = $('runList');
  el.innerHTML = rows
    .map(
      (r) => `<div class="run-row">
        <code>${r.runId}</code>
        <span>${r.createdAt}</span>
        <span>限界 ${r.stdVersion}</span>
        <span>指纹 <code>${r.fingerprint.slice(0, 16)}…</code></span>
        <button data-run="${r.runId}" class="secondary">载入</button>
        <button data-del="${r.runId}" class="danger secondary">删除</button>
      </div>`,
    )
    .join('');
  el.querySelectorAll('button[data-run]').forEach((b) =>
    b.addEventListener('click', async () => {
      const data = (await api(`/api/runs/${(b as HTMLElement).dataset.run}`)) as { run: UiRun };
      currentRun = data.run;
      perProfileCfg = data.run.config.profiles.map((p) => ({ ...p }));
      syncControls();
      render();
      status('已载入历史运行记录');
    }),
  );
  el.querySelectorAll('button[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/runs/${(b as HTMLElement).dataset.del}`, { method: 'DELETE' });
      await loadRunList();
    }),
  );
}

function syncControls() {
  if (!currentRun) return;
  ($('basis') as HTMLSelectElement).value = currentRun.config.options.basis;
  ($('lockRoot') as HTMLInputElement).checked = currentRun.config.options.lockRoot;
  ($('tieTol') as HTMLSelectElement).value = String(currentRun.config.options.tieTolRatio);
}

async function init() {
  $('btnAnalyze').addEventListener('click', () => void analyze());
  $('basis').addEventListener('change', () => void analyze());
  $('lockRoot').addEventListener('change', () => void analyze());
  $('tieTol').addEventListener('change', () => void analyze());
  $('excludeStain').addEventListener('change', () => void analyze());

  $('btnApplyShared').addEventListener('click', () => {
    const run = currentRun;
    if (!run) return;
    const est = median(
      run.results.map((r) => r.probeBiasApplied),
    );
    if (est === null) return;
    run.config.sharedProbeBias = est;
    for (const c of perProfileCfg) c.useSharedBias = true;
    void analyze();
    status(`已将共享测头偏差候选 ${est.toFixed(3)}mm 应用到整批（每条仍可独立关闭）`);
  });

  $('btnLoadFixture').addEventListener('click', async () => {
    await api('/api/profiles/load-fixtures', { method: 'POST' });
    await initialAnalyze();
    status('已导入固定 fixture（正向 / 反向 / 截短 三期）');
  });

  $('btnExport').addEventListener('click', () => {
    window.open('/api/export', '_blank');
  });

  $('fileImport').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const data = await api('/api/import', { method: 'POST', body: text });
    status(`导入复核完成：${data.importedProfiles} 条轮廓，${data.importedRuns} 条运行记录`);
    await loadRunList();
    await initialAnalyze();
  });

  $('btnClear').addEventListener('click', async () => {
    if (!window.confirm('确认清空数据库中的所有轮廓与运行记录？')) return;
    await api('/api/admin/clear', { method: 'POST' });
    await loadRunList();
    status('数据库已清空，可重新导入复核');
  });

  await loadRunList();
  await initialAnalyze();
}

async function initialAnalyze() {
  status('正在用固定 fixture 初始化对谱…');
  try {
    const data = (await api('/api/analyze', { method: 'POST', body: JSON.stringify({}) })) as { run: UiRun };
    currentRun = data.run;
    perProfileCfg = data.run.config.profiles.map((p) => ({ ...p }));
    syncControls();
    render();
    await loadRunList();
    status('就绪：已显示三期轮廓对齐、法向磨耗与限界交集');
  } catch (e) {
    status(`初始化失败：${(e as Error).message}`, true);
  }
}

void init();
