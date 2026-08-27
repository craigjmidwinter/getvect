/**
 * The web build: GetVect as a page, for GitHub Pages.
 *
 * Same renderer, same engine, same worker — only the shell differs. `base` is
 * relative so the output can be dropped under any path on Pages without knowing
 * the URL at build time.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

export default defineConfig({
  root: resolve(root, 'src/web'),
  base: './',
  plugins: [react()],
  define: { __GETVECT_VERSION__: JSON.stringify(version) },
  build: {
    outDir: resolve(root, 'site/app'),
    emptyOutDir: true,
    // No source maps: they would be the only assets on the page nobody needs,
    // and on mobile data they are most of the download.
    sourcemap: false,
    target: 'es2022',
  },
  resolve: {
    alias: {
      '@engine': resolve(root, 'src/engine'),
      '@shared': resolve(root, 'src/shared'),
    },
  },
});
