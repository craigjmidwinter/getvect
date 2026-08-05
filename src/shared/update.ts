/**
 * The update contract, shared by the main process (src/main/updater.ts), the
 * preload bridge and the renderer banner.
 *
 * WHY THERE ARE TWO MODES. Squirrel.Mac — the machinery behind Electron's
 * `autoUpdater` on macOS — refuses to install an update whose code signature it
 * cannot validate against the running app's. GetVect ships unsigned today
 * (`mac.identity: null`, see electron-builder.yml), so a silent in-place update
 * is not merely discouraged, it is impossible: the install step would fail
 * after a 150 MB download. Pretending otherwise would mean an app that
 * downloads a new version on every launch and never installs one.
 *
 * So the shipped behaviour is `notify`: check once, and if there is something
 * newer, say so and let the user fetch the dmg themselves. The `auto` path —
 * background download, then install on restart — is written, wired and
 * reachable; it is simply not the mode a build declares. When a Developer ID
 * certificate lands, `updateMode` in electron-builder.yml's `extraMetadata`
 * flips to `auto` and nothing else has to change.
 */

/**
 * What a build is allowed to do when it finds an update.
 *
 * - `notify` — tell the renderer, link to the release page, download nothing.
 * - `auto` — download in the background and install on quit/restart. Requires
 *   a signed build on macOS.
 */
export type UpdateMode = 'notify' | 'auto';

/** Where the app's release feed and its human-readable release pages live. */
export const RELEASES_URL = 'https://github.com/craigjmidwinter/getvect/releases';

/** The release page for a given version tag. */
export function releaseUrlFor(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/**
 * The whole of what the renderer knows about updates.
 *
 * `state` is a committed fact, never an in-flight animation:
 * - `idle` — no check has run (dev build, opted out, or too early).
 * - `checking` — a check is in flight.
 * - `up-to-date` — the feed answered and we are current.
 * - `available` — something newer exists. In `notify` mode this is terminal.
 * - `downloading` / `downloaded` — `auto` mode only.
 * - `error` — the check failed. **This is deliberately boring**: the banner
 *   stays hidden, the reason goes to the log, and an offline launch looks
 *   exactly like a launch with nothing new.
 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  mode: UpdateMode;
  state: UpdateState;
  /** The version on offer, once one is known. */
  version: string | null;
  /** The version currently running. */
  currentVersion: string;
  /** Human-facing release page for `version`. */
  releaseUrl: string | null;
  /** True once the user has dismissed *this* version's banner. */
  dismissed: boolean;
  /** 0..1 while downloading in `auto` mode. */
  progress: number | null;
}

/** IPC channel names — one place, so main and preload cannot drift. */
export const UPDATE_CHANNEL = {
  status: 'update:status',
  dismiss: 'update:dismiss',
  /** `notify`: open the release page. `auto`: start the background download. */
  download: 'update:download',
  /** `auto` only: quit and install what was downloaded. */
  install: 'update:install',
  /** main -> renderer push whenever the status changes. */
  changed: 'update:changed',
} as const;

/**
 * Should the banner be on screen?
 *
 * Shared so the renderer and the specs agree, and so the two modes differ in
 * exactly one predicate rather than in two copies of the UI.
 */
export function shouldShowUpdateBanner(status: UpdateStatus | null): boolean {
  if (!status || status.dismissed) return false;
  return status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded';
}
