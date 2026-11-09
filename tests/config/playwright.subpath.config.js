// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defineConfig, devices } from '@playwright/test';

/**
 * The route crawl against a deployment on a path prefix (`/ihub`): the production
 * build behind a proxy that adds `X-Forwarded-Prefix`, see subpath-server.mjs.
 * Build the client first (`cd client && npm run build`); run with
 * `npm run test:e2e:subpath`.
 */
const PREFIX = process.env.SUBPATH_PREFIX || '/ihub';
const PORT = Number(process.env.SUBPATH_PORT) || 5174;

process.env.CRAWL_BASE_PATH = PREFIX;

export default defineConfig({
  testDir: '../e2e',
  testMatch: 'route-crawl.spec.js',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/config/subpath-server.mjs',
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}${PREFIX}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000
  }
});
