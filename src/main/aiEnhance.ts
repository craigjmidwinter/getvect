/**
 * AI Enhance — the one part of GetVect that can talk to the network, and only
 * when the user turns it on and supplies their own key.
 *
 * WHAT IT IS. The reference product's "Enhance with AI" is not a filter: it is
 * a generative image-to-image re-illustration pass that removes the background,
 * flattens soft shading into bands and regularizes outlines, after which the
 * tracer is tracing already-flat art (the finding is recorded in
 * REFERENCE B4). This module reproduces that step by
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
  type EnhanceImageMime,
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
  /**
   * Re-illustrate `image`, returning encoded image bytes in whatever format the
   * provider chose — `runEnhance` sniffs the type; it is not the provider's job
   * to promise one. Throws `EnhanceError`.
   */
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
 *
 * `responseModalities: ['IMAGE']` is asked for, not assumed: the two tiers
 * answer in different *shapes*. Flash returns one `inlineData` part of PNG;
 * the pro model returns an `inlineData` part of **JPEG** carrying a
 * `thoughtSignature`, sometimes behind text parts. Nothing downstream may
 * assume part order or PNG (see `firstInlineImage` and `sniffImageMime`).
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

    const returned = firstInlineImage(json);
    if (!returned) {
      throw new EnhanceError('bad-response', `the response carried no image (${whyNoImage(json)})`);
    }
    return returned;
  },
};

function statusCode(status: number): EnhanceErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  return 'provider';
}

/**
 * The first inline image anywhere in the reply, as raw bytes.
 *
 * Deliberately forgiving about everything except "are there bytes":
 *
 * - **Both spellings.** The REST API takes `inline_data` on the way in and
 *   answers with `inlineData`; a shape that changes case between request and
 *   reply must not turn into a silent "no image" in six months.
 * - **Any position, any candidate.** The pro tier interleaves `text` and
 *   thought parts, so this scans rather than reading `parts[0]`.
 * - **No `content` assumed.** A safety-blocked candidate has a `finishReason`
 *   and no `content` at all; reading `candidate.content.parts` unguarded is
 *   the crash we already hit once on flash.
 * - **No mime assumed.** The label the provider attaches is ignored entirely —
 *   `sniffImageMime` reads the magic bytes, because the label is the provider's
 *   claim and the bytes are the fact.
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

/**
 * Why a 200 came back with no picture in it, in the provider's own words.
 *
 * "The provider replied without an image" is true and useless; a safety block,
 * a `MAX_TOKENS` stop and a text-only answer are three different problems with
 * three different fixes, and the reply says which it was.
 */
function whyNoImage(json: unknown): string {
  const reply = json as {
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: unknown[] } }[];
  } | null;
  const blocked = reply?.promptFeedback?.blockReason;
  if (blocked) return `blocked: ${blocked}`;
  const candidate = reply?.candidates?.[0];
  if (!candidate) return 'no candidates';
  const parts = candidate.content?.parts;
  const kinds = Array.isArray(parts)
    ? [...new Set(parts.map((p) => Object.keys(p as object).join('+')))].join(', ')
    : 'no parts';
  return `finishReason ${candidate.finishReason ?? 'unset'}, parts: ${kinds}`;
}

/**
 * The image type of `bytes`, from their magic number — `null` if this is not
 * an image format the renderer can decode.
 *
 * This replaced a PNG-signature check that rejected everything else. That check
 * was written when the only tier was flash (which answers PNG) and it silently
 * condemned the entire `best` tier the day it was added: `gemini-3-pro-image-preview`
 * answers **JPEG**, so every Best run ended in `bad-response`. The lesson is in
 * the shape of this function — decide what the bytes *are*, do not assert what
 * they must be.
 */
