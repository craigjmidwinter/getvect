/**
 * One-time prompts — a record of what this install has already asked, once.
 *
 * WHAT THIS IS NOT. It is a local flag saying "we already said this to you". It
 * records nothing about the user, leaves the machine never, and is not
 * telemetry: a file next to the app's other settings that answers one question,
 * "have I already asked?". Nothing here needs disclosing under the privacy claim
 * on the site, and this paragraph exists so nobody later mistakes it for
 * something that does.
 *
 * WHY IT FAILS CLOSED, WHICH IS THE OPPOSITE OF THE UPDATER'S STORE. If the file
 * cannot be read, `shouldAsk` answers NO. Silence is the correct outcome of an
 * error here: the whole design of the prompt is that it happens once and never
 * again, so an unreadable flag that produced a repeated ask would fail into
 * precisely the behaviour the feature is built to avoid. `src/main/updater.ts`
 * fails the other way on purpose — an unreadable dismissal shows the update
 * banner again, because a missed update notice is worse than a repeated one.
 * Same shape of store, opposite default, because the costs are not symmetric.
 */
import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

interface PromptStore {
  /** Prompt id -> ISO timestamp of when it was shown. The value is for a human
   *  reading the file; nothing reads it back. */
  asked?: Record<string, string>;
}

const isE2E = process.env.GETVECT_E2E === '1';

/**
 * Under test this must NOT be the developer's real `userData`, for the same
 * reason the update and AI stores redirect: a suite that writes there pollutes
 * the machine it runs on, and — specific to this store — the first test to
 * export would consume the one-time flag for every test after it, so the
 * feature working correctly would look like the feature being broken.
 */
function storeDir(): string {
  if (isE2E) {
    return process.env.GETVECT_PROMPTS_DIR || path.join(app.getPath('temp'), 'getvect-e2e-prompts');
  }
  return app.getPath('userData');
}

const storePath = () => path.join(storeDir(), 'prompts.json');

async function readStore(): Promise<PromptStore | null> {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf8')) as PromptStore;
  } catch (err) {
    // A missing file is the normal first-run case and means "nothing asked yet".
    // Anything else is a real read failure, and the two must not be conflated:
    // one should let the prompt through, the other must not.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    return null;
  }
}

/**
 * May we show this prompt? False if it has already been shown, and false if we
 * could not find out.
 */
export async function shouldAsk(id: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  return !store.asked?.[id];
}

/** Record that it has been shown. Best effort: a failure here shows it again
 *  next launch, which is the smaller of the two errors available. */
export async function markAsked(id: string): Promise<void> {
  const store = (await readStore()) ?? {};
  const asked = { ...(store.asked ?? {}), [id]: new Date().toISOString() };
  try {
    await fs.mkdir(storeDir(), { recursive: true });
    await fs.writeFile(storePath(), JSON.stringify({ ...store, asked }), { mode: 0o600 });
  } catch {
    /* see above */
  }
}

export function registerPromptsIpc(): void {
  ipcMain.handle('prompts:shouldAsk', (_e, id: string) => shouldAsk(id));
  ipcMain.handle('prompts:markAsked', (_e, id: string) => markAsked(id));
}
