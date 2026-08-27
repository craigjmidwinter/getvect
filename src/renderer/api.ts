/**
 * Typed view of the preload bridge (`window.getvect`, see src/main/preload.ts).
 *
 * Declared locally rather than imported from the main-process source so the
 * renderer tsconfig never has to pull in Electron's typings.
 */
import type {
  EnhanceKeyResult,
  EnhanceProviderId,
  EnhanceRunRequest,
  EnhanceRunResult,
} from '../shared/aiEnhance';
import type { UpdateStatus } from '../shared/update';

export interface GetVectApi {
  openImages(): Promise<string[]>;
  readFile(filePath: string): Promise<Uint8Array>;
  saveExport(payload: {
    defaultName: string;
    contents: string;
    format: 'svg' | 'eps' | 'dxf' | 'pdf' | 'png';
    /** `base64` for binary formats (PNG); defaults to `utf8`. */
    encoding?: 'utf8' | 'base64';
  }): Promise<{ canceled: boolean; filePath: string | null }>;
  appInfo(): Promise<{ version: string; electron: string; e2e: boolean }>;
  /**
   * AI Enhance (optional, bring your own key). The key lives only in the main
   * process (src/main/aiEnhance.ts); this side can save one, clear one and ask
   * whether one exists — there is no way to read it back.
   */
  /**
   * OPTIONAL because the browser build does not offer it.
   *
   * AI Enhance is the one feature that talks to a server, and a browser has
   * nowhere safe to keep an API key. Omitting it is what lets the web version
   * claim, without an asterisk, that nothing leaves your machine. Marking it
   * optional makes the compiler enumerate every place that assumed otherwise,
   * rather than leaving a TypeError to be discovered in a tab.
   */
  aiEnhance?: {
    setKey(provider: EnhanceProviderId, key: string): Promise<EnhanceKeyResult>;
    clearKey(provider: EnhanceProviderId): Promise<EnhanceKeyResult>;
    hasKey(provider: EnhanceProviderId): Promise<boolean>;
    /** Cheap and keychain-free; safe at mount. */
    available(): Promise<boolean>;
    /**
     * The real capability check. On macOS this makes the OS ask for the
     * keychain password, so it must only be called from a deliberate user
     * action — never from an effect that runs on render.
     */
    checkStorage(): Promise<boolean>;
    run(request: EnhanceRunRequest): Promise<EnhanceRunResult>;
  };
  /**
   * Update check (src/main/updater.ts). Note there is no `check()`: the main
   * process checks once per launch on its own schedule, and this side can only
   * read the answer, act on it, or say "not this version".
   */
  /**
   * Prompts this install has already shown once.
   *
   * `shouldAsk` answers false when it has been shown AND when the answer cannot
   * be determined — an unreadable flag must not produce a repeated ask.
   */
  prompts?: {
    shouldAsk(id: string): Promise<boolean>;
    markAsked(id: string): Promise<void>;
  };

  /** OPTIONAL: a web page is always current, so there is nothing to check. */
  update?: {
    status(): Promise<UpdateStatus>;
    dismiss(version: string): Promise<UpdateStatus>;
    /** notify mode: open the release page. auto mode: start the download. */
    download(): Promise<UpdateStatus>;
    /** auto mode only, and only once the download finished. */
    install(): Promise<UpdateStatus>;
    onChanged(callback: (status: UpdateStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    getvect?: GetVectApi;
  }
}

export function api(): GetVectApi | null {
  return typeof window !== 'undefined' && window.getvect ? window.getvect : null;
}
