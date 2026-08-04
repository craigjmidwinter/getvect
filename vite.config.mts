import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Renderer-only Vite config. The Electron main process is compiled by tsc
// (see tsconfig.node.json) so that `npm run build` needs no bundler plugins
// and works fully offline after `npm install`.
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: resolve(root, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome120',
  },
  resolve: {
    alias: {
      '@engine': resolve(root, 'src/engine'),
      '@shared': resolve(root, 'src/shared'),
    },
  },
});
