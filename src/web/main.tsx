/**
 * Browser entry point.
 *
 * The only difference from `src/renderer/main.tsx` is the line before mounting:
 * install a browser implementation of `window.getvect`, which is the single seam
 * the renderer reaches Electron through (`api()` in src/renderer/api.ts). The
 * App component, the engine, the worker, the decode path and the exporters are
 * imported unchanged — this is not a port, it is the same renderer in a
 * different shell.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../renderer/App';
import '../renderer/styles.css';
import { installWebBridge } from './bridge';

// Before mount: the App reads the bridge in an effect that runs on first render,
// so installing it afterwards would race.
installWebBridge(__GETVECT_VERSION__);

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
