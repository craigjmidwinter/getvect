/**
 * THE WORDMARK IS THE HEADING, NOT A REPLACEMENT FOR IT.
 *
 * The header used to be `<h1>GetVect</h1>` in system type while the real mark
 * only ever reached the marketing page — visible for thirty seconds to someone
 * deciding, and never on the surface they spend an hour in.
 *
 * The way that change goes quietly wrong is accessibility. Swapping a heading
 * for an image removes the only <h1> a screen reader has to navigate by, and
 * nothing on screen looks different, so nobody notices until someone who
 * depends on it does. The mark therefore lives INSIDE the h1 and supplies its
 * text through `alt`: the announced structure is unchanged and the picture is an
 * implementation detail of the heading.
 *
 * The other two failure modes are layout and absence. An image with no reserved
 * box reflows the sidebar when it lands — which the desktop app hides, because
 * it loads from disk, and the web build does not. And an asset that 404s must
 * cost the wordmark, never the heading.
 */
import { FIXTURE, TESTIDS, expect, loadViaPicker, tid, test, waitForReady } from './helpers';

test.describe('the brand header', () => {
  test('is still an h1, and its accessible name is still GetVect', async ({ page }) => {
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();

    const h1 = page.locator('.brand h1');
    await expect(h1, 'the heading is gone — a screen reader has nothing to navigate by').toHaveCount(
      1,
    );
    // The name a screen reader announces, however it is composed.
    await expect(h1).toHaveAccessibleName(/getvect/i);

    // And it is a heading in the accessibility tree, not a div that looks like one.
    await expect(page.getByRole('heading', { level: 1, name: /getvect/i })).toHaveCount(1);
  });

  test('renders the mark with a reserved box, so nothing reflows when it lands', async ({
    page,
  }) => {
    const img = page.locator('.brand h1 img');
    await expect(img, 'the wordmark is not rendering').toHaveCount(1);

    // Intrinsic attributes, not just CSS: the box has to exist before the bytes
    // arrive, which is what stops the sidebar jumping on a network load.
    await expect(img).toHaveAttribute('width', '76');
    await expect(img).toHaveAttribute('height', '26');

    const box = await img.boundingBox();
    expect(box, 'the wordmark has no layout box').not.toBeNull();
    expect(Math.round(box!.width), 'the rendered width does not match the reserved one').toBe(76);
    expect(Math.round(box!.height)).toBe(26);

    // It must actually be painted, not a broken-image placeholder.
    const loaded = await img.evaluate((el) => {
      const i = el as HTMLImageElement;
      return i.complete && i.naturalWidth > 0;
    });
    expect(loaded, 'the wordmark element exists but the asset never decoded').toBe(true);
  });

  test('the tagline stays text', async ({ page }) => {
    // A sentence is not a mark: it should stay selectable, translatable and
    // restyleable rather than becoming pixels.
    await expect(page.locator('.brand p')).toHaveText(/raster/i);
  });

  test('a missing asset costs the mark, not the heading', async ({ page }) => {
    // Simulate the asset failing the way a corrupted install or a bad deploy
    // would, and confirm the header degrades to type rather than to nothing.
    await page.evaluate(() => {
      const img = document.querySelector('.brand h1 img') as HTMLImageElement | null;
      if (img) img.dispatchEvent(new Event('error'));
    });
    const h1 = page.locator('.brand h1');
    await expect(h1).toHaveAccessibleName(/getvect/i);
    await expect(h1, 'the header went empty when the asset failed').not.toHaveText('');
  });

  test('the header survives loading an image', async ({ page }) => {
    // The brand block sits in the same column as the workspace, so a re-render
    // with real content is where a fragile header would disappear.
    await loadViaPicker(page, FIXTURE.flat512);
    await waitForReady(page);
    await expect(page.getByRole('heading', { level: 1, name: /getvect/i })).toHaveCount(1);
    await expect(page.locator('.brand h1 img')).toHaveCount(1);
  });
});
