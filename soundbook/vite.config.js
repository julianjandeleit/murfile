import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const soundbookRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(soundbookRoot, '..');

export default defineConfig({
  root: resolve(soundbookRoot, 'web'),
  base: '/murfile/soundbook/',
  build: {
    outDir: resolve(projectRoot, 'dist/soundbook'),
    emptyOutDir: true,
  },
  resolve: {
    conditions: ['zbar-inlined', 'module', 'browser'],
  },
  server: {
    host: '0.0.0.0',
    fs: { allow: [projectRoot] },
  },
  preview: {
    host: '0.0.0.0',
  },
});
