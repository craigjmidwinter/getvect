/**
 * AI Enhance — the one part of GetVect that can talk to the network, and only
 * when the user turns it on and supplies their own key.
 *
 * WHAT IT IS. The real the reference product's "Enhance with AI" is not a filter: it is
 * a generative image-to-image re-illustration pass that removes the background,
 * flattens soft shading into bands and regularizes outlines, after which the
 * tracer is tracing already-flat art (the finding is recorded in
 * `fixtures/reference/OBSERVED-UI.md`). This module reproduces that step by
 * asking an image model for the same thing in words. Everything downstream —
 * the whole of `src/engine` — is unchanged and still pure: enhance hands back a
 * bitmap, and a bitmap is all the engine has ever taken.
 *
 * WHERE THE KEY LIVES. Here, and nowhere else. It is written to
 * `app.getPath('userData')` encrypted with Electron's `safeStorage` (Keychain
 * on macOS, libsecret/DPAPI elsewhere), it is never returned over IPC, never
 * logged, never put in renderer state and never written to localStorage. The
 * renderer's entire view of it is the boolean `hasKey()` answers.
 *
 * ADDING A PROVIDER. Implement `EnhanceProvider`, add its id to
 * `EnhanceProviderId` in src/shared/aiEnhance.ts and list it in
 * `ENHANCE_PROVIDERS`. The key store, the IPC surface, the timeout and the
 * fallback behaviour are provider-agnostic on purpose: the fully-local backend
 * tracked in issue #1 is meant to arrive as one more entry in `PROVIDERS`, not
 * as a second pipeline.
 */
import { app, ipcMain, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  ENHANCE_TIMEOUT_MS,
  enhanceProvider,
  type EnhanceErrorCode,
  type EnhanceKeyResult,
  type EnhanceProviderId,
  type EnhanceQuality,
  type EnhanceRunRequest,
  type EnhanceRunResult,
} from '../shared/aiEnhance';

const isE2E = process.env.GETVECT_E2E === '1';

// --- the prompt ------------------------------------------------------------

/**
 * The instruction, verbatim and A/B-validated.
 *
 * Do not "improve" this without re-running the comparison. Describing the
 * *operations* ("remove the background, posterize the shading, thicken the
 * outlines") measurably underperforms naming the *artifact* — asking for a flat
 * vector graphic gets flat vector art, because that is a thing the model has
 * seen a great deal of and a set of edits is not.
 */
export const VECTOR_PROMPT =
  'Convert this image into a flat vector graphic, exactly as it would look exported from an ' +
  'SVG illustration tool: a limited palette of solid flat color fills, hard clean region ' +
  'boundaries, absolutely no gradients, no airbrushing, no texture, no photographic shading, ' +
  "uniform-weight outlines, plain white background. Preserve the subject's pose, " +
  'proportions, expression and composition exactly. No text.';

/** What "plain white background" becomes when the source has real alpha. */
const TRANSPARENT_CLAUSE = 'fully transparent background (output PNG with alpha)';
const OPAQUE_CLAUSE = 'plain white background';

/**
 * A sticker with a transparent background must not come back on white — that
 * is REFERENCE's whole sticker/decal use case, and flattening it would be a
 * silent, unrecoverable change to the artwork. If the provider ignores the
 * instruction and returns an opaque image we leave it: inventing an alpha
 * channel by keying out "white" is exactly the kind of guess that eats the
 * white *inside* a drawing.
 */
export function promptFor(transparent: boolean): string {
  return transparent ? VECTOR_PROMPT.replace(OPAQUE_CLAUSE, TRANSPARENT_CLAUSE) : VECTOR_PROMPT;
}

// --- provider interface ----------------------------------------------------

export interface EnhanceRequest {
  /** PNG bytes of the image to re-illustrate. */
  image: Uint8Array;
  /** Source has meaningful alpha (drives the background clause of the prompt). */
  transparent: boolean;
  /** The user's key for this provider. Never leaves this process. */
  apiKey: string;
  /** Aborted at `ENHANCE_TIMEOUT_MS`. */
  signal: AbortSignal;
  /** Model tier; providers default to 'fast' when omitted. */
  quality?: EnhanceQuality;
}

export interface EnhanceProvider {
  readonly id: EnhanceProviderId;
  /** Re-illustrate `image`, returning PNG bytes. Throws `EnhanceError`. */
  enhance(request: EnhanceRequest): Promise<Uint8Array>;
}

/** A failure with a code the UI can turn into a specific sentence. */
export class EnhanceError extends Error {
  constructor(
    readonly code: EnhanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnhanceError';
  }
}

// --- gemini ----------------------------------------------------------------

