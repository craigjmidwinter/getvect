/**
 * C5 — the transparency checkerboard is a property of the VIEW, not of the
 * artwork.
 *
 * Reported at 717%: "the chessboard breaks about half way through" and "it
 * looks affected by the vectorized content". Both follow from drawing the
 * checker anywhere except an underlay under each view — a background on the
 * zoomed content box ends where the artwork ends and scales with it; a single
 * tiling stretched across the whole pane is interrupted by the gap and the
 * divider between the two views, so the pattern steps half a cell down the
 * middle of the side-by-side.
 *
 * What the checker means is "there is nothing here", so it belongs to the
 * window you are looking through: every pixel of every view, the same cell size
 * at every zoom, the same phase in both halves, and continuous across the edge
 * of the artwork — the only thing that may hide it is opaque paint.
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
import type { Page } from '@playwright/test';

interface Run {
  colour: string;
  x: number;
  length: number;
}

/**
 * Run-length encode a scanline for as long as it stays one of the two colours
 * it starts with — i.e. for as long as it is checkerboard.
 */
function checkerRuns(img: PanePixels, yCss: number, fromCss = 0): Run[] {
  const y = Math.round(yCss * img.scale);
  const runs: Run[] = [];
  const palette = new Set<string>();
  for (let x = Math.round(fromCss * img.scale); x < img.width; x++) {
    const colour = img.rgb(x, y);
    if (!palette.has(colour)) {
      if (palette.size === 2) break; // artwork
      palette.add(colour);
    }
    const last = runs[runs.length - 1];
    if (last && last.colour === colour) last.length++;
    else runs.push({ colour, x, length: 1 });
  }
  return runs;
}

/** Same, down a column. */
function checkerRunsDown(img: PanePixels, xCss: number, fromCss: number, toCss: number): Run[] {
  const x = Math.round(xCss * img.scale);
  const runs: Run[] = [];
  const palette = new Set<string>();
  for (let y = Math.round(fromCss * img.scale); y < Math.round(toCss * img.scale); y++) {
    const colour = img.rgb(x, y);
    if (!palette.has(colour)) {
      if (palette.size === 2) break;
      palette.add(colour);
    }
    const last = runs[runs.length - 1];
    if (last && last.colour === colour) last.length++;
    else runs.push({ colour, x: y, length: 1 });
  }
  return runs;
}

/** Full runs only: the first and last are clipped by where the scan started/stopped. */
const interior = (runs: Run[]) => runs.slice(1, -1);

/**
 * Where the artwork's left edge sits inside a view, in CSS pixels from the
 * view's own left edge. Straight out of the stage geometry in Preview.tsx:
 * an image point p lands at `viewWidth / 2 + zoom * (p + pan - imageWidth / 2)`.
 */
async function artworkLeftEdge(page: Page, imageWidth: number): Promise<number> {
  const view = page.locator(tid(TESTIDS.previewVector));
  const { zoom, panX, width } = await view.evaluate((el) => ({
    zoom: Number(el.getAttribute('data-zoom')),
    panX: Number(el.getAttribute('data-pan-x')),
    width: el.getBoundingClientRect().width,
  }));
  return width / 2 + zoom * (panX - imageWidth / 2);
}

/** Drag far enough that the pan hits its clamp, so the framing is repeatable. */
async function panToClamp(page: Page) {
  const box = await page.locator(tid(TESTIDS.previewPane)).boundingBox();
  if (!box) throw new Error('preview pane has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 900, cy, { steps: 12 });
  await page.mouse.up();
}

test('[C5] the checkerboard is a per-view underlay, unbroken across the edge of the artwork', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.stickerAlpha);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await zoomTo(page, 4);
  await panToClamp(page);
  await waitForSettledRender(page);

  // Panned to the clamp at 400%, the left of each view is off the edge of the
  // 256px artwork and the rest of the way to the ring is transparent artwork —
  // the two regions the report says behave differently.
  const edge = await artworkLeftEdge(page, 256);
  expect(edge, 'framing: the artwork edge is not inside the view').toBeGreaterThan(40);

  const scanned: Record<string, Run[]> = {};
  for (const [name, id] of [
    ['original', TESTIDS.previewOriginal],
    ['vector', TESTIDS.previewVector],
  ] as const) {
    const img = await capturePane(page, id);
    const middle = img.height / img.scale / 2;
    const runs = checkerRuns(img, middle);
    const full = interior(runs);
    const cells = new Set(full.map((r) => r.length / img.scale));
    const colours = new Set(runs.map((r) => r.colour));

    console.log(
      `[C5] ${name} @400%: ${runs.length} runs, cell sizes ${[...cells].join('/')}, ` +
        `colours ${[...colours].join(' ')}, artwork edge at ${edge.toFixed(1)}px, ` +
        `checker to ${(runs[runs.length - 1].x + runs[runs.length - 1].length) / img.scale}px`,
    );

    expect(colours.size, `${name}: the checkerboard is not two colours`).toBe(2);
    expect(full.length, `${name}: too little checkerboard to measure`).toBeGreaterThanOrEqual(4);
    expect(
      [...cells],
      `${name}: the checker cells are not all the same size (${[...cells].join('/')}) — a seam, ` +
        'which is what a background that belongs to the content box looks like where the ' +
        'content box ends',
    ).toHaveLength(1);

    const last = runs[runs.length - 1];
    expect(
      (last.x + last.length) / img.scale,
      `${name}: the checkerboard stops at ${(last.x + last.length) / img.scale}px but the ` +
        `artwork's own edge is at ${edge.toFixed(1)}px — it is being drawn on the artwork ` +
        'rather than under the view',
    ).toBeGreaterThan(edge + 4);
    expect(
      runs[0].x / img.scale,
      `${name}: the checkerboard does not reach the left edge of the view`,
    ).toBe(0);

    scanned[name] = runs;
  }

  // Both halves of a comparison need the same background, or the eye reads the
  // difference between the backgrounds as a difference between the results.
  // Interior runs only: the last one is clipped by wherever that view's own
  // artwork starts, and the traced ring does not land on the same pixel as the
  // raster one — that is the subject of C4, not of the background.
  const phase = (runs: Run[]) =>
    interior(runs)
      .slice(0, 8)
      .map((r) => `${r.x}:${r.colour}:${r.length}`);
  expect(
    phase(scanned.vector),
    'the ORIGINAL and VECTOR views draw the checkerboard at different phases',
  ).toEqual(phase(scanned.original));
});

