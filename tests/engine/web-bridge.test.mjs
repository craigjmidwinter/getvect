/**
 * THE BROWSER BUILD CONTAINS NO NETWORK CALL, ASSERTED IN THE SOURCE.
 *
 * "Your image does not leave your machine" is the claim the whole project rests
 * on, and on the web it is the one a reader can falsify in ten seconds with
 * devtools open. `src/web/bridge.ts` has always said so in its header, and said
 * that this file proved it. This file did not exist. The claim was asserted and
 * never produced — the failure this repo has a rule against, one layer up from a
 * DEAD GATE: a control that is cited, trusted, and absent.
 *
 * WHAT THIS COVERS THAT THE RUNTIME SPEC DOES NOT. `tests/e2e/w-web-offline.spec.ts`
 * takes the page offline and traces an image anyway. That is a better kind of
 * evidence and it is not this one: it proves the app behaves on ONE traced path.
 * A `fetch` added behind a branch that path never walks stays green there, and
 * red here, because this reads the source rather than running it.
 *
 * THE WINDOW, because a measurement without one is not a result. This walks the
 * static import graph from the page's own entry point and covers FIRST-PARTY
 * SOURCE UNDER src/ ONLY. It does not read node_modules: react and react-dom are
 * in the bundle and are not scanned here. What backstops that gap is not this
 * test — it is `connect-src 'none'` in src/web/index.html, which the browser
 * enforces against every script on the page whoever wrote it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The page's entry point, not the bridge.
 *
 * bridge.ts imports exactly one thing, and it is a `type`. Walking from there
 * would give a graph of one file and a guard that could never go red — the
 * already-satisfied control, which looks identical to a passing one. main.tsx is
 * what index.html loads, and it pulls in App, the engine, the exporters and the
 * worker: the code that actually touches the image.
 */
const ENTRY = 'src/web/main.tsx';

/** Vite aliases from vite.web.config.mts. Kept in step by the reach test below. */
const ALIASES = { '@engine': 'src/engine', '@shared': 'src/shared' };

/**
 * Comments stripped, strings kept, and the asymmetry is deliberate.
 *
 * Stripping too little costs a false positive that a human reads and dismisses.
 * Stripping too much costs a false negative, which is this guard quietly not
 * working. So only two unambiguous forms go: block comments, and lines that are
 * nothing but a comment. A trailing `// fetch(...)` survives and would trip the
 * guard — the safe direction.
 *
 * It has to strip something, or the guard indicts the prose that explains it:
 * bridge.ts's own header lists "no fetch, no XHR, no WebSocket, no beacon".
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/**
 * The five primitives, in the order src/web/index.html prints them to the reader.
 *
 * The page's footer invites verification by name, so the list the guard holds and
 * the list the page claims are the same list. Adding one here without adding it
 * there leaves the page understating what it does; the reverse is worse.
 */
const NETWORK = [
  { name: 'fetch', re: /(?<![.\w])fetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },
  { name: 'EventSource', re: /\bEventSource\b/ },
  { name: 'sendBeacon', re: /\bsendBeacon\b/ },
];

/** Every `from '...'`, bare `import '...'` and `import('...')` specifier. */
function specifiers(src) {
  const out = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/**
 * A specifier to a path under src/, or null for anything outside the window.
 *
 * The `?worker&inline` suffix is load-bearing: engineClient.ts reaches the
 * vectorize worker through it, and a resolver that does not strip the query
 * drops the one file the image data is actually handled in.
 */
function resolveSpec(spec, fromFile) {
  const clean = spec.split('?')[0];
  if (clean.endsWith('.css') || clean.endsWith('.png')) return null;

  let base;
  if (clean.startsWith('.')) base = resolve(dirname(fromFile), clean);
  else {
    const alias = Object.keys(ALIASES).find((a) => clean === a || clean.startsWith(`${a}/`));
    if (!alias) return null; // bare package: react, node builtins — outside the window
    base = join(root, ALIASES[alias], clean.slice(alias.length));
  }

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    // isFile(), not existsSync(): a directory named `foo` sits in front of
    // `foo.ts` for a specifier of `./foo`, and returning it drops the subtree.
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** Breadth-first over the static import graph, entry included. */
function graph() {
  const seen = new Map();
  const queue = [join(root, ENTRY)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    seen.set(file, src);
    for (const spec of specifiers(src)) {
      const next = resolveSpec(spec, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const FILES = graph();
const rel = (f) => relative(root, f).split('\\').join('/');

test('the detector fires — every pattern catches its own primitive', () => {
  // The guard's own control. A regex that matches nothing passes this file
  // silently and forever, which is the failure mode of every source-scanning
  // check ever written.
  const samples = {
    fetch: 'const r = await fetch("https://example.com");',
    XMLHttpRequest: 'const x = new XMLHttpRequest();',
    WebSocket: 'const s = new WebSocket("wss://example.com");',
    EventSource: 'const e = new EventSource("/stream");',
    sendBeacon: 'navigator.sendBeacon("/collect", data);',
  };
  for (const { name, re } of NETWORK) {
    assert.match(samples[name], re, `the ${name} pattern does not match a real ${name} call`);
  }
  // And it is not matching everything: the engine's hot loop must read clean.
  const innocent = 'for (let i = 0; i < path.length; i += 1) out.push(path[i].x);';
  for (const { name, re } of NETWORK) {
    assert.doesNotMatch(innocent, re, `the ${name} pattern matches ordinary code`);
  }
});

test('the import graph reaches the code that handles the image', () => {
  // The resolver is the half that fails silently. If an alias moves in
  // vite.web.config.mts or the worker's `?worker&inline` suffix changes shape,
  // the graph shrinks and every assertion below passes over an empty set.
  const names = new Set([...FILES.keys()].map(rel));

  for (const required of [
    ENTRY,
    'src/web/bridge.ts',
    'src/renderer/App.tsx',
    'src/renderer/lib/engineClient.ts',
    // Reached only through `../workers/vectorize.worker?worker&inline`.
    'src/renderer/workers/vectorize.worker.ts',
  ]) {
    assert.ok(names.has(required), `${required} is not in the graph — the resolver is broken`);
  }

  assert.ok(
    [...names].some((n) => n.startsWith('src/engine/')),
    'no engine file in the graph — the @engine alias no longer resolves',
  );
  assert.ok(FILES.size > 20, `the graph is only ${FILES.size} files — the resolver is broken`);
});

test('nothing in the browser build can touch the network', () => {
  const found = [];
  for (const [file, src] of FILES) {
    const code = stripComments(src);
    for (const { name, re } of NETWORK) {
      if (re.test(code)) {
        const line = code.split('\n').findIndex((l) => re.test(l)) + 1;
        found.push(`${rel(file)} uses ${name} (near line ${line} of the stripped source)`);
      }
    }
  }

  assert.deepEqual(
    found,
    [],
    'The browser build reaches the network:\n  ' +
      found.join('\n  ') +
      '\n\nsrc/web/index.html prints a footer inviting the reader to verify this cannot ' +
      'happen, and connect-src \'none\' would block it at runtime — so the visible ' +
      'symptom is a feature that silently does nothing, not an honest error. If this ' +
      'call is deliberate, the page\'s claim and its CSP have to change in the same commit.',
  );
});