/**
 * Model per quality tier. The A/B on the reference artwork was unambiguous:
 * flash leaves soft texture the tracer then has to band; the pro model returns
 * genuinely flat single-colour fills with the same prompt. Speed/cost decides,
 * not capability of the prompt.
 */
const GEMINI_MODELS: Record<'fast' | 'best', string> = {
  fast: 'gemini-2.5-flash-image',
  best: 'gemini-3-pro-image-preview',
};

function geminiEndpoint(quality: 'fast' | 'best'): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS[quality]}:generateContent`;
}

/**
 * ~8s (fast) / ~20s (best) on a 1024px source in our own measurements.
 *
 * The key travels in the `x-goog-api-key` header rather than a `?key=` query
 * parameter so it cannot end up in a redirect, a proxy log or an error string
 * that quotes the URL.
 */
const gemini: EnhanceProvider = {
  id: 'gemini',
  async enhance({ image, transparent, apiKey, signal, quality = 'fast' }): Promise<Uint8Array> {
    const body = JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/png', data: Buffer.from(image).toString('base64') } },
            { text: promptFor(transparent) },
          ],
        },
      ],
      generationConfig: { responseModalities: ['IMAGE'] },
    });

    let response: Response;
    try {
      response = await fetch(geminiEndpoint(quality), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal,
      });
    } catch (error) {
      // An abort here is the timeout; anything else is the network being gone.
      if (signal.aborted) throw new EnhanceError('timeout', 'the request timed out');
      throw new EnhanceError('network', redact(messageOf(error), apiKey));
    }

    if (!response.ok) {
      const detail = redact(await textOf(response), apiKey);
      throw new EnhanceError(statusCode(response.status), `HTTP ${response.status}: ${detail}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new EnhanceError('bad-response', redact(messageOf(error), apiKey));
    }

    const png = firstInlineImage(json);
    if (!png) {
      throw new EnhanceError('bad-response', 'the response carried no inline image data');
    }
    return png;
  },
};

function statusCode(status: number): EnhanceErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  return 'provider';
}

/**
 * `candidates[0].content.parts[*].inlineData.data`, base64 PNG.
 *
 * Both spellings are accepted because the REST API takes `inline_data` on the
 * way in and answers with `inlineData` — a response shape that changes case
 * between request and reply is exactly the kind of thing that should not turn
 * into a silent "no image" in six months.
 */
function firstInlineImage(json: unknown): Uint8Array | null {
  const candidates = (json as { candidates?: unknown[] } | null)?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown[] } } | null)?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const blob = part as { inlineData?: { data?: string }; inline_data?: { data?: string } };
      const data = blob?.inlineData?.data ?? blob?.inline_data?.data;
      if (typeof data === 'string' && data.length > 0) return new Uint8Array(Buffer.from(data, 'base64'));
    }
  }
  return null;
}

async function textOf(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return response.statusText;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Belt and braces: no provider we use puts the key in an error body, but an
 * error body is the one string from this module that reaches the UI, and
 * "never log the key" has to survive a provider changing its mind.
 */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

// --- the e2e stub ----------------------------------------------------------

/**
 * Deterministic local stand-in, used **only** under `GETVECT_E2E=1`.
 *
 * The acceptance suite must run with no network at all, so under e2e the
 * provider — and only the provider — is swapped: the IPC surface, the key
 * store, the timeout, the decode of the returned PNG and the fallback on
 * failure are the same code the product runs. This is the same arrangement as
 * the export dialog (`export:save` in main.ts): one env-var branch, in the main
 * process, around the part a headless run cannot perform.
 *
 * It returns a fixed 256x160 four-colour PNG — a size no fixture has and a
 * palette no fixture contains — so "the working image was replaced by the
 * enhanced one" is an assertion about the traced document rather than a vibe.
 *
 * Two hooks, both keyed off the *stored key* so a spec can drive them entirely
 * through the UI: a key of `fail-auth` / `fail-network` / `fail-timeout` /
 * `fail-bad-response` makes the run fail with that code, and
 * `GETVECT_AI_STUB_DELAY_MS` widens the window in which the in-flight state is
 * observable.
 */
export const STUB_WIDTH = 256;
export const STUB_HEIGHT = 160;
/** The four flat colours the stub PNG is made of, in quadrant order. */
export const STUB_COLORS = [
  { r: 0xd6, g: 0x45, b: 0x45 },
  { r: 0x2f, g: 0xa3, b: 0x9b },
  { r: 0xf2, g: 0xe7, b: 0xd5 },
  { r: 0x1b, g: 0x1f, b: 0x2a },
] as const;

const stub: EnhanceProvider = {
  id: 'gemini',
  async enhance({ apiKey, signal }): Promise<Uint8Array> {
    const delay = Number(process.env.GETVECT_AI_STUB_DELAY_MS ?? '250');
    await sleep(Number.isFinite(delay) && delay > 0 ? delay : 0, signal);
    const forced = /^fail-([a-z-]+)$/.exec(apiKey.trim());
    if (forced) throw new EnhanceError(forced[1] as EnhanceErrorCode, `stub failure: ${forced[1]}`);
    return stubPng();
  },
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new EnhanceError('timeout', 'the request timed out'));
      },
      { once: true },
    );
  });
}

