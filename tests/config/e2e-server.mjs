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
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from './e2e-contents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = 'contents-e2e';
const LLM_PORT = Number(process.env.E2E_LLM_PORT) || 8979;

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;

await prepareE2eContents({ root, contentsDir: CONTENTS_DIR, llmPort: LLM_PORT });

// The `dev` script of package.json (server and client with hot reload), started
// through the repository's own `concurrently` rather than a PATH lookup of `npm`.
const server = spawn(
  path.join(root, 'node_modules', '.bin', 'concurrently'),
  ['--kill-others-on-fail', 'npm run server', 'sleep 2 && npm run client'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', WORKERS: '1', CONTENTS_DIR }
  }
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
