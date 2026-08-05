/**
 * Controls that lie, and controls you cannot see.
 *
 * Both of these are affordance rather than breakage — the engine does the right
 * thing in each case — and both make the settings panel misreport the product:
 *
 *  - B2: with the Drawing preset selected the output is two-tone, but the
 *    COLORS slider still reads 4 and all eleven input-palette sizes stay live.
 *    `fixtures/reference/OBSERVED-UI.md` records that the real product swaps
 *    those controls out for Black/White checkboxes plus the luminance
 *    histogram when Drawing is active. Whatever the replacement, a control
 *    that cannot affect the result must not stay enabled.
 *  - B3: at the app's *default* window size the last two output controls
 *    (merge threshold, sort order) sit below the viewport — the panel scrolls,
 *    so they are reachable, but the thing that stays in view is a checkbox
 *    list rather than the controls.
 */
import { FIXTURE, TESTIDS, expect, loadViaPicker, test, tid, waitForReady } from './helpers';

test('[B2] the Drawing preset does not leave dead colour controls live', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetDrawing)).click();
  await waitForReady(page);

  // The B/W threshold is the input control Drawing actually has.
  await expect(page.locator(tid(TESTIDS.settingBwThreshold))).toBeEnabled();

  const colorCount = page.locator(tid(TESTIDS.settingColorCount));
  const liveColorCount = (await colorCount.count()) > 0 && (await colorCount.isEnabled());
  expect(
    liveColorCount,
    'the COLORS slider is still live under the Drawing preset, which always emits two colours',
  ).toBe(false);

  const sizes = page.locator(tid(TESTIDS.paletteSizeOption));
  const liveSizes = await sizes.evaluateAll((nodes) =>
    nodes.filter((n) => !(n as HTMLInputElement).disabled).length,
  );
  expect(
    liveSizes,
    'the eleven candidate input-palette sizes are still selectable under Drawing',
  ).toBe(0);
});

test('[B2] leaving the Drawing preset gives the colour controls back', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetDrawing)).click();
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetClipart)).click();
  await waitForReady(page);

  await expect(page.locator(tid(TESTIDS.settingColorCount))).toBeEnabled();
  await expect(page.locator(tid(TESTIDS.paletteSizeOption)).first()).toBeEnabled();
});

test('[B3] every output-colour control is on screen at the default window size', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  for (const id of [TESTIDS.colorMergeThreshold, TESTIDS.colorSortOrder]) {
    const box = await page.locator(tid(id)).boundingBox();
    expect(box, `${id} has no box`).not.toBeNull();
    expect(
      box!.y + box!.height,
      `${id} ends at y=${(box!.y + box!.height).toFixed(0)} in a ${viewport.h}px viewport — it is ` +
        'below the fold at the app\'s own default window size',
    ).toBeLessThanOrEqual(viewport.h);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.w);
  }
});

test('[B3] the output colour list itself is reachable without scrolling past the fold', async ({
  page,
}) => {
  /**
   * B3's headline behaviour is "disable the background colour to get a
   * transparent background", and the checkbox that does it is a
   * `color-group-toggle`. Measured at the app's own default window size
   * (1280x828 viewport) the first toggle's box was y=835 h=13 — entirely below
   * the fold, while `merge-threshold` and `color-sort` (the two controls the
   * test above asserts) sat at y=797 and fitted. The panel scrolls, so the
   * feature is reachable; what is not reachable is *knowing it is there*.
   *
   * At least the first toggle must be fully inside the viewport.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const first = page.locator(tid(TESTIDS.colorGroupToggle)).first();
  await expect(first).toHaveCount(1);
  const box = await first.boundingBox();
  expect(box, 'no color-group-toggle on screen at all').not.toBeNull();
  expect(
    box!.y + box!.height,
    `the first color-group-toggle ends at y=${(box!.y + box!.height).toFixed(0)} in a ` +
      `${viewport.h}px viewport — B3's transparent-background control is below the fold at the ` +
      "app's own default window size",
  ).toBeLessThanOrEqual(viewport.h);
  expect(box!.y, 'the first color-group-toggle starts above the viewport').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.w);
});

test('[B3] the output colour list survives the biggest palette the app offers', async ({ page }) => {
  /**
   * The viewport check above is necessary but not sufficient: a box inside the
   * window can still be clipped by a scrolling *ancestor*, and that is exactly
   * what happened. The colour column was the scroller, so with a large palette
   * it measured 308px of content in a 255px box and the OUTPUT COLOURS block —
   * last in the column — was cut off at the column's bottom edge while its
   * bounding box still read as "on screen". Playwright's `toBeVisible()` does
   * not catch it either: a clipped element is still laid out and still has a
   * box.
   *
   * So the check is a hit test at the control's own centre — what a user's
   * click actually lands on — done at the largest input palette (18), the case
   * that overflows the column, and repeated for every visible control in the
   * output block.
   */
  await loadViaPicker(page, FIXTURE.artwork);
  await waitForReady(page);
  await page.locator(`${tid(TESTIDS.paletteSizeOption)}[data-size="18"]`).click();
  await waitForReady(page);

  const toggles = page.locator(tid(TESTIDS.colorGroupToggle));
  expect(await toggles.count(), 'no output colour groups at an 18-colour palette').toBeGreaterThan(
    1,
  );

  for (const id of [TESTIDS.colorMergeThreshold, TESTIDS.colorSortOrder]) {
    const hit = await hitTest(page, tid(id));
    expect(hit, `${id}: ${hit.why}`).toMatchObject({ reachable: true });
  }
  const firstToggle = await hitTest(page, `${tid(TESTIDS.colorGroupToggle)} >> nth=0`);
  expect(
    firstToggle,
    "B3's per-colour disable checkbox is not clickable where it is drawn — " +
      `${firstToggle.why}`,
  ).toMatchObject({ reachable: true });
});

