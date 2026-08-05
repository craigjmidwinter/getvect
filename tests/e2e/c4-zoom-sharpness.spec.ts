/**
 * C4 — zoom has to be a re-render, not a magnifying glass.
 *
 * The product is a side-by-side of pixels and curves. If the vector view is
 * scaled with `transform: scale()`, Chromium rasterizes it once at its layout
 * size and stretches that texture, so at 258% the "vector" half was exactly as
 * soft as the raster half — the app spent its whole argument on a blurry copy
 * of the thing it was arguing against. This spec measures that instead of
 * trusting it: it screenshots each view at 400% and counts how many pixels the
 * ink edge takes to go from paper to ink.
 *
 * The subject is `spikes-bands-384`, the one fixture with genuinely
 * antialiased edges: its outlines carry a one-pixel ramp in the source, so at
 * 400% the raster view has to spread that ramp over four pixels while the
 * vector view can re-draw the same edge in one. Both edges are found by
 * searching for the transition, not by hard-coded coordinates, so the numbers
 * survive the tracer changing what the spikes look like.
 */
import {
  FIXTURE,
  TESTIDS,
  capturePane,
  expect,
  loadViaPicker,
  test,
  tid,
  waitForReady,
  waitForSettledRender,
  zoomTo,
  type PanePixels,
} from './helpers';

/** The zoom the measurements are taken at. */
const ZOOM = 4;

/**
 * The first spike is the leftmost ~150 CSS px of the view in both panes at
 * 400%; the second one starts past 160. Searching only this far keeps "the
 * edge" unambiguous whatever shape the tracer gives the spike.
 */
const SEARCH_CSS = 150;

/**
 * View rows the spike row crosses in both panes at 400%, centred. Several,
 * and reduced to a median: where the source's own edge happens to land exactly
 * on a pixel boundary there is no ramp to measure on that line.
 */
const ROWS_CSS = [180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300];

interface Edge {
  /** Pixels strictly between the 20% and 80% luminance levels. */
  band: number;
  /** Longest run of one identical value inside that band — a hard pixel step. */
  step: number;
  /** Where the edge is, for reporting. */
  x: number;
}

/**
 * Measure the paper -> ink transition on one scanline.
 *
 * "Band" is the classic 20%-80% edge width, taken between the two levels the
 * scanline actually reaches rather than absolute black and white, so it does
 * not care what colours the tracer chose.
 */
