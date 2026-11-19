// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the production build (`dist/`, as `npm run build:docker` makes it and the
 * container image ships it) as the target of the DAST workflow (`.github/workflows/dast.yml`):
 * ZAP and Nuclei attack this server, so it must behave like a customer installation,
 * not like the dev server (no Vite, `NODE_ENV=production`, the real static routes and
 * headers).
 *
 * The contents are a fresh install in `contents-e2e-dast/`, seeded the way the e2e
 * suites seed theirs (`tests/config/e2e-contents.mjs`): rate limits raised (a scanner
 * sends thousands of requests and would otherwise measure the 429 page), the remote
 * marketplace off, and one default model served by the local stub, so a chat turn
 * runs without a model key. Everything else, including the default `admin` /
 * `password123` account, is as shipped.
 *
 * Environment (all optional): `DAST_SERVER_PORT` (3000), `DAST_LLM_PORT` (8979),
 * `JWT_SECRET` (a throwaway value). Runs until it is killed; the stub lives in this
 * process, so keep it running for the whole scan.
 *
 *   npm run build:docker && node tests/security/dast/start-target.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from '../../config/e2e-contents.mjs';
import { removeDisposableContents } from '../../config/e2e-fresh-contents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTENTS_DIR = 'contents-e2e-dast';
const SERVER_PORT = Number(process.env.DAST_SERVER_PORT) || 3000;
const LLM_PORT = Number(process.env.DAST_LLM_PORT) || 8979;
const distServer = path.join(root, 'dist', 'server', 'server.js');

if (!fs.existsSync(distServer)) {
  console.error(`${distServer} not found: run \`npm run build:docker\` first.`);
  process.exit(1);
}

// Seed with the source tree's bootstrap (it reads CONTENTS_DIR when first imported).
process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;
removeDisposableContents(root, CONTENTS_DIR);
await prepareE2eContents({ root, contentsDir: CONTENTS_DIR, llmPort: LLM_PORT });

const server = spawn(process.execPath, [distServer], {
  cwd: path.join(root, 'dist'),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    WORKERS: '1',
    PORT: String(SERVER_PORT),
    // Absolute: the dist server resolves a relative path against dist/.
    CONTENTS_DIR: path.join(root, CONTENTS_DIR),
    JWT_SECRET: process.env.JWT_SECRET || 'dast-throwaway-jwt-secret'
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