test('[B3] at the app\'s own minimum window size nothing is hidden, only scrolled', async ({
  app,
  page,
}) => {
  /**
   * 900x640 is the smallest window `src/main/main.ts` allows, and a control
   * surface this size cannot show ~25 controls at once there. That is fine —
   * *silently* not showing them is not. The check is therefore reachability
   * rather than visibility: a control may start off screen, but scrolling its
   * own scroller must bring it fully into view. A control that stays clipped
   * after that is one the panel is hiding with `overflow: hidden`.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(900, 640);
  });
  await page.waitForTimeout(400);

  // Nothing inside the panel may overflow a box the user cannot scroll:
  // `overflow: hidden` on a box with more content than room is the mechanism
  // that hides a control outright, and `scrollIntoView` would paper over it
  // (it scrolls hidden boxes too, which no user can).
  const unscrollable = await page.evaluate(() => {
    const out: string[] = [];
    const panel = document.querySelector('.settings-panel');
    if (!panel) return ['no settings panel'];
    for (const el of [panel, ...panel.querySelectorAll('*')]) {
      const style = getComputedStyle(el);
      const name = `${el.tagName.toLowerCase()}.${el.className}`;
      if (el.scrollHeight > el.clientHeight + 1 && /hidden|clip/.test(style.overflowY)) {
        out.push(`${name} hides ${el.scrollHeight - el.clientHeight}px vertically`);
      }
      if (el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(style.overflowX)) {
        out.push(`${name} hides ${el.scrollWidth - el.clientWidth}px horizontally`);
      }
    }
    return out;
  });
  expect(unscrollable, `content is clipped with no way to scroll to it: ${unscrollable.join('; ')}`)
    .toEqual([]);

  for (const id of [
    TESTIDS.colorMergeThreshold,
    TESTIDS.colorSortOrder,
    TESTIDS.colorGroupToggle,
    TESTIDS.paletteSwatch,
    TESTIDS.paletteMergeButton,
    TESTIDS.paletteRemoveButton,
    TESTIDS.paletteSizeOption,
  ]) {
    const selector = `${tid(id)} >> nth=0`;
    await page.locator(selector).evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    const hit = await hitTest(page, selector);
    expect(
      hit,
      `${id} cannot be brought on screen in a 900x640 window: ${hit.why}`,
    ).toMatchObject({ reachable: true });
  }
});

/**
 * Is the whole control on screen where it is drawn, and does a click there land
 * on it?
 *
 * Two things a bounding box cannot answer on its own:
 *  - **clipping**: the box of an element inside an overflowing scroller is
 *    reported in full even when only a sliver of it is painted, so the rect is
 *    checked for containment inside every clipping ancestor (a scroller that
 *    is already scrolled to show the element passes; one that hides part of it
 *    does not);
 *  - **covering**: `document.elementFromPoint` at the centre returns whatever
 *    a click would actually hit.
 */
async function hitTest(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const fits = (a: DOMRect | { top: number; bottom: number; left: number; right: number }) =>
      rect.top >= a.top - 0.5 &&
      rect.bottom <= a.bottom + 0.5 &&
      rect.left >= a.left - 0.5 &&
      rect.right <= a.right + 0.5;

    if (!fits({ top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight })) {
      return {
        reachable: false,
        why:
          `its box (y ${Math.round(rect.top)}-${Math.round(rect.bottom)}) leaves the ` +
          `${window.innerHeight}px window`,
      };
    }

    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      // Client box: the padding box, i.e. inside the borders, which is what a
      // scroller actually paints its content in.
      const clip = {
        top: box.top + node.clientTop,
        left: box.left + node.clientLeft,
        right: box.left + node.clientLeft + node.clientWidth,
        bottom: box.top + node.clientTop + node.clientHeight,
      };
      if (!fits(clip)) {
        return {
          reachable: false,
          why:
            `it is clipped by ${node.tagName.toLowerCase()}.${node.className} — its box ` +
            `(y ${Math.round(rect.top)}-${Math.round(rect.bottom)}) does not fit that box's ` +
            `y ${Math.round(clip.top)}-${Math.round(clip.bottom)}`,
        };
      }
    }

    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const reachable = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    return {
      reachable,
      why: reachable
        ? 'reachable'
        : `a click at (${Math.round(x)},${Math.round(y)}) lands on ` +
          `${hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : 'nothing'} — the control is ` +
          'covered',
    };
  });
}

