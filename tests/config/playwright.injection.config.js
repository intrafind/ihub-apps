// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defineConfig, devices } from '@playwright/test';
import { CLIENT_PORT } from '../security/injection/scenario.mjs';

/**
 * The prompt-injection blast-radius suite (`tests/security/injection/`): the model
 * is assumed fully compromised by a planted document and obeys it; the specs
 * assert what the platform still prevents. It runs on its own server, ports and
 * contents directory (`contents-e2e-injection`, recreated on every run), with a
 * scripted model stub and a local canary, so it needs no network and no model key.
 */
export default defineConfig({
  testDir: '../security/injection',
  testMatch: '*.spec.js',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 90 * 1000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../security/injection/playwright-report' }]
  ],
  // Its own directories: another suite's run cleans its own output directory.
  outputDir: '../security/injection/test-results',
  use: {
    baseURL: `http://127.0.0.1:${CLIENT_PORT}`,
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
    command: 'node tests/security/injection/injection-server.mjs',
    cwd: '../..',
    url: `http://127.0.0.1:${CLIENT_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180 * 1000
  }
});
