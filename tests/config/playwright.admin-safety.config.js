// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defineConfig, devices } from '@playwright/test';

/**
 * The admin safety guards suite (`tests/e2e/admin-safety-guards.spec.js`): it
 * tries to lock the only administrator out, so it runs on its own server, ports
 * and contents directory (`contents-e2e-safety`, recreated on every run), never
 * on a server another suite or a developer is using. Run with
 * `npm run test:e2e:admin-safety`.
 */
const SERVER_PORT = Number(process.env.E2E_SAFETY_SERVER_PORT) || 3083;
const CLIENT_PORT = Number(process.env.E2E_SAFETY_CLIENT_PORT) || 5183;
const LLM_PORT = Number(process.env.E2E_SAFETY_LLM_PORT) || 8983;

export default defineConfig({
  testDir: '../e2e',
  testMatch: 'admin-safety-guards.spec.js',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
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
      E2E_CONTENTS_DIR: 'contents-e2e-safety',
      E2E_FRESH_CONTENTS: '1',
      E2E_SERVER_PORT: String(SERVER_PORT),
      E2E_CLIENT_PORT: String(CLIENT_PORT),
      E2E_LLM_PORT: String(LLM_PORT)
    },
    // Ready once the API answers through the client's public port (the Vite proxy).
    url: `http://localhost:${CLIENT_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180 * 1000
  }
});
