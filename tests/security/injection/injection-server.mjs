// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the stack of the prompt-injection suite (`webServer.command` of
 * `tests/config/playwright.injection.config.js`):
 *
 * 1. a fresh `contents-e2e-injection/` seeded like every e2e run
 *    (`e2e-contents.mjs`), with the model stub answering as the compromised
 *    model (`compromisedModel.mjs`), plus the suite's own apps, projects,
 *    documents, users and planted secrets (`seed.mjs`);
 * 2. the attacker's canary and the internal listener (`canary.mjs`);
 * 3. the iHub server (on `127.0.0.1` only) and the Vite client, as `npm run dev`
 *    does, with planted secrets in the server's environment.
 *
 * Ports and the directory are the suite's own (`scenario.mjs`), so it runs next
 * to another suite in the same checkout.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from '../../config/e2e-contents.mjs';
import { e2eContentsDir, removeDisposableContents } from '../../config/e2e-fresh-contents.mjs';
import { compromisedModel } from './compromisedModel.mjs';
import { startCanary } from './canary.mjs';
import { CANARY_PAGES, seedInjectionContents } from './seed.mjs';
import {
  CANARY_PORT,
  CLIENT_PORT,
  CONTENTS_DIR,
  LLM_PORT,
  SERVER_PORT,
  SERVER_SECRET_ENV
} from './scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Refuses anything but a `contents-e2e*` directory inside the repository.
const contentsDir = e2eContentsDir(root, { E2E_CONTENTS_DIR: CONTENTS_DIR });

process.chdir(root);
// Before any server module is imported: they read it once.
process.env.CONTENTS_DIR = contentsDir;
removeDisposableContents(root, contentsDir);

await prepareE2eContents({
  root,
  contentsDir,
  llmPort: LLM_PORT,
  stubOptions: { script: compromisedModel }
});
const bcrypt = createRequire(path.join(root, 'server', 'package.json'))('bcryptjs');
seedInjectionContents(path.resolve(root, contentsDir), {
  passwordHash: password => bcrypt.hashSync(password, 10)
});
await startCanary({ port: CANARY_PORT, pages: CANARY_PAGES });

const api = `http://127.0.0.1:${SERVER_PORT}`;
const server = spawn(
  path.join(root, 'node_modules', '.bin', 'concurrently'),
  [
    '--kill-others-on-fail',
    'npm run server',
    `sleep 2 && cd client && npx vite --host 127.0.0.1 --port ${CLIENT_PORT} --strictPort`
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...SERVER_SECRET_ENV,
      NODE_ENV: 'development',
      WORKERS: '1',
      CONTENTS_DIR: contentsDir,
      // Only loopback 127.0.0.1: the canary's allowlisted 127.0.0.2 must not
      // also reach the iHub API.
      HOST: '127.0.0.1',
      PORT: String(SERVER_PORT),
      VITE_API_TARGET: api
    }
  }
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
