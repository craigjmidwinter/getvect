#!/usr/bin/env node
/**
 * What a command costs the machine it runs on.
 *
 * "The suite hijacks my machine" is a claim about CPU saturation over time, and
 * wall time alone cannot confirm or refute it — a run that finishes fast by
 * taking every core is exactly the complaint. So this samples system-wide CPU
 * while the command runs and reports the peak and the sustained load next to
 * the wall time, which is the trade the politeness settings are making.
 *
 * System-wide rather than the process tree on purpose: the thing being measured
 * is what the human sitting at the machine experiences, and that includes the
 * work the suite provokes in other processes (Electron helpers, the window
 * server, spotlight reindexing the artifacts it writes).
 *
 *   node scripts/measure-load.mjs --label baseline -- npm test
 *
 * Writes artifacts/load-<label>.json and prints a one-line summary.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1) {
  console.error('usage: node scripts/measure-load.mjs [--label NAME] -- <command...>');
  process.exit(2);
}
const labelAt = argv.indexOf('--label');
const label = labelAt !== -1 && labelAt < sep ? argv[labelAt + 1] : 'run';
const command = argv.slice(sep + 1);
if (!command.length) {
  console.error('nothing to run after --');
  process.exit(2);
}

const CORES = cpus().length;

/**
 * Busy percentage of the WHOLE machine over a one-second interval: 0 is idle,
 * 100 is every core saturated.
 *
 * Deliberately not `ps -A -o %cpu`. On macOS that column is each process's
 * average over its own lifetime, not its current draw, so a browser that has
 * been open all day contributes its all-day average to every reading and the
 * "idle" floor comes out above 1200%. `top -l 2` throws its first sample away
 * and measures the second across a real interval, which is the only reading
 * here that means what it says.
 */
function sampleCpu() {
  return new Promise((resolve) => {
    const top = spawn('top', ['-l', '2', '-n', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    top.stdout.on('data', (d) => (out += d));
    top.on('close', () => {
      const lines = out.split('\n').filter((l) => l.startsWith('CPU usage:'));
      const last = lines[lines.length - 1];
      if (!last) return resolve(NaN);
      const user = /([\d.]+)%\s*user/.exec(last);
      const sys = /([\d.]+)%\s*sys/.exec(last);
      if (!user || !sys) return resolve(NaN);
      resolve(Number(user[1]) + Number(sys[1]));
    });
    top.on('error', () => resolve(NaN));
  });
}

// The machine's own floor, measured BEFORE the command starts — otherwise it
// races the command and reads the very thing it is supposed to be a baseline for.
const idle = await sampleCpu();

const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const v = await sampleCpu();
    if (Number.isFinite(v)) samples.push(v);
  }
})();

const started = Date.now();
const code = await new Promise((resolve) => {
  const child = spawn(command[0], command.slice(1), { cwd: root, stdio: 'inherit', shell: false });
  child.on('close', (c) => resolve(c ?? 1));
  child.on('error', (err) => {
    console.error(`${command[0]}: ${err.message}`);
    resolve(1);
  });
});
const wallMs = Date.now() - started;
sampling = false;
await sampler;

samples.sort((a, b) => a - b);
const pct = (f) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * f))] : 0);
const mean = samples.length ? samples.reduce((s, v) => s + v, 0) / samples.length : 0;
const asCores = (v) => ((v / 100) * CORES).toFixed(1);

const report = {
  label,
  command: command.join(' '),
  exitCode: code,
  cores: CORES,
  wallSeconds: +(wallMs / 1000).toFixed(1),
  samples: samples.length,
  // every percentage below is of the WHOLE machine: 100 = all cores saturated
  idleFloorPercent: +idle.toFixed(1),
  machinePercent: { mean: +mean.toFixed(1), p50: +pct(0.5).toFixed(1), p90: +pct(0.9).toFixed(1), peak: +pct(1).toFixed(1) },
  coresBusy: { mean: +asCores(mean), peak: +asCores(pct(1)) },
};

await fs.mkdir(join(root, 'artifacts'), { recursive: true });
await fs.writeFile(join(root, `artifacts/load-${label}.json`), JSON.stringify(report, null, 2) + '\n');

console.log(`\n=== load: ${label} ===   (percentages are of the whole ${CORES}-core machine)`);
console.log(`  wall time        ${report.wallSeconds}s   (exit ${code})`);
console.log(`  floor before     ${report.idleFloorPercent}%`);
console.log(`  machine, mean    ${report.machinePercent.mean}%   = ${report.coresBusy.mean} of ${CORES} cores busy`);
console.log(`  machine, p90     ${report.machinePercent.p90}%`);
console.log(`  machine, peak    ${report.machinePercent.peak}%   = ${report.coresBusy.peak} cores busy`);
console.log(`  written to       artifacts/load-${label}.json`);

process.exit(code);
