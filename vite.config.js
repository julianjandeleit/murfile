import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, 'web'),
  base: '/murfile/',
  resolve: {
    // ZBar's inlined build avoids fetching a separate .wasm file at runtime.
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
