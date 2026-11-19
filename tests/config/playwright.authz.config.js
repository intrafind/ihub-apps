// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defineConfig } from '@playwright/test';

/**
 * The cross-user authorization suite (`tests/security/authz/`): API requests
 * only, no browser and no Vite client. It runs on its own API server, port and
 * contents directory (`contents-e2e-authz`, recreated on every run, see
 * `authz-server.mjs`), with the model served by a local stub: no network and no
 * model key. The specs share alice's seeded resources, so they run in one worker.
 */
const SERVER_PORT = Number(process.env.AUTHZ_SERVER_PORT) || 3301;
const LLM_PORT = Number(process.env.AUTHZ_LLM_PORT) || 8991;

export default defineConfig({
  testDir: '../security/authz',
  testMatch: '*.spec.js',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 120 * 1000,
  reporter: [['list']],
  // Its own output directory: Playwright empties it at the start of a run, and
  // other suites may be running from this directory at the same time.
  outputDir: 'test-results/authz',
  use: { baseURL: `http://localhost:${SERVER_PORT}` },
  webServer: {
    command: 'node tests/config/authz-server.mjs',
    cwd: '../..',
    env: {
      AUTHZ_CONTENTS_DIR: 'contents-e2e-authz',
      AUTHZ_SERVER_PORT: String(SERVER_PORT),
      AUTHZ_LLM_PORT: String(LLM_PORT),
      // `0` runs the whole suite with anonymous access off (default: on).
      AUTHZ_ANONYMOUS: process.env.AUTHZ_ANONYMOUS ?? '1'
    },
    url: `http://localhost:${SERVER_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180 * 1000
  }
});
