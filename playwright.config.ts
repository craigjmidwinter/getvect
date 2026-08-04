import { defineConfig } from '@playwright/test';

/**
 * Acceptance suite config.
 *
 * Electron is driven through Playwright's `_electron` launcher — no browser
 * download is needed (do NOT run `npx playwright install`; the suite uses the
 * Electron binary from node_modules).
 *
 * `npm test` runs `npm run build` first (see the `pretest` script) because the
 * suite always exercises the built bundle, never the dev server.
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './artifacts/test-results',
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Vectorizing a 1024px fixture is allowed 10s (REFERENCE "Responsiveness"),
  // plus Electron boot and asset decode.
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/e2e-results.json' }],
    ['html', { outputFolder: 'artifacts/e2e-report', open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Keep the red-suite feedback loop short: a missing testid should fail in
    // seconds, not sit on Playwright's 30s default.
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },
});