test('[C5] the checkerboard is drawn in UI space — the cell size does not follow the zoom', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.stickerAlpha);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();

  const measured: Record<number, { cell: number; colours: string[]; phase: number }> = {};
  for (const zoom of [4, 7]) {
    await zoomTo(page, zoom);
    await panToClamp(page);
    await waitForSettledRender(page);

    for (const id of [TESTIDS.previewOriginal, TESTIDS.previewVector]) {
      const img = await capturePane(page, id);
      const runs = checkerRuns(img, img.height / img.scale / 2);
      const full = interior(runs);
      // One unclipped cell is all 700% leaves visible before the artwork's own
      // ink starts — enough to state its size and its phase, which is the claim.
      expect(
        full.length,
        `at ${zoom * 100}% there is no unclipped checker cell to measure`,
      ).toBeGreaterThanOrEqual(1);
      const cells = new Set(full.map((r) => r.length / img.scale));
      expect([...cells], `at ${zoom * 100}% the cells differ in size`).toHaveLength(1);

      // Rounded: a view whose CSS width is fractional captures at a scale that
      // is not exactly 1, and the claim is about the pattern, not float noise.
      const round = (n: number) => Math.round(n * 100) / 100;
      const seen = {
        cell: round([...cells][0]),
        colours: runs.map((r) => r.colour).slice(0, 2),
        phase: round(full[0].x / img.scale),
      };
      const previous = measured[zoom];
      if (previous) expect(seen, `${id} disagrees with the other view at ${zoom * 100}%`).toEqual(previous);
      measured[zoom] = seen;
    }
    console.log(`[C5] @${zoom * 100}%: cell ${measured[zoom].cell}px, colours ${measured[zoom].colours.join(' ')}`);
  }

  expect(
    measured[7],
    `the checkerboard cell is ${measured[4].cell}px at 400% and ${measured[7].cell}px at 700% — ` +
      'it is being scaled with the artwork, so it reads as part of the picture',
  ).toEqual(measured[4]);
  expect(measured[4].cell, 'implausible checker cell size').toBeGreaterThan(3);
});

test('[C5] it is a checkerboard, not stripes, and nothing above it tints it', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.stickerAlpha);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await zoomTo(page, 4);
  await panToClamp(page);
  await waitForSettledRender(page);

  const edge = await artworkLeftEdge(page, 256);
  for (const id of [TESTIDS.previewOriginal, TESTIDS.previewVector]) {
    const img = await capturePane(page, id);
    const cell = interior(checkerRuns(img, img.height / img.scale / 2))[0].length / img.scale;

    // A column that is entirely off the edge of the artwork: below the view
    // label, and to the left of where the picture starts.
    const x = Math.round(edge / 2);
    const down = interior(checkerRunsDown(img, x, 40, 300));
    expect(down.length, `${id}: no vertical checker structure`).toBeGreaterThanOrEqual(4);
    expect(
      [...new Set(down.map((r) => r.length / img.scale))],
      `${id}: the vertical cells are uneven — the underlay is not a clean tiling`,
    ).toEqual([cell]);

    const y = down[1].x / img.scale + 1;
    const s = Math.round(cell);
    expect(img.rgb(Math.round(x * img.scale), Math.round(y * img.scale))).not.toBe(
      img.rgb(Math.round((x + s) * img.scale), Math.round(y * img.scale)),
    );
    expect(
      img.rgb(Math.round(x * img.scale), Math.round(y * img.scale)),
      `${id}: diagonal neighbours differ — this is stripes, not a checkerboard`,
    ).toBe(img.rgb(Math.round((x + s) * img.scale), Math.round((y + s) * img.scale)));
  }
});
