import type { Connect, Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  clearAll,
  countAll,
  deleteRawProfile,
  deleteRun,
  getRawProfile,
  getRun,
  listRawProfiles,
  listRuns,
  saveRun,
  upsertRawProfile,
} from './store';
import { buildFixtures } from '../src/core/fixtures';
import { buildStandard } from '../src/core/standard';
import {
  applyTruncatedPreset,
  defaultConfigFor,
  runBatch,
  type BatchConfig,
} from '../src/core/pipeline';
import { serializeRun } from './serialization';
import type { RawProfile } from '../src/core/types';

interface ApiContext {
  req: Connect.IncomingMessage;
  res: ServerResponse;
  body: unknown;
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function readBody(req: Connect.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf-8');
      if (!txt) return resolve(null);
      try {
        resolve(JSON.parse(txt));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function fixtures() {
  return buildFixtures();
}

async function handle(ctx: ApiContext): Promise<boolean> {
  const { req, res, body } = ctx;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';

  try {
    if (path === '/api/health' && method === 'GET') {
      send(res, 200, { ok: true, counts: countAll() });
      return true;
    }

    if (path === '/api/fixtures' && method === 'GET') {
      const fx = fixtures();
      send(res, 200, {
        standard: {
          version: fx.standard.version,
          points: fx.standard.poly.pts,
          cumS: fx.standard.poly.cumS,
          totalLength: fx.standard.poly.totalLength,
          segments: fx.standard.segments,
          limits: fx.standard.limits,
        },
        profiles: fx.profiles,
        expected: fx.expected,
      });
      return true;
    }

    if (path === '/api/profiles' && method === 'GET') {
      const wp = url.searchParams.get('wheelPosition') ?? undefined;
      send(res, 200, { profiles: listRawProfiles(wp) });
      return true;
    }

    if (path === '/api/profiles' && method === 'POST') {
      const b = body as { profiles?: RawProfile[]; profile?: RawProfile };
      const arr = b.profiles ?? (b.profile ? [b.profile] : []);
      for (const p of arr) upsertRawProfile(p);
      send(res, 200, { imported: arr.length, profiles: listRawProfiles() });
      return true;
    }

    if (path === '/api/profiles/load-fixtures' && method === 'POST') {
      const fx = fixtures();
      for (const p of fx.profiles) upsertRawProfile(p);
      send(res, 200, { imported: fx.profiles.length, profiles: listRawProfiles() });
      return true;
    }

    const profMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
    if (profMatch) {
      const id = decodeURIComponent(profMatch[1]);
      if (method === 'GET') {
        const p = getRawProfile(id);
        if (!p) return send(res, 404, { error: 'not found' }), true;
        send(res, 200, { profile: p });
        return true;
      }
      if (method === 'DELETE') {
        deleteRawProfile(id);
        send(res, 200, { ok: true });
        return true;
      }
    }

    if (path === '/api/analyze' && method === 'POST') {
      const b = body as {
        wheelPosition?: string;
        profileIds?: string[];
        config?: BatchConfig;
        stdVersion?: string;
      };
      const std = buildStandard(b.stdVersion ?? 'STD-WP-1.0');
      let raws = listRawProfiles(b.wheelPosition);
      if (b.profileIds?.length) {
        raws = b.profileIds.map((id) => getRawProfile(id)).filter(Boolean) as RawProfile[];
      }
      if (!raws.length) {
        // 未导入时直接用内存 fixture，便于演示
        const fx = fixtures();
        raws = fx.profiles;
      }
      const base = defaultConfigFor(raws, b.wheelPosition ?? raws[0]?.wheelPosition ?? '1A-L');
      const config: BatchConfig = b.config
        ? {
            ...base,
            ...b.config,
            options: { ...base.options, ...b.config.options },
            profiles:
              b.config.profiles?.length
                ? b.config.profiles
                : base.profiles,
          }
        : applyTruncatedPreset(base, ['1A-L#3']);
      const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const run = runBatch(raws, std, config, runId, new Date().toISOString());
      const payload = serializeRun(run, std);
      saveRun({
        runId: run.runId,
        wheelPosition: config.wheelPosition,
        stdVersion: std.version,
        createdAt: run.createdAt,
        configJson: JSON.stringify(config),
        fingerprint: run.fingerprint,
        payloadJson: JSON.stringify(payload),
      });
      send(res, 200, { run: payload });
      return true;
    }

    if (path === '/api/runs' && method === 'GET') {
      const rows = listRuns(url.searchParams.get('wheelPosition') ?? undefined);
      send(
        res,
        200,
        rows.map((r) => ({
          runId: r.runId,
          wheelPosition: r.wheelPosition,
          stdVersion: r.stdVersion,
          createdAt: r.createdAt,
          fingerprint: r.fingerprint,
          config: JSON.parse(r.configJson),
        })),
      );
      return true;
    }

    if (path === '/api/export' && method === 'GET') {
      const std = buildStandard('STD-WP-1.0');
      const raws = listRawProfiles();
      const runs = listRuns()
        .map((r) => {
          try {
            return JSON.parse(r.payloadJson);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      // runs 已经是可序列化运行记录（serializeRun 输出），直接组装导出包
      const bundle = {
        app: 'flange-bench',
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        standard: {
          version: std.version,
          points: std.poly.pts,
          cumS: std.poly.cumS,
          totalLength: std.poly.totalLength,
          segments: std.segments,
          limits: std.limits,
        },
        rawProfiles: raws,
        runs,
      };
      res.setHeader('content-disposition', 'attachment; filename="flange-bench-export.json"');
      send(res, 200, bundle);
      return true;
    }

    if (path === '/api/import' && method === 'POST') {
      const b = body as {
        rawProfiles?: RawProfile[];
        runs?: Array<{ runId: string }>;
      };
      let importedProfiles = 0;
      if (Array.isArray(b.rawProfiles)) {
        for (const p of b.rawProfiles) upsertRawProfile(p);
        importedProfiles = b.rawProfiles.length;
      }
      // runs 原样回灌（payload 已含完整结果与指纹）
      let importedRuns = 0;
      if (Array.isArray(b.runs)) {
        for (const r of b.runs as any[]) {
          saveRun({
            runId: r.runId,
            wheelPosition: r.wheelPosition,
            stdVersion: r.stdVersion,
            createdAt: r.createdAt,
            configJson: JSON.stringify(r.config),
            fingerprint: r.fingerprint,
            payloadJson: JSON.stringify(r),
          });
          importedRuns++;
        }
      }
      send(res, 200, { importedProfiles, importedRuns, counts: countAll() });
      return true;
    }

    if (path === '/api/admin/clear' && method === 'POST') {
      clearAll();
      send(res, 200, { ok: true, counts: countAll() });
      return true;
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      const row = getRun(decodeURIComponent(runMatch[1]));
      if (!row) return send(res, 404, { error: 'not found' }), true;
      send(res, 200, { run: JSON.parse(row.payloadJson) });
      return true;
    }
    if (runMatch && method === 'DELETE') {
      deleteRun(decodeURIComponent(runMatch[1]));
      send(res, 200, { ok: true });
      return true;
    }

    send(res, 404, { error: 'unknown api route', path });
    return true;
  } catch (e) {
    send(res, 500, { error: (e as Error).message, stack: (e as Error).stack });
    return true;
  }
}

export function apiPlugin(): Plugin {
  return {
    name: 'flange-bench-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const body = (req.method ?? 'GET') === 'GET' ? null : await readBody(req);
          const handled = await handle({ req, res, body });
          if (!handled) next();
        } catch (e) {
          send(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
