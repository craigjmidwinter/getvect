/**
 * The AI Enhance contract, shared by the main process and the renderer.
 *
 * Only *types and labels* live here. The prompt, the HTTP call and the key
 * store are main-process-only (src/main/aiEnhance.ts) and deliberately not
 * importable from the renderer: the renderer must never be able to read a key,
 * only to ask whether one exists.
 */

/** Providers the app can talk to. `local` is issue #1 and not implemented. */
export type EnhanceProviderId = 'gemini';

export interface EnhanceProviderInfo {
  id: EnhanceProviderId;
  /** What the UI calls it. */
  label: string;
  /** Where the image goes — this is the sentence the privacy notice is built from. */
  destination: string;
  /** Where a user gets a key, shown next to the field. */
  keyUrl: string;
}

export const ENHANCE_PROVIDERS: readonly EnhanceProviderInfo[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    destination: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
];

export const DEFAULT_ENHANCE_PROVIDER: EnhanceProviderId = 'gemini';

export function enhanceProvider(id: string): EnhanceProviderInfo | null {
  return ENHANCE_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Why a run failed, in the terms the UI has to explain it in. Every one of
 * these ends the same way for the user: the un-enhanced image is traced and a
 * message says what went wrong. A hang is not on the list because a hang is not
 * an outcome — `ENHANCE_TIMEOUT_MS` guarantees one of these instead.
 */
export type EnhanceErrorCode =
  | 'no-key' // nothing stored for this provider
  | 'auth' // 401/403 — the key is wrong, revoked or lacks the model
  | 'rate-limit' // 429 / quota
  | 'network' // DNS, offline, TLS, connection reset
  | 'timeout' // ENHANCE_TIMEOUT_MS elapsed
  | 'bad-response' // 200 with no image in it (safety block, text-only reply)
  | 'provider' // any other non-2xx
  | 'storage' // the key could not be read back / decrypted
  | 'unsupported' // unknown provider id
  | 'unknown';

/**
 * The image types a provider is allowed to answer with.
 *
 * Not a formality. `gemini-2.5-flash-image` replies `image/png`;
 * `gemini-3-pro-image-preview` replies **`image/jpeg`** for the same request,
 * and an earlier version of this contract only accepted PNG — so the entire
 * `best` tier came back as "the provider did not return a PNG" while `fast`
 * worked. The type is sniffed from the bytes, never taken from the provider's
 * own label, and travels with the image so the renderer can build the right
 * Blob rather than guessing.
 *
 * JPEG has no alpha channel: a `transparent: true` request answered in JPEG
 * comes back flattened, and there is nothing honest to do about that here
 * (keying out "white" would eat the white *inside* the drawing).
 */
export type EnhanceImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export type EnhanceRunResult =
  | { ok: true; image: Uint8Array; mimeType: EnhanceImageMime }
  | { ok: false; code: EnhanceErrorCode; message: string };

/** Outcome of `setKey` / `clearKey`. Never carries key material. */
export interface EnhanceKeyResult {
  ok: boolean;
  /** Present when `ok` is false — safe to show verbatim. */
  error?: string;
}

/**
 * `fast` = gemini-2.5-flash-image (~8s, cheaper, leaves some soft texture).
 * `best` = gemini-3-pro-image-preview (~20s, pricier, genuinely flat fills) —
 * an A/B on the reference artwork showed the model tier, not the prompt, is
 * what decides flatness.
 */
export type EnhanceQuality = 'fast' | 'best';

export interface EnhanceRunRequest {
  provider: EnhanceProviderId;
  /** PNG bytes of the image to re-illustrate. */
  image: Uint8Array;
  /**
   * True when the source carries meaningful alpha, which switches the prompt
   * from "plain white background" to "fully transparent background".
   */
  transparent: boolean;
  /** Model tier; defaults to 'fast' when omitted. */
  quality?: EnhanceQuality;
}

/** One minute, then we give up and trace the original (never a hang). */
export const ENHANCE_TIMEOUT_MS = 60_000;

/** Human-readable, provider-agnostic wording for a failed run. */
export function describeEnhanceError(code: EnhanceErrorCode, providerLabel: string): string {
  switch (code) {
    case 'no-key':
      return `No ${providerLabel} key is saved — AI Enhance was skipped.`;
    case 'auth':
      return `${providerLabel} rejected the API key (401/403). Check the key and save it again.`;
    case 'rate-limit':
      return `${providerLabel} is rate-limiting or out of quota for this key.`;
    case 'network':
      return `Could not reach ${providerLabel} — check the network connection.`;
    case 'timeout':
      return `${providerLabel} did not answer within ${Math.round(ENHANCE_TIMEOUT_MS / 1000)}s.`;
    case 'bad-response':
      return `${providerLabel} replied without an image (the request may have been blocked).`;
    case 'provider':
      return `${providerLabel} returned an error.`;
    case 'storage':
      // Almost always recoverable, and the recovery is not guessable: the OS
      // keystore no longer holds the secret this key was encrypted with (a
      // renamed application, a restored home directory, a new keychain), so
      // the ciphertext on disk is dead and the only cure is to save it again.
      return 'The saved key could not be decrypted on this machine — save the key again.';
    case 'unsupported':
      return 'That AI Enhance provider is not available in this build.';
    default:
      return 'AI Enhance failed for an unknown reason.';
  }
}
