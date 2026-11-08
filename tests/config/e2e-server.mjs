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

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUB_MODEL_ID, startLlmStub } from './e2e-llm-stub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = 'contents-e2e';
const RAISED_LIMIT = 1_000_000;
const LLM_PORT = Number(process.env.E2E_LLM_PORT) || 8979;

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;

// Seed and migrate exactly as a first start does (a pre-copied platform.json
// would make the migration runner treat the directory as an old installation).
const { prepareContents } = await import('../../server/startup/bootstrap.js');
await prepareContents();

const platformPath = path.join(root, CONTENTS_DIR, 'config', 'platform.json');
const platform = JSON.parse(fs.readFileSync(platformPath, 'utf8'));
platform.rateLimit = platform.rateLimit || {};
for (const key of [
  'default',
  'adminApi',
  'publicApi',
  'authApi',
  'oauthApi',
  'oauthTokenApi',
  'inferenceApi'
]) {
  platform.rateLimit[key] = { ...platform.rateLimit[key], limit: RAISED_LIMIT };
}
fs.writeFileSync(platformPath, `${JSON.stringify(platform, null, 2)}\n`);

// No remote marketplace: the catalog the page lists must not depend on the
// network (a fetched catalog of hundreds of items changes what the pages show).
const registriesPath = path.join(root, CONTENTS_DIR, 'config', 'registries.json');
if (fs.existsSync(registriesPath)) {
  const registries = JSON.parse(fs.readFileSync(registriesPath, 'utf8'));
  for (const registry of registries.registries || []) {
    registry.enabled = false;
    delete registry.lastSynced;
    delete registry.itemCount;
  }
  fs.writeFileSync(registriesPath, `${JSON.stringify(registries, null, 2)}\n`);
}
fs.rmSync(path.join(root, CONTENTS_DIR, '.registry-cache'), { recursive: true, force: true });

// One model, the default, served by a local stub (see e2e-llm-stub.mjs): a chat
// turn runs end to end without a model key or network.
await startLlmStub(LLM_PORT);
fs.writeFileSync(
  path.join(root, CONTENTS_DIR, 'models', 'e2e-stub.json'),
  `${JSON.stringify(
    {
      id: 'e2e-stub',
      modelId: STUB_MODEL_ID,
      name: { en: 'E2E stub model', de: 'E2E-Stub-Modell' },
      description: { en: 'Answers with a fixed sentence.', de: 'Antwortet mit einem festen Satz.' },
      url: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      provider: 'local',
      contextWindow: 8000,
      maxOutputTokens: 2000,
      supportsTools: 'none',
      enabled: true,
      default: true
    },
    null,
    2
  )}\n`
);

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
