#!/usr/bin/env node
/**
 * `npm run dev` — Vite dev server (HMR for the renderer) + Electron pointed at it.
 *
 * `npm start` deliberately does NOT use this: it builds and runs the real
 * bundle, which is what the e2e suite exercises. Use dev for iteration, start
 * for verification.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('vite dev server did not report a local url');
server.printUrls();

// The main process is plain tsc output; compile once then watch.
const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.node.json', '--watch', '--preserveWatchOutput'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// Give tsc a beat to emit dist/main/main.js before Electron boots.
await new Promise((r) => setTimeout(r, 2500));

const electron = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

const shutdown = async (code = 0) => {
  tsc.kill();
  await server.close();
  process.exit(code);
};

electron.on('close', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
