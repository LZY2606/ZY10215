import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist/web');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, 'web/index.html'), join(outDir, 'index.html'));

await build({
  entryPoints: [join(root, 'web/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: join(root, 'dist/web/app.js'),
  sourcemap: true,
  logLevel: 'info',
});
