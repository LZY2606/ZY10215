import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist/web');
mkdirSync(outDir, { recursive: true });

// Copy static index.html into dist
copyFileSync(join(root, 'web/index.html'), join(outDir, 'index.html'));

const ctx = await context({
  entryPoints: [join(root, 'web/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: join(outDir, 'app.js'),
  sourcemap: true,
});
await ctx.watch();

const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(root, 'src/server/main.ts'), ...args],
  { stdio: 'inherit', env: process.env },
);
process.on('SIGINT', () => {
  child.kill('SIGINT');
  ctx.dispose();
  process.exit(0);
});
