#!/usr/bin/env node
// Remove build output. Fixtures and artifacts are left alone (use `npm run fixtures`
// to regenerate fixtures; artifacts are overwritten by the instruments run).
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const dir of ['dist', 'test-results', 'playwright-report']) {
  await rm(join(root, dir), { recursive: true, force: true });
  console.log(`removed ${dir}`);
}
