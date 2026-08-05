import { useEffect, useState } from 'react';
import { api } from '../api';
import { TESTIDS } from '../../shared/testids';
import { shouldShowUpdateBanner, type UpdateStatus } from '../../shared/update';

/**
 * "GetVect X.Y.Z is available."
 *
 * Non-modal by construction: it is a fixed-position card in the bottom-right
 * corner, outside the app grid, so nothing reflows when it appears and no
 * workflow is blocked by it. It cannot appear except after the main process's
 * once-per-launch check found something (src/main/updater.ts), it is
 * dismissible, and the dismissal is remembered per version *in the main
 * process* — not localStorage, which the renderer can clear out from under
 * itself.
 *
 * On an unsigned build (`mode: 'notify'`, which is every build today) Download
 * opens the release page in the browser, because an unsigned macOS app cannot
 * install its own update — see src/shared/update.ts. On a signed build
 * (`mode: 'auto'`) the same button downloads in place, the card shows progress,
 * and it ends as a Restart button. Both paths are here; the build picks one.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const bridge = api();
    if (!bridge) return;
    let live = true;
    // Ask once (the check may have finished before this mounted), then listen.
    void bridge.update.status().then((s) => {
      if (live) setStatus(s);
    });
    const off = bridge.update.onChanged(setStatus);
    return () => {
      live = false;
      off();
    };
  }, []);

  if (!shouldShowUpdateBanner(status) || !status?.version) return null;

  const { version, state, mode, progress } = status;
  const percent = progress === null ? null : Math.round(progress * 100);

  return (
    <div
      data-testid={TESTIDS.updateBanner}
      data-version={version}
      data-state={state}
      data-mode={mode}
      className="update-banner"
      role="status"
      aria-live="polite"
    >
      <div className="update-text">
        <strong>GetVect {version} is available</strong>
        <span>
          {state === 'downloaded'
            ? 'Downloaded. Restart to install.'
            : state === 'downloading'
              ? `Downloading… ${percent ?? 0}%`
              : `You have ${status.currentVersion}.`}
        </span>
      </div>

      {state === 'downloaded' ? (
        <button
          data-testid={TESTIDS.updateInstallButton}
          type="button"
          className="update-action"
          onClick={() => void api()?.update.install()}
        >
          Restart
        </button>
      ) : state === 'downloading' ? null : (
        <button
          data-testid={TESTIDS.updateDownloadButton}
          type="button"
          className="update-action"
          onClick={() => void api()?.update.download()}
        >
          Download
        </button>
      )}

      <button
        data-testid={TESTIDS.updateDismissButton}
        type="button"
        className="link update-dismiss"
        aria-label="Dismiss"
        title="Don't show this again for this version"
        onClick={() => void api()?.update.dismiss(version)}
      >
        ×
      </button>
    </div>
  );
}
