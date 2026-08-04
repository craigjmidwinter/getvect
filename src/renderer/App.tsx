import { useEffect, useState } from 'react';
import { TESTIDS } from '../shared/testids';

/**
 * Placeholder shell. Builders replace this with the real workspace
 * (drop zone, image list, settings panel, palette editor, preview, export).
 * The only contract this file currently honours is `app-root`; every other
 * testid in src/shared/testids.ts is still unimplemented — see docs/TESTIDS.md.
 */
export function App() {
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null);

  useEffect(() => {
    const api = (window as unknown as { getvect?: { appInfo(): Promise<never> } }).getvect;
    api?.appInfo().then(setInfo).catch(() => undefined);
  }, []);

  return (
    <main data-testid={TESTIDS.appRoot} className="shell">
      <h1>GetVect</h1>
      <p className="tagline">Raster &rarr; vector, locally.</p>
      <p className="skeleton-note">
        Skeleton build. The acceptance suite (<code>npm test</code>) is red by design until the
        workspace, engine and export flows land. DOM contract: <code>docs/TESTIDS.md</code>.
      </p>
      <p className="version">
        {info ? `app ${info.version} · electron ${info.electron}` : 'app booting…'}
      </p>
    </main>
  );
}
