import type { Page } from '@playwright/test';
import { test, expect, tid, TESTIDS, FIXTURE, loadViaPicker, waitForReady } from './helpers';

/**
 * REFERENCE C1/C2 — the preview must behave like an image viewer.
 *
 * The checklist tests in c-preview.spec.ts prove the controls exist. These
 * prove they behave: the artwork never disappears mid-trace, the busy state is
 * an overlay rather than a member of the zoom/pan stage, the wheel zooms, and
 * panning cannot throw the artwork off screen with no way back except "Fit".
 */

const rectOf = (page: Page, id: string) =>
  page
    .locator(tid(id))
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });

const svgRect = (page: Page) =>
  page.locator(`${tid(TESTIDS.previewVector)} svg`).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

test('[C1] the vector view never goes blank while a new image is traced', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.artwork);
  await waitForReady(page);

  let blankFrames = 0;
  const watching = (async () => {
    for (let i = 0; i < 60; i++) {
      const hasSvg = await page.locator(`${tid(TESTIDS.previewVector)} svg`).count();
      if (hasSvg === 0) blankFrames++;
      await page.waitForTimeout(15);
    }
  })();

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  await waitForReady(page);
  await watching;

  expect(blankFrames, 'the preview emptied while re-tracing').toBe(0);
});

test('[C1] the busy indicator is a centred overlay, not part of the zoom stage', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.artwork);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomIn)).click();
  await page.locator(tid(TESTIDS.zoomIn)).click();

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  const busy = page.locator(tid(TESTIDS.previewBusy));
  await expect(busy).toBeVisible({ timeout: 5_000 });

  const pane = await rectOf(page, TESTIDS.previewPane);
  const overlay = await rectOf(page, TESTIDS.previewBusy);
  const dx = Math.abs(overlay.x + overlay.width / 2 - (pane.x + pane.width / 2));
  const dy = Math.abs(overlay.y + overlay.height / 2 - (pane.y + pane.height / 2));
  expect(dx, 'busy overlay is not horizontally centred in the pane').toBeLessThan(12);
  expect(dy, 'busy overlay is not vertically centred in the pane').toBeLessThan(12);
  await waitForReady(page);
});

test('[C2] the mouse wheel zooms the preview', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const level = page.locator(tid(TESTIDS.zoomLevel));
  const read = async () => Number(await level.getAttribute('data-zoom'));
  const before = await read();

  const pane = await rectOf(page, TESTIDS.previewPane);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(read, { message: 'wheel up did not zoom in' })
    .toBeGreaterThan(before);

  const zoomedIn = await read();
  await page.mouse.wheel(0, 400);
  await expect.poll(read, { message: 'wheel down did not zoom out' }).toBeLessThan(zoomedIn);

  // Both views stay synchronized under wheel zoom too (C2).
  await expect(page.locator(tid(TESTIDS.previewVector))).toHaveAttribute(
    'data-zoom',
    String(await read()),
  );
});

test('[C2] panning cannot throw the artwork off screen', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomFit)).click();

  const pane = await rectOf(page, TESTIDS.previewPane);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 + 700, pane.y + pane.height / 2 + 500, {
    steps: 10,
  });
  await page.mouse.up();

  const art = await svgRect(page);
  expect(
    overlap(art, pane),
    'a single drag pushed the artwork out of the view with no way back but Fit',
  ).toBeGreaterThan(0.25);
});

test('[C2] preview controls are inert until an image is loaded', async ({ page }) => {
  for (const id of [
    TESTIDS.previewToggle,
    TESTIDS.previewSideBySide,
    TESTIDS.zoomIn,
    TESTIDS.zoomOut,
    TESTIDS.zoomFit,
  ]) {
    await expect(page.locator(tid(id)), `${id} should be disabled with no image`).toBeDisabled();
  }
});

test('[C1] the preview chrome reads cleanly: no stray pan readout, no clipped badges', async ({
  page,
}) => {
  /**
   * Two cosmetic-but-visible defects a critic caught in the contact sheet:
   * a bare "0, 0" pan readout rendered in the header of an app with no image
   * loaded (artifacts/screenshots/01-launch-drop-zone.png), and the
   * ORIGINAL / VECTOR corner badges drawn cut off at the pane edge in
   * side-by-side mode (18-preview-side-by-side.png).
   */
  const panState = page.locator(tid(TESTIDS.panState));
  const idleText = ((await panState.textContent()) ?? '').trim();
  expect(
    idleText,
    `the header shows a pan readout ("${idleText}") with no image loaded — it is a coordinate ` +
      'for a thing that does not exist',
  ).toBe('');

  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await expect(page.locator(tid(TESTIDS.previewPane))).toHaveAttribute('data-mode', 'side-by-side');

  for (const id of [TESTIDS.previewOriginal, TESTIDS.previewVector]) {
    const view = await rectOf(page, id);
    const badge = await page
      .locator(`${tid(id)} ${tid(TESTIDS.previewViewLabel)}`)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    expect(badge.width, `${id} badge has no width`).toBeGreaterThan(0);
    expect(badge.x, `${id} badge starts left of its pane`).toBeGreaterThanOrEqual(view.x);
    expect(badge.y, `${id} badge starts above its pane`).toBeGreaterThanOrEqual(view.y);
    expect(
      badge.x + badge.width,
      `${id} badge runs past the right edge of its pane — it is drawn clipped`,
    ).toBeLessThanOrEqual(view.x + view.width);
    expect(
      badge.y + badge.height,
      `${id} badge runs past the bottom edge of its pane`,
    ).toBeLessThanOrEqual(view.y + view.height);
  }
});

