/**
 * Typed view of the preload bridge (`window.getvect`, see src/main/preload.ts).
 *
 * Declared locally rather than imported from the main-process source so the
 * renderer tsconfig never has to pull in Electron's typings.
 */
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
}

declare global {
  interface Window {
    getvect?: GetVectApi;
  }
}

export function api(): GetVectApi | null {
  return typeof window !== 'undefined' && window.getvect ? window.getvect : null;
}
