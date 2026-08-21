#!/usr/bin/env node
// The failure path teaches, or it is a defect. Running any documented command
// before `npm install` used to die with a bare TS2688 ("Cannot find type
// definition file for 'node'") — arithmetic on a missing node_modules, with no
// sentence pointing at the fix. This runs before the compile steps and says
// the thing: uses only the stdlib, so it works precisely when nothing else is
// installed yet.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(root, 'node_modules', 'typescript'))) {
  console.error(
    '\nDependencies are not installed yet — run:\n\n    npm install\n\n' +
      'then re-run this command. (First install takes about 10 seconds and\n' +
      'ends with Electron being de-quarantined for local use.)\n',
  );
  process.exit(1);
}