let stubCache: Uint8Array | null = null;

function stubPng(): Uint8Array {
  if (stubCache) return stubCache;
  const rgba = new Uint8Array(STUB_WIDTH * STUB_HEIGHT * 4);
  for (let y = 0; y < STUB_HEIGHT; y++) {
    for (let x = 0; x < STUB_WIDTH; x++) {
      const quadrant = (y < STUB_HEIGHT / 2 ? 0 : 2) + (x < STUB_WIDTH / 2 ? 0 : 1);
      const color = STUB_COLORS[quadrant];
      const at = (y * STUB_WIDTH + x) * 4;
      rgba[at] = color.r;
      rgba[at + 1] = color.g;
      rgba[at + 2] = color.b;
      rgba[at + 3] = 255;
    }
  }
  stubCache = encodePng(STUB_WIDTH, STUB_HEIGHT, rgba);
  return stubCache;
}

/** Minimal RGBA PNG writer (filter 0 on every row) — deterministic by construction. */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- provider registry -----------------------------------------------------

const PROVIDERS: Record<EnhanceProviderId, EnhanceProvider> = { gemini };

function providerFor(id: EnhanceProviderId): EnhanceProvider | null {
  // Under e2e every provider resolves to the offline stub; the suite must never
  // depend on a network, a key or a bill.
  if (isE2E) return stub;
  return PROVIDERS[id] ?? null;
}

// --- key store -------------------------------------------------------------

interface StoredKeys {
  version: 1;
  keys: Partial<Record<EnhanceProviderId, { enc: 'safeStorage' | 'e2e-plain'; data: string }>>;
}

/**
 * Where the encrypted keys live.
 *
 * Under e2e it is a test-scoped directory (`GETVECT_AI_DIR`, a temp dir the
 * Playwright fixture makes and deletes), so a test run can never read, write or
 * clobber the real one — and `safeStorage` is not touched at all, because on
 * macOS it reaches into the login keychain and an unsigned Electron under test
 * would either prompt or fail.
 */
function keyStoreDir(): string {
  if (isE2E) return process.env.GETVECT_AI_DIR || path.join(app.getPath('temp'), 'getvect-e2e-ai');
  return app.getPath('userData');
}

function keyStorePath(): string {
  return path.join(keyStoreDir(), isE2E ? 'ai-keys.e2e.json' : 'ai-keys.enc.json');
}

async function readStore(): Promise<StoredKeys> {
  try {
    const text = await fs.readFile(keyStorePath(), 'utf8');
    const parsed = JSON.parse(text) as StoredKeys;
    if (parsed && parsed.version === 1 && parsed.keys) return parsed;
  } catch {
    /* no store yet, or it is unreadable — treat as empty */
  }
  return { version: 1, keys: {} };
}

async function writeStore(store: StoredKeys): Promise<void> {
  const dir = keyStoreDir();
  await fs.mkdir(dir, { recursive: true });
  // 0600: the ciphertext is not a secret on its own, but there is no reason for
  // it to be world-readable either.
  await fs.writeFile(keyStorePath(), JSON.stringify(store), { mode: 0o600 });
}

/** True when this machine can encrypt at rest (see `setKey`'s refusal). */
function encryptionAvailable(): boolean {
  if (isE2E) return true;
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function setKey(id: EnhanceProviderId, key: string): Promise<EnhanceKeyResult> {
  if (!enhanceProvider(id)) return { ok: false, error: 'Unknown provider.' };
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: 'Enter an API key first.' };
  if (!encryptionAvailable()) {
    // Refusing is the whole point: writing it in the clear would quietly turn
    // "your key is encrypted at rest" into a false statement on the machines
    // where it matters most.
    return {
      ok: false,
      error:
        'This machine has no OS keystore available (Electron safeStorage), so the key cannot be ' +
        'encrypted at rest. GetVect will not store it in the clear.',
    };
  }
  const store = await readStore();
  store.keys[id] = isE2E
    ? { enc: 'e2e-plain', data: Buffer.from(trimmed, 'utf8').toString('base64') }
    : { enc: 'safeStorage', data: safeStorage.encryptString(trimmed).toString('base64') };
  await writeStore(store);
  return { ok: true };
}

