import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { DB } from '../data/db.js';
import {
  analyze,
  clearDb,
  exportRun,
  getRun,
  removeRun,
  replay,
  runs,
  standardProfilePayload,
  type AnalyzeRequest,
} from './service.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

export function createApp(db: DB, webRoot: string) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (path === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, name: '轮缘磨耗对谱台' });
      }
      if (path === '/api/standard' && req.method === 'GET') {
        return json(res, 200, standardProfilePayload());
      }
      if (path === '/api/runs' && req.method === 'GET') {
        return json(res, 200, runs(db));
      }
      if (path === '/api/analyze' && req.method === 'POST') {
        const body = (await readBody(req)) as AnalyzeRequest;
        const { record } = analyze(db, body);
        return json(res, 200, record);
      }
      if (path.startsWith('/api/runs/') && req.method === 'GET') {
        const runId = decodeURIComponent(path.slice('/api/runs/'.length));
        const saved = getRun(db, runId);
        if (!saved) return json(res, 404, { error: 'not-found' });
        return json(res, 200, saved);
      }
      if (path.match(/^\/api\/runs\/[^/]+\/replay$/) && req.method === 'POST') {
        const runId = decodeURIComponent(path.split('/')[3]);
        return json(res, 200, replay(db, runId));
      }
      if (path.match(/^\/api\/runs\/[^/]+\/export$/) && req.method === 'POST') {
        const runId = decodeURIComponent(path.split('/')[3]);
        const file = exportRun(db, runId);
        return json(res, 200, { file });
      }
      if (path.match(/^\/api\/runs\/[^/]+$/) && req.method === 'DELETE') {
        const runId = decodeURIComponent(path.split('/')[3]);
        removeRun(db, runId);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/runs' && req.method === 'DELETE') {
        clearDb(db);
        return json(res, 200, { ok: true });
      }

      // 静态资源
      let rel = path === '/' ? '/index.html' : path;
      const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const file = join(webRoot, safe);
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(data);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });
}
