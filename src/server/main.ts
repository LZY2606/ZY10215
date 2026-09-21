import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../data/db.js';
import { createApp } from './http.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = process.env.WEB_ROOT ?? join(here, '../../dist/web');
const host = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : '127.0.0.1';
const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 5555;
const dbPath = process.env.DB_PATH ?? join(here, '../../data/bench.sqlite');

const db = openDb(dbPath);
const server = createApp(db, webRoot);
server.listen(port, host, () => {
  console.log(`轮缘磨耗对谱台 已启动: http://${host}:${port}`);
  console.log(`数据库: ${dbPath}`);
});
