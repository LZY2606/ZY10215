/// <reference types='vitest/config' />
import { defineConfig } from 'vite';
import { apiPlugin } from './server/vite-plugin-api';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 5555,
    strictPort: false,
  },
  plugins: [apiPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
