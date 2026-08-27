/**
 * THE SOURCE LINE: ONCE, AFTER AN EXPORT, AND NEVER AGAIN.
 *
 * Every assertion here is about a way this becomes the thing it must not be.
 *
 *  - shown before anyone has been helped — asking for a star from someone who
 *    has not yet got what they came for is the version that annoys people;
 *  - shown twice — the failure modes are asymmetric. A star not received costs
 *    nothing measurable; a user who feels nagged tells people the tool nags;
 *  - shown when the flag cannot be read — an error must produce silence, never
 *    a repeated ask, which is the specific outcome the design rules out;
 *  - shipped as an embed — the official GitHub button is an iframe from
 *    ghbtns.com, which would make a third-party request on load and contradict
 *    the offline claim in a way anyone with devtools can see.
 */
import {
  FIXTURE,
  TESTIDS,
  expect,
  exportAs,
  loadViaPicker,
  tid,
  test,
  waitForReady,
} from './helpers';

const LINE = '[data-testid="source-line"]';

test.describe('the source line', () => {
  test('is absent before an export, even after a trace', async ({ page, exportDir: _d }) => {
    await loadViaPicker(page, FIXTURE.flat512);
    await waitForReady(page);
    // Traced, not exported: the user has not yet got the thing they came for.
    await expect(page.locator(LINE), 'shown before the user was helped').toHaveCount(0);
  });

  test('appears after an export, and says what it says', async ({ page, exportDir }) => {
    await loadViaPicker(page, FIXTURE.flat512);
    await waitForReady(page);
    await exportAs(page, 'svg', exportDir);

    const line = page.locator(LINE);
    await expect(line).toBeVisible();
    await expect(line).toContainText('MIT licensed');
    await expect(line).toContainText('Source on');

    const link = line.locator('a');
    await expect(link).toHaveAttribute('href', 'https://github.com/craigjmidwinter/getvect');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('is a plain anchor — no embed, no third-party request', async ({ page, exportDir }) => {
    const offOrigin: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return;
      if (u.startsWith('devtools:') || u.includes('127.0.0.1') || u.includes('localhost')) return;
      offOrigin.push(u);
    });

    await loadViaPicker(page, FIXTURE.flat512);
    await waitForReady(page);
    await exportAs(page, 'svg', exportDir);
    await expect(page.locator(LINE)).toBeVisible();

    // The official button would be an <iframe src="https://ghbtns.com/...">.
    await expect(page.locator(`${LINE} iframe`)).toHaveCount(0);
    await expect(page.locator('iframe[src*="ghbtns"]')).toHaveCount(0);
    expect(offOrigin, `the page called out to ${offOrigin.join(', ')}`).toEqual([]);
  });

  test('does not come back after being dismissed', async ({ page, exportDir }) => {
    await loadViaPicker(page, FIXTURE.flat512);
    await waitForReady(page);
    await exportAs(page, 'svg', exportDir);
    await expect(page.locator(LINE)).toBeVisible();

    await page.locator('.source-dismiss').click();
    await expect(page.locator(LINE)).toHaveCount(0);

    // A second export in the same session must not bring it back.
    await exportAs(page, 'eps', exportDir);
    await expect(
      page.locator(LINE),
      'a second export re-asked — the flag is not being honoured',
    ).toHaveCount(0);
  });
});
