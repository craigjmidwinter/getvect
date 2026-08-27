/**
 * BOTH COLOUR CONTROLS DISCARD A HAND-EDITED PALETTE. THE SAME WAY.
 *
 * `colorCount` has two controls — the Colors slider in the model column
 * (App.tsx ~1536) and the Input palette chips (~1897). One value, two idioms,
 * two panels, two ranges. That duplication is a design defect and is written up
 * for the redesign; this spec is not about the duplication.
 *
 * It is about the thing that would be a REAL bug if the two ever diverged: a
 * hand-edited palette surviving a change to the colour count. Edit a swatch,
 * ask for a different number of colours, and get back a palette that is partly
 * your edit and partly a fresh computation — a state no control describes and
 * nobody can reason about.
 *
 * Both paths clear `palette` and `disabledColors` today, deliberately: "a colour
 * count is a fresh palette by definition". Nothing enforced it. Two controls
 * writing one value is exactly the shape where one gets updated and the other
 * does not, and the survivor of the coming redesign must keep this behaviour
 * whichever one it is.
 *
 * Written while scoping that redesign, to check a reported defect that turned
 * out not to exist. Recording the absence as a test is worth more than
 * recording it in a message: the next person to touch either control finds out
 * from the suite rather than from a user.
 */
import {
  FIXTURE,
  TESTIDS,
  expect,
  loadViaPicker,
  setSlider,
  tid,
  test,
  waitForReady,
} from './helpers';

/** The fills of the current palette, in order — the thing an edit changes. */
async function paletteFills(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator(tid(TESTIDS.paletteSwatch)).evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.color ?? ''),
  );
}

test.describe('changing the colour count discards palette edits', () => {
  for (const control of ['slider', 'chips'] as const) {
    test(`via the ${control}`, async ({ page }) => {
      await loadViaPicker(page, FIXTURE.mascot ?? FIXTURE.flat512);
      await waitForReady(page);

      const before = await paletteFills(page);
      expect(before.length, 'no palette to edit').toBeGreaterThan(2);

      // Hand-edit: remove a swatch. Unambiguous and easy to observe — the
      // palette gets shorter, and `palette` is now a user-authored list rather
      // than something the engine computed.
      await page.locator(tid(TESTIDS.paletteSwatch)).first().click();
      await page.locator(tid(TESTIDS.paletteRemoveButton)).click();
      await waitForReady(page);

      const edited = await paletteFills(page);
      expect(
        edited.length,
        'the removal did not take, so the rest of this test proves nothing',
      ).toBeLessThan(before.length);

      // Now ask for a different colour count, through whichever control.
      if (control === 'slider') {
        // The suite's own helper. A hand-rolled `input.value = …` plus a
        // dispatched event does NOT drive a React-controlled range — React
        // overrides the value setter, so the component never sees the change.
        // The first version of this spec did that and reported the product
        // broken when the test was.
        await setSlider(page, TESTIDS.settingColorCount, 6);
      } else {
        await page.locator(`${tid(TESTIDS.paletteSizeOption)}[data-size="6"]`).click();
      }
      await waitForReady(page);

      const after = await paletteFills(page);
      expect(
        after.length,
        `the hand-edited palette survived a colour-count change via the ${control}: it is ` +
          'still the shortened list, so the palette is part edit and part fresh computation, ' +
          'a state no control on screen describes',
      ).toBeGreaterThan(edited.length);
    });
  }
});