function sniffImageMime(bytes: Uint8Array): EnhanceImageMime | null {
  if (bytes.length < 12) return null;
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return 'image/webp';
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
 * Three hooks, all keyed off the *stored key* so a spec can drive them entirely
 * through the UI: a key of `fail-auth` / `fail-network` / `fail-timeout` /
 * `fail-bad-response` makes the run fail with that code, a key of `reply-jpeg`
 * answers in JPEG instead of PNG (see `STUB_JPEG`), and
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

/**
 * The stub's JPEG reply: a 192x128 four-colour baseline JPEG, checked in as a
 * constant because the main process has no encoder and a canned blob is the
 * only way to be byte-identical on every machine.
 *
 * It exists because of a real outage. `gemini-2.5-flash-image` answers PNG and
 * `gemini-3-pro-image-preview` answers **JPEG**; a PNG-only guard in
 * `runEnhance` therefore failed 100% of `best` runs with "the provider did not
 * return a PNG" while every stub-driven spec stayed green, because the stub
 * only ever spoke PNG. A test double that can only produce the shape the code
 * already handles is not a test double.
 */
const STUB_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/' +
  '2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAAR' +
  'CACAAMADAREAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAUJCP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAZAQEAAwEB' +
  'AAAAAAAAAAAAAAAABAUGCAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCUpHqQAAAAAAAAAACo1rmwAAAA' +
  'AAAAAABLZJ0mAAAAAAAAAAAqNa5sAAAAAAAAAAAS2SdJgAAAAAAAAAAKjWubAAAAAAAAAAAEtknSYAAAAAAAAAACo1rmwAAA' +
  'AAAAAAABLZJ0mAAAAAAAAAAAqNa5sAAAAAAAAAAAS2SdJgAAAAAAAAAAKjWubAAAAAAAAAAAEtknSYAAAAAAAAAACo1rmwAA' +
  'AAAAAAAABLZJ0mAAAAAAAAAAAqNa5sAAAAAAAAAAAdGKB6SAAAAAAAAAAAzzWiIAAAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIA' +
  'AAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIAAAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIAAAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIA' +
  'AAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIAAAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIAAAAAAAAAAA0MVaWAAAAAAAAAAAzzWiIA' +
  'AAAAAAAAAA//2Q==';

/** Dimensions of `STUB_JPEG_BASE64`, so a spec can name them. */
export const STUB_JPEG_WIDTH = 192;
export const STUB_JPEG_HEIGHT = 128;

const stub: EnhanceProvider = {
  id: 'gemini',
  async enhance({ apiKey, signal }): Promise<Uint8Array> {
    const delay = Number(process.env.GETVECT_AI_STUB_DELAY_MS ?? '250');
    await sleep(Number.isFinite(delay) && delay > 0 ? delay : 0, signal);
    const forced = /^fail-([a-z-]+)$/.exec(apiKey.trim());
    if (forced) throw new EnhanceError(forced[1] as EnhanceErrorCode, `stub failure: ${forced[1]}`);
    if (apiKey.trim() === 'reply-jpeg') return new Uint8Array(Buffer.from(STUB_JPEG_BASE64, 'base64'));
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

/**
 * Is there a key here that this machine can actually *use*?
 *
 * Not "is there a file with bytes in it" — that question has a different, and
 * misleading, answer. Electron's `safeStorage` on macOS encrypts against a
 * Keychain secret named after the application; rename the app (or restore a
 * home directory onto a new machine, or lose the login keychain) and the
 * ciphertext on disk survives while the secret that opens it does not. Answering
 * `true` there leaves the UI saying "Key saved" over an armed switch that fails
 * on every single run with a message about storage — which is exactly what
 * happened when the app was renamed from `getvect` to `GetVect`.
 *
 * So this decrypts. Nothing is deleted: the dead ciphertext is harmless and
 * throwing away a user's bytes on a heuristic is worse than ignoring them. The
 * next `setKey` overwrites it.
 */
export async function hasKey(id: EnhanceProviderId): Promise<boolean> {
  return (await loadKey(id)).kind === 'ok';
}

/**
 * The three states a stored key can be in — `none` and `unreadable` are
 * different problems with different sentences, and collapsing them is how a
 * dead ciphertext gets reported as "no key stored".
 *
 * Private on purpose: the key itself never crosses the IPC boundary, and the
 * only callers are `hasKey` and `runEnhance` in this file.
 */
type StoredKey = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'ok'; key: string };

async function loadKey(id: EnhanceProviderId): Promise<StoredKey> {
  const entry = (await readStore()).keys[id];
  if (!entry?.data) return { kind: 'none' };
  try {
    const key =
      entry.enc === 'e2e-plain'
        ? Buffer.from(entry.data, 'base64').toString('utf8')
        : safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
    return key ? { kind: 'ok', key } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
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
 * Opt-in debugging: when GETVECT_AI_DEBUG_DIR is set, an enhance writes its
 * exact input and a small metadata file there — plus the output, when there was
 * one — so a bad result can be inspected after the fact. Never on by default:
 * these are the user's images being written to disk.
 *
 * **Failures dump too, and they are the reason this exists.** A run that
 * succeeded and looks wrong can at least be reproduced from the picture on the
 * screen; a run that failed leaves one sentence in a toast, and the two
 * questions that sentence cannot answer are "what exactly did we send" and
 * "which failure was it". So a failed run writes the input it was given and a
 * `meta.json` carrying `ok: false`, the typed `code` and the message — and no
 * output file, because there is no output. `message` has already been through
 * `redact`, so no key material reaches the disk.
 */
async function debugDump(
  provider: EnhanceProviderId,
  quality: EnhanceQuality,
  transparent: boolean,
  durationMs: number,
  input: Uint8Array,
  result:
    | { ok: true; output: Uint8Array; mimeType: EnhanceImageMime }
    | { ok: false; code: EnhanceErrorCode; message: string },
): Promise<void> {
  const dir = process.env.GETVECT_AI_DEBUG_DIR;
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const label = result.ok ? stamp : `${stamp}-failed`;
    await fs.writeFile(path.join(dir, `${label}-input.png`), input);
    if (result.ok) {
      const extension = result.mimeType.slice('image/'.length);
      await fs.writeFile(path.join(dir, `${label}-output.${extension}`), result.output);
    }
    await fs.writeFile(
      path.join(dir, `${label}-meta.json`),
      JSON.stringify(
        {
          ok: result.ok,
          provider,
          model: GEMINI_MODELS[quality],
          quality,
          transparent,
          durationMs,
          inputBytes: input.length,
          ...(result.ok
            ? { mimeType: result.mimeType, outputBytes: result.output.length }
            : { code: result.code, message: result.message }),
        },
        null,
        2,
      ),
    );
  } catch {
    // Debugging must never break the feature.
  }
}

export async function runEnhance(request: EnhanceRunRequest): Promise<EnhanceRunResult> {
  const info = enhanceProvider(request.provider);
  const provider = info ? providerFor(request.provider) : null;
  if (!info || !provider) return { ok: false, code: 'unsupported', message: 'unknown provider' };

  const stored = await loadKey(request.provider);
  if (stored.kind === 'none') return { ok: false, code: 'no-key', message: 'no key stored' };
  if (stored.kind === 'unreadable') {
    return { ok: false, code: 'storage', message: 'the stored key could not be decrypted' };
  }
  const apiKey = stored.key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS);
  const input = request.image instanceof Uint8Array ? request.image : new Uint8Array(request.image);
  const quality: EnhanceQuality = request.quality === 'best' ? 'best' : 'fast';
  const started = Date.now();
  /**
   * Every exit from here that is not a success goes through this, so a failure
   * is as inspectable as a success. It is the one that needs to be: a failed run
   * leaves nothing behind but a sentence in a toast.
   *
   * `debugDump` is a no-op without `GETVECT_AI_DEBUG_DIR` and swallows its own
   * errors, so awaiting it cannot change what the caller gets.
   */
  const failed = async (
    code: EnhanceErrorCode,
    message: string,
  ): Promise<EnhanceRunResult> => {
    await debugDump(request.provider, quality, Boolean(request.transparent), Date.now() - started, input, {
      ok: false,
      code,
      message,
    });
    return { ok: false, code, message };
  };
  try {
    const image = await provider.enhance({
      image: input,
      transparent: Boolean(request.transparent),
      apiKey,
      signal: controller.signal,
      quality,
    });
    const mimeType = sniffImageMime(image);
    if (!mimeType) {
      return await failed(
        'bad-response',
        `the provider returned ${image.length} bytes that are not a PNG, JPEG or WebP`,
      );
    }
    await debugDump(request.provider, quality, Boolean(request.transparent), Date.now() - started, input, {
      ok: true,
      output: image,
      mimeType,
    });
    return { ok: true, image, mimeType };
  } catch (error) {
    if (error instanceof EnhanceError) return await failed(error.code, error.message);
    if (controller.signal.aborted) return await failed('timeout', 'timed out');
    return await failed('unknown', redact(messageOf(error), apiKey));
  } finally {
    clearTimeout(timer);
  }
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
