// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defineConfig, devices } from '@playwright/test';

/**
 * The app builder suite (`tests/e2e/app-builder.spec.js`): creating an app from
 * the list to the first answer in the test chat, the draft from a description,
 * publishing, and the same as a content admin who is not an administrator.
 *
 * It runs on its own server, ports and contents directory
 * (`contents-e2e-app-builder`, recreated on every run), never on a server
 * another suite or a developer is using, for two reasons:
 *
 * - two cases change state every other test depends on (one disables the only
 *   model, one removes the app wildcard of the group `authenticated`), which is
 *   also why the suite has **one worker**;
 * - the default config reuses a running dev server, which has no stub model, so
 *   no draft and no test answer.
 *
 * The contents seed (`app-builder-seed.mjs`) adds a content-admin group and a
 * user in it, which a fresh install does not have. The model is the local stub
 * (`e2e-llm-stub.mjs`), which answers a description that carries an `e2e-app-*`
 * marker with the draft of an app.
 *
 * Run with `npm run test:e2e:app-builder -- --project=chromium --retries=0`.
 *
 * `E2E_APP_BUILDER_KEEP_SERVER=1` reuses a server that is already running on the
 * suite's ports (start it once with the `webServer` command and environment
 * below) and keeps its contents: for working on the spec, not for a result.
 * The server allows 30 drafts per person per hour and counts failed ones; one
 * run asks for 12 as the administrator, so a kept server refuses drafts in the
 * third run within an hour.
 */
const SERVER_PORT = Number(process.env.E2E_APP_BUILDER_SERVER_PORT) || 3085;
const CLIENT_PORT = Number(process.env.E2E_APP_BUILDER_CLIENT_PORT) || 5185;
const LLM_PORT = Number(process.env.E2E_APP_BUILDER_LLM_PORT) || 8985;
const KEEP_SERVER = process.env.E2E_APP_BUILDER_KEEP_SERVER === '1';

/**
 * How long the stub holds back the answer to a description that contains
 * `e2e-slow`. Longer than the server waits for a draft (80 seconds), so the
 * request ends in the server's timeout unless the author cancels first.
 */
const SLOW_ANSWER_MS = 110_000;

// The spec changes the model and the groups of the server it runs against. It
// skips itself unless this config started it (the default config would pick it
// up from the same directory), and it reads the stub's port from here.
process.env.E2E_APP_BUILDER = '1';
process.env.E2E_APP_BUILDER_LLM_URL = `http://127.0.0.1:${LLM_PORT}`;

export default defineConfig({
  testDir: '../e2e',
  testMatch: 'app-builder.spec.js',
  globalSetup: './app-builder-seed.mjs',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // One case waits for the server's 80-second draft timeout.
  timeout: 90 * 1000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/config/e2e-server.mjs',
    cwd: '../..',
    env: {
      E2E_CONTENTS_DIR: 'contents-e2e-app-builder',
      E2E_FRESH_CONTENTS: KEEP_SERVER ? '0' : '1',
      E2E_SERVER_PORT: String(SERVER_PORT),
      E2E_CLIENT_PORT: String(CLIENT_PORT),
      E2E_LLM_PORT: String(LLM_PORT),
      E2E_LLM_SLOW_MS: String(SLOW_ANSWER_MS)
    },
    // Ready once the API answers through the client's public port (the Vite proxy).
    url: `http://localhost:${CLIENT_PORT}/api/health`,
    reuseExistingServer: KEEP_SERVER,
    timeout: 180 * 1000
  }
});
