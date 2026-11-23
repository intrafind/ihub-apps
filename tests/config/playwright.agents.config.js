// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, OVERLAY_NAME } from './agents-scenario.mjs';

/**
 * The agents end-to-end suite (`tests/e2e-agents/`): runs, sub-agents, follow-ups
 * and workflow steps in a real browser against the real server, with the scripted
 * model stub (`e2e-llm-stub.mjs`) in place of a model. It runs on its own server,
 * ports and contents directory (`contents-e2e-agents`, recreated on every run), so
 * it needs no network and no model key. Run with `npm run test:e2e:agents`.
 *
 * One worker and no retries: the specs share one server and one stub, and a retry
 * would hide the flakiness the suite is there to surface. Every test carries the
 * tag `@gate`, `@matrix` or `@slow`; `agents-run.mjs` picks by them.
 */
export default defineConfig({
  testDir: '../e2e-agents',
  testMatch: '*.spec.js',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60 * 1000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `../e2e-agents/playwright-report/${OVERLAY_NAME}` }]
  ],
  // Its own directories, one per overlay of the matrix: another run cleans its own.
  outputDir: `../e2e-agents/test-results/${OVERLAY_NAME}`,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // An environment whose Chromium is not the one this Playwright expects.
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {}
      }
    }
  ],
  webServer: {
    command: 'node tests/config/agents-server.mjs',
    cwd: '../..',
    // Ready once the API answers through the client's public port (the Vite proxy).
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180 * 1000
  }
});