export async function clearKey(id: EnhanceProviderId): Promise<EnhanceKeyResult> {
  const store = await readStore();
  delete store.keys[id];
  await writeStore(store);
  return { ok: true };
}

export async function hasKey(id: EnhanceProviderId): Promise<boolean> {
  const store = await readStore();
  const entry = store.keys[id];
  return Boolean(entry && entry.data);
}

/**
 * Decrypt one key. Private on purpose: this value never crosses the IPC
 * boundary, and the only caller is `runEnhance` below.
 */
async function readKey(id: EnhanceProviderId): Promise<string | null> {
  const entry = (await readStore()).keys[id];
  if (!entry?.data) return null;
  try {
    if (entry.enc === 'e2e-plain') return Buffer.from(entry.data, 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
  } catch {
    return null;
  }
}

// --- run -------------------------------------------------------------------

/**
 * One enhancement. Always resolves: every failure comes back as a typed result
 * so the renderer can fall back to the un-enhanced image and say why. A caller
 * that never gets an answer is the one outcome this must not have, which is
 * what `ENHANCE_TIMEOUT_MS` is for.
 */
/**
 * Opt-in debugging: when GETVECT_AI_DEBUG_DIR is set, every successful enhance
 * writes its exact input, output and a small metadata file there so a bad
 * result can be inspected after the fact. Never on by default — these are the
 * user's images being written to disk.
 */
async function debugDump(
  provider: EnhanceProviderId,
  quality: EnhanceQuality,
  transparent: boolean,
  durationMs: number,
  input: Uint8Array,
  output: Uint8Array,
): Promise<void> {
  const dir = process.env.GETVECT_AI_DEBUG_DIR;
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `${stamp}-input.png`), input);
    await fs.writeFile(path.join(dir, `${stamp}-output.png`), output);
    await fs.writeFile(
      path.join(dir, `${stamp}-meta.json`),
      JSON.stringify({ provider, model: GEMINI_MODELS[quality], quality, transparent, durationMs, inputBytes: input.length, outputBytes: output.length }, null, 2),
    );
  } catch {
    // Debugging must never break the feature.
  }
}

export async function runEnhance(request: EnhanceRunRequest): Promise<EnhanceRunResult> {
  const info = enhanceProvider(request.provider);
  const provider = info ? providerFor(request.provider) : null;
  if (!info || !provider) return { ok: false, code: 'unsupported', message: 'unknown provider' };

  const hasStored = await hasKey(request.provider);
  if (!hasStored) return { ok: false, code: 'no-key', message: 'no key stored' };
  const apiKey = await readKey(request.provider);
  if (!apiKey) return { ok: false, code: 'storage', message: 'the stored key could not be read' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS);
  try {
    const input = request.image instanceof Uint8Array ? request.image : new Uint8Array(request.image);
    const quality: EnhanceQuality = request.quality === 'best' ? 'best' : 'fast';
    const started = Date.now();
    const image = await provider.enhance({
      image: input,
      transparent: Boolean(request.transparent),
      apiKey,
      signal: controller.signal,
      quality,
    });
    if (!looksLikePng(image)) {
      return { ok: false, code: 'bad-response', message: 'the provider did not return a PNG' };
    }
    await debugDump(request.provider, quality, Boolean(request.transparent), Date.now() - started, input, image);
    return { ok: true, image };
  } catch (error) {
    if (error instanceof EnhanceError) return { ok: false, code: error.code, message: error.message };
    if (controller.signal.aborted) return { ok: false, code: 'timeout', message: 'timed out' };
    return { ok: false, code: 'unknown', message: redact(messageOf(error), apiKey) };
  } finally {
    clearTimeout(timer);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

// --- IPC -------------------------------------------------------------------

/**
 * The whole renderer-facing surface. Note what is absent: there is no
 * `getKey`. The renderer can save one, clear one and ask whether one exists,
 * and that is the complete list.
 */
export function registerAiEnhanceIpc(): void {
  ipcMain.handle('aiEnhance:setKey', (_e, provider: EnhanceProviderId, key: string) =>
    setKey(provider, typeof key === 'string' ? key : ''),
  );
  ipcMain.handle('aiEnhance:clearKey', (_e, provider: EnhanceProviderId) => clearKey(provider));
  ipcMain.handle('aiEnhance:hasKey', (_e, provider: EnhanceProviderId) => hasKey(provider));
  ipcMain.handle('aiEnhance:run', (_e, request: EnhanceRunRequest) => runEnhance(request));
  ipcMain.handle('aiEnhance:available', () => encryptionAvailable());
}
