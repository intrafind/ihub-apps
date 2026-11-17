// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the dev server for the Playwright suites (`webServer.command`).
 *
 * The suites sign in dozens of times and call the admin API in bursts, which the
 * default rate limits (30 sign-ins per 15 minutes, 100 admin calls per minute)
 * answer with 429 halfway through a run. This script gives the run its own
 * `contents-e2e/` (git-ignored): a fresh install seeded the way the server seeds
 * `contents/`, with every rate limit raised and one default model served by a local
 * stub (`e2e-llm-stub.mjs`), so a chat turn runs end to end without a model key.
 * The remote marketplace is off, so pages do not depend on the network. Nothing
 * the specs create (users, prompts, tasks) ends up in a developer's real `contents/`.
 *
 * The directory is kept between runs; delete it to start from a fresh install.
 *
 * Another suite can run its own instance next to it (the admin safety suite,
 * `playwright.admin-safety.config.js`), through environment variables whose
 * defaults are the values above:
 *
 * - `E2E_CONTENTS_DIR` - the contents directory (default `contents-e2e`)
 * - `E2E_FRESH_CONTENTS=1` - delete that directory first, for a fresh install (only a
 *   directory inside the repository named `contents-e2e*`; anything else is refused)
 * - `E2E_SERVER_PORT` - the API server's port (default: the server's own, 3000)
 * - `E2E_CLIENT_PORT` - the Vite dev server's port (default: Vite's, 5173)
 * - `E2E_LLM_PORT` - the model stub's port (default 8979)
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from './e2e-contents.mjs';
import { removeDisposableContents } from './e2e-fresh-contents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = process.env.E2E_CONTENTS_DIR || 'contents-e2e';
const LLM_PORT = Number(process.env.E2E_LLM_PORT) || 8979;
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT) || null;
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT) || null;

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;
if (process.env.E2E_FRESH_CONTENTS === '1') {
  // Only a `contents-e2e*` directory inside the repository; anything else throws.
  removeDisposableContents(root, CONTENTS_DIR);
}

await prepareE2eContents({ root, contentsDir: CONTENTS_DIR, llmPort: LLM_PORT });

// The `dev` script of package.json (server and client with hot reload), started
// through the repository's own `concurrently` rather than a PATH lookup of `npm`.
// With E2E_CLIENT_PORT, Vite is started directly so the port can be passed (and
// held: --strictPort), and it proxies the API to E2E_SERVER_PORT (VITE_API_TARGET).
const clientCommand = CLIENT_PORT
  ? `sleep 2 && cd client && npx vite --host --port ${CLIENT_PORT} --strictPort`
  : 'sleep 2 && npm run client';
const portEnv = {
  ...(SERVER_PORT && { PORT: String(SERVER_PORT) }),
  ...(SERVER_PORT && { VITE_API_TARGET: `http://localhost:${SERVER_PORT}` })
};
const server = spawn(
  path.join(root, 'node_modules', '.bin', 'concurrently'),
  ['--kill-others-on-fail', 'npm run server', clientCommand],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', WORKERS: '1', CONTENTS_DIR, ...portEnv }
  }
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
