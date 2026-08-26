/**
 * NOTHING MAY OPEN THE OS KEYCHAIN BEFORE THE USER ASKS FOR IT.
 *
 * `safeStorage.isEncryptionAvailable()` reads nothing and writes nothing, and on
 * macOS it makes Electron reach into the login keychain — which the OS answers
 * with a password prompt. So a call that reads like a capability query has, on
 * one platform, the side effect of demanding the user's password.
 *
 * It was called from a mount effect, to decide whether to grey out one switch.
 *
 * BE PRECISE ABOUT THE SEVERITY, because the first version of this file was not.
 * It claimed every user gets a prompt on first launch. That is wrong. Whether a
 * dialog appears depends on keychain ACL state: on a fresh machine the signed
 * app creates the item itself and is on its own ACL, so macOS has no reason to
 * ask. A prompt appears when something ELSE is already on that item — most
 * plausibly a dev build identifying as `Electron` beside the packaged app,
 * which is what produced the original report.
 *
 * The defect is that the answer DEPENDS on a user's keychain history, which is
 * invisible to us and untestable from here. Deferring the question removes the
 * dependence rather than betting on ACL behaviour, and for a tool whose pitch is
 * no account and nothing leaving your machine, that is the one prompt not worth
 * gambling on.
 *
 * WHY THESE ARE SOURCE ASSERTIONS AND NOT A BEHAVIOURAL TEST. The obvious test —
 * launch it and assert no prompt appears — PASSES ON ANY MACHINE WHERE ACCESS
 * WAS ALREADY GRANTED, which is every machine that has run this app. It would be
 * a green control that cannot fail, of exactly the kind this repo keeps finding,
 * and it fooled a careful reviewer once already. Verifying the behaviour for
 * real needs a clean keychain state, which cannot be arranged here without
 * destroying a keychain item that may hold someone's API key. So the boundary is
 * asserted in the source, where it can actually fail, and the untested part is
 * named rather than faked. What they pin: the expensive call has exactly one
 * home, the cheap answer must not reach it, and the renderer's mount path must
 * not ask the expensive question.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/**
 * Source with comments removed.
 *
 * The first version of this file counted `isEncryptionAvailable(` across the raw
 * text and failed on correct code, because the paragraph explaining the hazard
 * names the function. A detector that reads prose as code reports a defect that
 * is not there — the friendlier failure of the two, but still a detector that
 * has to be argued with rather than trusted.
 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The body of a top-level `function name(...)` declaration, brace-matched. */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone — this test is guarding something that moved`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

test('only one function may touch safeStorage capability at all', () => {
  const src = code('src/main/aiEnhance.ts');
  const calls = [...src.matchAll(/isEncryptionAvailable\s*\(/g)];
  assert.equal(
    calls.length,
    1,
    `isEncryptionAvailable() is called ${calls.length} times; it must have exactly one ` +
      'call site so there is one place to reason about the prompt',
  );
  assert.ok(
    functionBody(src, 'encryptionAvailable').includes('isEncryptionAvailable('),
    'the single call site must be encryptionAvailable(), which is documented as prompting',
  );
});

test('the cheap answer never reaches the keychain', () => {
  const src = code('src/main/aiEnhance.ts');
  const body = functionBody(src, 'encryptionLikelyAvailable');
  assert.ok(
    !body.includes('safeStorage'),
    'encryptionLikelyAvailable touches safeStorage — it exists precisely so the mount ' +
      'path has an answer that costs nothing',
  );
  assert.ok(
    !/\bencryptionAvailable\s*\(/.test(body),
    'encryptionLikelyAvailable calls encryptionAvailable, which reintroduces the prompt ' +
      'through one more layer of indirection',
  );
});

test('the mount-time key lookup does not decrypt', () => {
  // The half that was nearly missed, and the one where the asymmetry bites. On
  // a machine with no key, loadKey returns before it touches safeStorage — so a
  // clean machine cannot show the problem at all, and a fix verified there looks
  // complete. On a machine that HAS a key, answering "is a key saved" by
  // decrypting reaches the keychain, which is where an ACL mismatch can surface
  // a dialog. Exactly the users who adopted the feature are the ones who could
  // meet it.
  const src = code('src/main/aiEnhance.ts');
  assert.match(
    src,
    // `[^)]*` cannot cross the arrow function's own parameter list, so it never
    // reached the handler body and failed on correct code.
    /ipcMain\.handle\('aiEnhance:hasKey',[\s\S]{0,140}?hasStoredKey\(/,
    "'aiEnhance:hasKey' must resolve to hasStoredKey, which reads the file; hasKey decrypts",
  );
  assert.ok(
    !functionBody(src, 'hasStoredKey').includes('safeStorage'),
    'hasStoredKey touches safeStorage — it exists so the mount path never decrypts',
  );
});

test('the startup IPC is wired to the cheap function, the prompting one to its own channel', () => {
  const src = read('src/main/aiEnhance.ts');
  assert.match(
    src,
    /ipcMain\.handle\('aiEnhance:available',\s*\(\)\s*=>\s*encryptionLikelyAvailable\(\)\)/,
    "'aiEnhance:available' is what the renderer calls at mount; it must resolve to the " +
      'keychain-free answer',
  );
  assert.match(
    src,
    /ipcMain\.handle\('aiEnhance:checkStorage',\s*\(\)\s*=>\s*encryptionAvailable\(\)\)/,
    'the real check needs its own channel so the mount path cannot reach it by accident',
  );
});

test('the renderer asks the expensive question only from a user action', () => {
  // Comments stripped, for the second time in this file: the mount effect now
  // carries a paragraph explaining why it must NOT call checkStorage, and that
  // paragraph names checkStorage. Matched against raw text, the warning about
  // the bug reads as the bug.
  const src = code('src/renderer/App.tsx');

  // `engageStorage` is the only permitted caller, and it must be reached from a
  // real interaction rather than from a lifecycle effect.
  const uses = [...src.matchAll(/checkStorage\s*\(/g)];
  assert.ok(uses.length > 0, 'nothing calls checkStorage — the capability warning would never appear');
  const engage = src.slice(src.indexOf('const engageStorage'), src.indexOf('const engageStorage') + 600);
  assert.ok(
    engage.includes('checkStorage('),
    'checkStorage moved out of engageStorage; keep one gatekeeper for the prompt',
  );

  assert.match(src, /onFocus=\{engageStorage\}/, 'focusing the key field must be an engagement point');
  assert.match(src, /engageStorage\(\);/, 'switching Enhance on must be an engagement point');

  // The mount effect that caused this must not call it. It is identified by the
  // hasKey lookup it still legitimately performs.
  const mountStart = src.indexOf('void bridge.aiEnhance.hasKey(aiProvider)');
  assert.notEqual(mountStart, -1, 'the mount effect moved — re-point this guard');
  // Bound the slice by the effect's own dependency array, not by a character
  // count. A fixed 900 ran past the end of the effect and swallowed the
  // `engageStorage` definition below it, so this reported the bug it was written
  // to catch, on code that had already fixed it.
  const mountEnd = src.indexOf('}, [aiProvider]);', mountStart);
  assert.notEqual(mountEnd, -1, 'the mount effect no longer ends with [aiProvider] — re-point this guard');
  const mountEffect = src.slice(mountStart, mountEnd);
  assert.ok(
    !mountEffect.includes('checkStorage('),
    'the mount effect calls checkStorage again — that is the original bug, restored',
  );
});
