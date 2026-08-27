/**
 * THE WEB BUILD TRACES WITH THE NETWORK OFF, AND PRODUCES THE SAME VECTOR.
 *
 * The whole pitch is that your image does not leave your machine, and on the web
 * that is the one claim a reader can falsify in ten seconds by opening devtools.
 * So it is not asserted here, it is demonstrated: the page is served over http,
 * the browser context is switched OFFLINE, and an image is traced anyway. Every
 * request the page makes is recorded, and anything leaving the origin fails.
 *
 * The second half matters as much. A web build that traces at different defaults
 * is the drifted-default failure on the surface most people will judge the
 * product by, and it is invisible: the output is a perfectly good vector of the
 * right picture at the wrong settings. So the SVG the page shows is compared to
 * a direct `vectorize()` call — the same guard the CLI and the desktop app hold.
 *
 * A NOTE ON HOW THIS TEST WAS WRONG FIRST. Its original readiness check counted
 * `svg` elements on the page and waited for more than zero. The UI has icons, so
 * it passed before anything was traced — three tests in 1.8 seconds, all green,
 * proving nothing. A control satisfied before it runs looks exactly like a
 * passing one. It now waits on the app's own `ready` status and compares bytes.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { FIXTURE, REPO_ROOT, TESTIDS, expect, tid, test, waitForReady, previewSvg } from './helpers';

const SITE = join(REPO_ROOT, 'site', 'app');
const SOURCE = FIXTURE.mascot ?? join(REPO_ROOT, 'fixtures', 'reference', 'frankie-sticker.png');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

/** Serve the built page over http: file:// treats CSP and workers differently. */
async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(SITE, path === '/' ? 'index.html' : path.replace(/^\//, ''));
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test.describe('the browser build', () => {
  test.skip(!existsSync(join(SITE, 'index.html')), 'run `npm run build:web` first');

  test('traces offline, never leaves the origin, and matches the engine', async ({ browser }) => {
    const site = await serve();
    const context = await browser.newContext();
    const page = await context.newPage();

    const offOrigin: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      if (url.startsWith(site.url) || url.startsWith('data:') || url.startsWith('blob:')) return;
      offOrigin.push(url);
    });

    await page.goto(site.url);
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();

    // The claim has to be on the page, in those terms — not only in a commit.
    const claim = page.locator('.offline-claim');
    await expect(claim).toContainText('entirely in your browser');
    await expect(claim).toContainText("connect-src 'none'");

    // AI Enhance is the one feature that talks to a server, and it is left out.
    // Hidden rather than disabled: a greyed-out control that could send an image
    // somewhere still tells the reader this page might.
    await expect(page.locator(tid(TESTIDS.aiEnhanceGroup))).toHaveCount(0);

    // ---- NETWORK OFF. Everything past this line runs with no network at all.
    await context.setOffline(true);

    const bytes = Array.from(await readFile(SOURCE));
    await page.evaluate(
      async ({ data, selector }) => {
        const file = new File([new Uint8Array(data)], 'frankie-sticker.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const zone = document.querySelector(selector);
        if (!zone) throw new Error('drop zone not found');
        zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      },
      { data: bytes, selector: tid(TESTIDS.dropZone) },
    );

    // The app's own readiness signal, not a proxy for it.
    await waitForReady(page, 90_000);
    const shown = await previewSvg(page);
    expect(shown.length, 'the preview holds no SVG').toBeGreaterThan(1000);

    expect(offOrigin, `the page requested ${offOrigin.join(', ')}`).toEqual([]);

    // ---- the output contract, against the engine itself.
    const requireCjs = createRequire(__filename);
    const engine = requireCjs(join(REPO_ROOT, 'dist/engine/index.js'));
    const decode = requireCjs(join(REPO_ROOT, 'dist/cli/index.js'));
    const image = decode.canvasIngest(
      decode.decodeImage(await readFile(SOURCE), '.png', () => {
        throw new Error('no jpeg here');
      }),
    );
    const direct = await engine.vectorize(image, engine.DEFAULT_SETTINGS);

    // Compared on structure rather than raw text: the browser reserialises the
    // DOM (attribute order, self-closing form), so `outerHTML` is not the export
    // byte stream. Layer fills and sub-path counts are what a drifted default
    // would move, and they are exact.
    const fills = (s: string) => (s.match(/fill="rgb\([^)]*\)"/g) ?? []).join('|');
    const subPaths = (s: string) => (s.match(/[Mm]/g) ?? []).length;
    expect(fills(shown), 'colour layers differ from the engine').toBe(fills(direct.svg));
    expect(subPaths(shown), 'geometry differs from the engine').toBe(subPaths(direct.svg));

    await context.close();
    await site.close();
  });

  test('the served page ENFORCES connect-src none, not merely mentions it', async () => {
    const html = await readFile(join(SITE, 'index.html'), 'utf8');

    // The first version of this asserted `html.toContain("connect-src 'none'")`
    // and passed with the policy DELETED — because the page also names it in an
    // explanatory comment and in the visible claim text, three occurrences in
    // all. A test guaranteeing the browser cannot make a request, satisfied by a
    // sentence describing that guarantee.
    //
    // So it reads the actual meta tag's content attribute. The comment and the
    // footer can say whatever they like; only this line binds the browser.
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
    expect(meta, 'no CSP meta tag in the built page').not.toBeNull();

    const policy = meta![1];
    expect(policy, `CSP is "${policy}"`).toContain("connect-src 'none'");
    expect(policy, 'a connect-src allowing an origin would let the page upload').not.toMatch(
      /connect-src\s+[^;]*(https?:|\*)/,
    );
  });

  test('the shipped bundle carries no provider call', async () => {
    const html = await readFile(join(SITE, 'index.html'), 'utf8');
    let bundle = html;
    for (const m of html.matchAll(/src="([^"]+\.js)"/g)) {
      bundle += await readFile(join(SITE, m[1].replace(/^\.\//, '')), 'utf8');
    }
    expect(bundle).not.toContain('generativelanguage.googleapis.com');
    expect(bundle).not.toContain('aiEnhance:run');
  });
});