function measureEdge(img: PanePixels, yCss: number): Edge | null {
  const y = Math.round(yCss * img.scale);
  const width = Math.min(img.width, Math.round(SEARCH_CSS * img.scale));
  const row: number[] = [];
  for (let x = 0; x < width; x++) row.push(img.lum(x, y));

  const hi = Math.max(...row);
  const lo = Math.min(...row);
  if (hi - lo < 100) return null; // no ink edge on this line
  const t20 = lo + 0.2 * (hi - lo);
  const t80 = lo + 0.8 * (hi - lo);

  let bright = -1;
  for (let x = 0; x < row.length; x++) {
    if (row[x] >= t80) bright = x;
    if (row[x] <= t20) {
      if (bright < 0) return null; // the line starts in ink
      let step = 0;
      let run = 0;
      for (let i = bright + 1; i < x; i++) {
        run = i > bright + 1 && Math.round(row[i]) === Math.round(row[i - 1]) ? run + 1 : 1;
        step = Math.max(step, run);
      }
      return { band: x - bright - 1, step, x: bright };
    }
  }
  return null;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function edges(img: PanePixels): Edge[] {
  const found = ROWS_CSS.map((y) => measureEdge(img, y)).filter((e): e is Edge => e !== null);
  expect(found.length, 'no ink edge was found on any scanline — wrong framing?').toBeGreaterThan(2);
  return found;
}

test('[C4] the vector view re-rasterizes at zoom instead of stretching a texture', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.spikes);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await zoomTo(page, ZOOM);
  await waitForSettledRender(page);

  const vectorImg = await capturePane(page, TESTIDS.previewVector);
  const originalImg = await capturePane(page, TESTIDS.previewOriginal);
  const vector = edges(vectorImg);
  const original = edges(originalImg);

  /**
   * The widest band each pane produces on any of the scanlines, in CSS pixels.
   *
   * The widest rather than the average, because a scanline where the source's
   * own edge lands on a pixel boundary has no ramp on it to measure: the
   * raster view is legitimately sharp there and reports 0. What separates the
   * two panes is what happens on the lines that DO carry a ramp — the vector
   * has to stay tight on every line, and the raster is allowed to be honest
   * about its pixels.
   */
  const worst = (es: Edge[], img: PanePixels) => Math.max(...es.map((e) => e.band)) / img.scale;
  const vectorBand = worst(vector, vectorImg);
  const originalBand = worst(original, originalImg);
  const report =
    `at ${ZOOM * 100}%: vector edge band ${vectorBand.toFixed(2)}px worst / ` +
    `${(median(vector.map((e) => e.band)) / vectorImg.scale).toFixed(2)}px median ` +
    `(${vector.map((e) => e.band).join(',')} raw), original ${originalBand.toFixed(2)}px worst / ` +
    `${(median(original.map((e) => e.band)) / originalImg.scale).toFixed(2)}px median ` +
    `(${original.map((e) => e.band).join(',')} raw), capture scale ${vectorImg.scale}`;
  console.log(report);

  expect(
    vectorBand,
    `${report} — the vector edge is spread over more than three pixels, which is what a ` +
      'texture stretched from the fit-size rasterization looks like. Zoom must change the ' +
      "SVG's layout size, not scale it (Preview.tsx).",
  ).toBeLessThanOrEqual(3);

  expect(
    originalBand,
    `${report} — the raster view is expected to smear its one-pixel source ramp over about ` +
      `${ZOOM} pixels at ${ZOOM}x. It did not, which means the two panes are not being ` +
      'measured on the same feature.',
  ).toBeGreaterThanOrEqual(2.5);

  expect(
    originalBand - vectorBand,
    `${report} — the vector edge has to be measurably tighter than the raster one; that ` +
      'difference is the entire product.',
  ).toBeGreaterThanOrEqual(2);
});

test('[C4] above 200% the original view shows its pixels instead of a blur', async ({ page }) => {
  /**
   * The other half of an honest comparison. Bilinear upscaling flatters the
   * source: it invents a smooth edge the pixels do not have, and then the
   * vector is compared against that invention. Past PIXELATE_ABOVE_ZOOM the
   * raster view switches to `image-rendering: pixelated` and the source shows
   * its true pixel grid — hard steps ~zoom pixels wide.
   */
  await loadViaPicker(page, FIXTURE.spikes);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();

  const raster = page.locator(`${tid(TESTIDS.previewOriginal)} img`);
  const rendering = () => raster.evaluate((el) => getComputedStyle(el).imageRendering);

  // Either side of the threshold rather than exactly on it: the wheel lands on
  // 2.000001, and which side of `zoom > 2` that falls is not the contract.
  await zoomTo(page, 1.9);
  await waitForSettledRender(page);
  expect(
    await rendering(),
    'at 200% and below the source is still smoothed — nearest-neighbour at 1:1 is not a ' +
      'truer picture, it is the same picture with resampling artefacts',
  ).not.toBe('pixelated');

  await zoomTo(page, 2.1);
  await waitForSettledRender(page);
  expect(await rendering(), 'the threshold is ~200%, not somewhere above it').toBe('pixelated');

  await zoomTo(page, ZOOM);
  await waitForSettledRender(page);
  expect(await rendering(), 'the original view is still smoothing at 400%').toBe('pixelated');

  const img = await capturePane(page, TESTIDS.previewOriginal);
  const original = edges(img);
  const step = Math.max(...original.map((e) => e.step)) / img.scale;
  console.log(
    `at ${ZOOM * 100}%: original pixel step ${step.toFixed(2)}px ` +
      `(${original.map((e) => e.step).join(',')} raw)`,
  );
  expect(
    step,
    `the raster edge climbs in ${step.toFixed(2)}px steps at ${ZOOM}x — a source pixel must ` +
      `cover ${ZOOM} pixels of screen as one flat block, not a gradient`,
  ).toBeGreaterThanOrEqual(ZOOM - 1);
});