test('[B3] the way back from a hand-edited palette looks clickable', async ({ page }) => {
  /**
   * `palette-auto-button` is the only route back to the computed palette after
   * a user edits a swatch, and it renders as unstyled body text beside the
   * PALETTE label: no border, no background, no padding — nothing that says
   * "control". Merge and Remove sit inches away with full button chrome, so the
   * one destructive-edit escape hatch is the one thing on the panel that does
   * not read as pressable.
   *
   * The bar is deliberately relative: whatever chrome the app gives its
   * buttons, this one gets the same. That way restyling the panel cannot make
   * this check wrong, only the affordance gap can.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  // The button only exists once there is an edit to undo, so make one.
  await page.locator(tid(TESTIDS.paletteSwatch)).first().click();
  await page.locator(tid(TESTIDS.paletteColorInput)).evaluate((node) => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '#ff00ff');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForReady(page);
  await expect(page.locator(tid(TESTIDS.paletteAutoButton))).toHaveCount(1);

  const chrome = (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const s = getComputedStyle(el);
      const alpha = (c: string) => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        return m ? Number(m[1].split(',')[3] ?? 1) : 1;
      };
      return {
        cursor: s.cursor,
        padded: parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) > 4,
        bordered: parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0,
        filled: alpha(s.backgroundColor) > 0,
      };
    });

  const reference = await chrome(tid(TESTIDS.paletteMergeButton));
  const auto = await chrome(tid(TESTIDS.paletteAutoButton));
  expect(
    auto,
    `palette-auto-button (${JSON.stringify(auto)}) does not carry the chrome the panel's own ` +
      `buttons carry (${JSON.stringify(reference)}) — it reads as body text`,
  ).toMatchObject({
    cursor: 'pointer',
    padded: reference.padded,
  });
  expect(
    auto.bordered || auto.filled,
    'palette-auto-button has neither a border nor a background: nothing marks it as a control',
  ).toBe(true);
});

test('[B3] every output colour group is visible at the default palette size', async ({ page }) => {
  /**
   * The check above this one only requires the FIRST toggle to be on screen,
   * and that is how an 8-colour output shipped with its last group (#7C6F63)
   * half-hidden behind a scrollbar at the app's own default window size. The
   * reference product shows the output colour groups as a row of circles you
   * can see at a glance and drag between; a list you have to scroll to learn
   * the length of is not the same control.
   *
   * Default settings on real artwork — i.e. what a user gets by opening the app
   * and dropping a file — and every group has to be reachable where it is
   * drawn.
   */
  await loadViaPicker(page, FIXTURE.artwork);
  await waitForReady(page);

  const toggles = page.locator(tid(TESTIDS.colorGroupToggle));
  const count = await toggles.count();
  expect(count, 'no output colour groups at all').toBeGreaterThan(1);

  const hidden: string[] = [];
  for (let i = 0; i < count; i++) {
    const hit = await hitTest(page, `${tid(TESTIDS.colorGroupToggle)} >> nth=${i}`);
    if (!hit.reachable) {
      const color = await toggles.nth(i).getAttribute('data-color');
      hidden.push(`${color ?? `#${i}`}: ${hit.why}`);
    }
  }
  expect(
    hidden,
    `${hidden.length} of ${count} output colour groups cannot be seen at the default window ` +
      `size: ${hidden.join(' · ')}`,
  ).toEqual([]);
});

test('[B3] the colour-count hint is readable, not clipped mid-sentence', async ({ page }) => {
  // "6 colours in the result — the image has no more to give" cut off at the
  // panel edge is a hint nobody can act on.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const hint = page.locator(tid(TESTIDS.settingColorCountHint));
  const overflow = await hint.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    overflow.scrollWidth <= overflow.clientWidth + 1 &&
      overflow.scrollHeight <= overflow.clientHeight + 1,
    `color-count-hint is clipped (${overflow.scrollWidth}x${overflow.scrollHeight} of text in a ` +
      `${overflow.clientWidth}x${overflow.clientHeight} box)`,
  ).toBe(true);
});