test('[C1] the ORIGINAL / VECTOR badges stay readable over light artwork', async ({ page }) => {
  /**
   * The badges are only legible where they happen to sit over a dark part of
   * the preview. Sampled on `artifacts/screenshots/18-preview-side-by-side.png`
   * the chip reads luma ~20 with ~155 text where it overlaps the pane
   * background, and luma ~155 with ~160-180 text where it overlaps the cream
   * artwork — about 1.1:1, at which point the label is gone. Nobody caught it
   * because the fixture the shots are taken on happens to be dark.
   *
   * The chip's background is translucent, so the worst case is a *white*
   * preview: composite the badge's own background over white and ask whether
   * its text still has 3:1 contrast — the WCAG bar for large text, and the
   * least a corner label can be held to. Raising the chip's alpha, or giving it
   * an opaque backdrop, satisfies this; a text-shadow alone does not, and is
   * not what "readable over any artwork" means when the artwork can be the same
   * colour as the shadow.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await expect(page.locator(tid(TESTIDS.previewPane))).toHaveAttribute('data-mode', 'side-by-side');

  for (const id of [TESTIDS.previewOriginal, TESTIDS.previewVector]) {
    const measured = await page
      .locator(`${tid(id)} ${tid(TESTIDS.previewViewLabel)}`)
      .first()
      .evaluate((el) => {
        const parse = (value: string) => {
          const m = /rgba?\(([^)]+)\)/.exec(value);
          if (!m) return null;
          const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
          return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
        };
        const style = getComputedStyle(el);
        const bg = parse(style.backgroundColor) ?? { r: 255, g: 255, b: 255, a: 0 };
        const fg = parse(style.color) ?? { r: 0, g: 0, b: 0, a: 1 };
        // Worst case: the artwork under the chip is white. Composite the chip
        // over white, then the text over the chip.
        type Rgb = { r: number; g: number; b: number };
        const over = (c: { r: number; g: number; b: number; a: number }, base: Rgb): Rgb => ({
          r: c.r * c.a + base.r * (1 - c.a),
          g: c.g * c.a + base.g * (1 - c.a),
          b: c.b * c.a + base.b * (1 - c.a),
        });
        const lum = (c: Rgb) => {
          const ch = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
        };
        const chip = over(bg, { r: 255, g: 255, b: 255 });
        const text = over(fg, chip);
        const l1 = lum(chip);
        const l2 = lum(text);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          backdropFilter: style.backdropFilter ?? 'none',
          alpha: bg.a,
          ratio,
        };
      });

    expect(
      measured.ratio,
      `${id}: the badge (${measured.backgroundColor} chip, ${measured.color} text) has ` +
        `${measured.ratio.toFixed(2)}:1 contrast once its background is composited over a white ` +
        'preview — over light artwork the label disappears',
    ).toBeGreaterThanOrEqual(3);
  }
});

test('[C2] the grab cursor only appears when there is somewhere to pan', async ({ page }) => {
  // A grab cursor at Fit invites a drag whose only possible effect is to push
  // the artwork away — the affordance has to follow the geometry.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomFit)).click();

  const pane = page.locator(tid(TESTIDS.previewPane));
  const cursor = () => pane.evaluate((el) => getComputedStyle(el).cursor);
  await expect(pane).toHaveAttribute('data-pannable', 'false');
  expect(await cursor(), 'the pane offers a grab cursor with the whole image in view').not.toBe(
    'grab',
  );

  await page.locator(tid(TESTIDS.zoomIn)).click();
  await page.locator(tid(TESTIDS.zoomIn)).click();
  await page.locator(tid(TESTIDS.zoomIn)).click();
  await expect(pane).toHaveAttribute('data-pannable', 'true');
  expect(await cursor(), 'no grab cursor once the artwork is bigger than the view').toBe('grab');
});
