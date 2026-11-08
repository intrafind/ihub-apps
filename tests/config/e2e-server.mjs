// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the dev server for the Playwright suites (`webServer.command`).
 *
 * The suites sign in dozens of times and call the admin API in bursts, which the
 * default rate limits (30 sign-ins per 15 minutes, 100 admin calls per minute)
 * answer with 429 halfway through a run. This script gives the run its own
 * `contents-e2e/` (git-ignored): a fresh install seeded the way the server seeds
 * `contents/`, with every rate limit raised. Nothing the specs create (users,
 * prompts, tasks) ends up in a developer's real `contents/`.
 *
 * The directory is kept between runs; delete it to start from a fresh install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = 'contents-e2e';
const RAISED_LIMIT = 1_000_000;

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

const server = spawn('npm', ['run', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CONTENTS_DIR }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
