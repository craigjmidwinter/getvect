import type { Page } from '@playwright/test';
import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  loadViaPicker,
  setSelect,
  waitForReady,
} from './helpers';

/**
 * REFERENCE B3 — palette state the panel reports about itself.
 *
 * b3-palette.spec.ts proves the palette controls work on the picture. These two
 * are about the panel telling the truth about what it just did, which is the
 * half a user actually navigates by:
 *
 *  - the colour-count hint blames the *image* for every shortfall, including
 *    the ones our own merge caused,
 *  - "Auto palette" does not restore the palette the user had before editing —
 *    it recomputes at the mutated colour count and silently lands somewhere
 *    else, with no way back to the candidate size that was selected.
 */

async function setColorInput(page: Page, hex: string) {
  await page.locator(tid(TESTIDS.paletteColorInput)).evaluate((node, value) => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
}

const pickSize = async (page: Page, size: number) => {
  await page.locator(`${tid(TESTIDS.paletteSizeOption)}[data-size="${size}"]`).click();
  await waitForReady(page);
};

const hintOf = (page: Page) =>
  page.locator(tid(TESTIDS.settingColorCountHint)).evaluate((el) => ({
    text: el.textContent ?? '',
    requested: el.getAttribute('data-requested'),
    actual: el.getAttribute('data-actual'),
    shortfall: el.getAttribute('data-shortfall'),
  }));

test('[B3] the colour-count hint names the real reason the palette is short', async ({ page }) => {
  /**
   * `src/renderer/App.tsx` appends " — the image has no more to give" whenever
   * `palette.length < settings.colorCount`, whatever the cause. On the
   * gold-standard artwork at 16 colours with Enhance on the panel reads
   * "10 colours in the result — the image has no more to give", while the SAME
   * image at the SAME 16 colours with Enhance off returns a full 16-colour
   * palette. The shortfall is our own fold, not the image.
   *
   * DOM contract (docs/TESTIDS.md): `color-count-hint` carries
   * `data-shortfall` ∈ `none` | `image` | `settings`, and when it is
   * `settings` the text must not blame the image.
   *
   * The fold this drives used to be Enhance's. It is the MERGE THRESHOLD now,
   * because Enhance no longer folds colour groups at all — the lap-6 finding
   * next door (tests/engine/parity.test.mjs, "the fold that costs the colours
   * is one the user can turn off") was fixed by taking the unreachable
   * sub-1 % fold out of the bundle rather than by making it reversible. The
   * contract under test is unchanged and so is every assertion: a shortfall the
   * SETTINGS caused must not be reported as the image running out. Driving it
   * from the control that now owns the fold is also the stricter reading — it
   * is the one a user can actually reproduce from the panel.
   */
  await loadViaPicker(page, FIXTURE.fox);
  await waitForReady(page);

  // Every cleanup off first — Smart anti-aliasing is on by default (it is what
  // the real product does, and what keeps the default output economical), and
  // its near-duplicate colour fold is itself a settings-shortfall. The baseline
  // this check needs is the one with nothing folding.
  await setSelect(page, TESTIDS.settingAntiAliasing, 'off');
  await waitForReady(page);
  await pickSize(page, 16);
  const plain = await hintOf(page);
  expect(
    Number(plain.actual),
    'the gold-standard artwork should supply a full 16-colour palette with no cleanup on',
  ).toBe(16);
  expect(plain.shortfall, 'nothing is short here').toBe('none');

  await setSelect(page, TESTIDS.colorMergeThreshold, '5');
  await waitForReady(page);
  const folded = await hintOf(page);
  expect(Number(folded.actual)).toBeLessThan(16);
  expect(
    folded.shortfall,
    `the palette fell from ${plain.actual} to ${folded.actual} because the merge threshold folded ` +
      'colour groups, so the hint must attribute it to the settings, not the image',
  ).toBe('settings');
  expect(
    folded.text.toLowerCase(),
    `hint reads "${folded.text}" — the image had ${plain.actual} colours to give at these very ` +
      'settings a moment ago',
  ).not.toContain('no more to give');
});

test('[B3] a genuinely short palette is still reported as the image running out', async ({
  page,
}) => {
  // The other side of the same contract: the flat fixture really does have only
  // six colours, so asking for 16 is the image's limit and the hint must say so.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await pickSize(page, 16);

  const hint = await hintOf(page);
  expect(Number(hint.actual)).toBeLessThan(16);
  expect(hint.shortfall, 'a six-colour source asked for 16 — that shortfall IS the image').toBe(
    'image',
  );
});

test('[B3] Auto palette restores the palette the edit replaced', async ({ page }) => {
  /**
   * Driving the app: candidate size 16 -> palette 10 -> recolour one swatch ->
   * "Auto palette" and the palette comes back as 8, with the COLORS slider left
   * at 10 and the 16 chip no longer selected. Editing a swatch rewrites
   * `colorCount` to the palette length, and Auto only clears `settings.palette`,
   * so it recomputes at the mutated count. There is no way back to the result
   * the user was looking at except re-clicking the radio — which is exactly the
   * undo the button is advertising.
   */
  await loadViaPicker(page, FIXTURE.fox);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.enhanceToggle)).click();
  await waitForReady(page);
  await pickSize(page, 16);

  const swatches = page.locator(tid(TESTIDS.paletteSwatch));
  const before = await swatches.count();
  expect(before).toBeGreaterThan(0);
  const chip16 = page.locator(`${tid(TESTIDS.paletteSizeOption)}[data-size="16"]`);
  await expect(chip16).toHaveAttribute('aria-checked', 'true');

  await swatches.first().click();
  await setColorInput(page, '#ff00ff');
  await waitForReady(page);

  await page.locator(tid(TESTIDS.paletteAutoButton)).click();
  await waitForReady(page);

  expect(
    await swatches.count(),
    `Auto palette came back with a different palette (${await swatches.count()} entries, was ` +
      `${before}) — it recomputed at the colour count the edit left behind instead of restoring ` +
      'the palette it is offering to restore',
  ).toBe(before);
  await expect(
    chip16,
    'the candidate palette size that produced the restored palette is no longer selected',
  ).toHaveAttribute('aria-checked', 'true');
});
