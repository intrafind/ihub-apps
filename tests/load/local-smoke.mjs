#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A load smoke on one machine, end to end, with a verdict: starts the fake LLM
 * and an iHub server on a contents directory of its own, prepares it, runs one
 * or more profiles and fails when a profile did not do its work.
 *
 *   node tests/load/local-smoke.mjs                      # smoke, then agentic
 *   node tests/load/local-smoke.mjs --profiles agentic   # only this profile
 *
 * The nightly workflow runs it (`.github/workflows/nightly.yml`). It measures
 * nothing: two or three users cannot size a server. It answers one question
 * per profile, "does every scenario of this profile still work against the
 * server as it is today", so that a capacity run a month later does not start
 * with a broken harness.
 *
 * A profile passes when
 * - at least one turn of every chat scenario in its mix ended, and
 * - no more than `--max-error-pct` (default 0) of its turns failed, and
 * - for `agentTurn`, no turn was short of its tool rounds.
 *
 * `run.mjs` itself always exits with 0 after writing its results, as a
 * capacity run wants; the verdict is made here (`lib/verdict.mjs`).
 *
 * Everything it starts, it stops: the two child processes by their process
 * ids, the contents directory `contents-e2e-load` by removing it (kept with
 * `--keep`). Results go to `tests/load/results/local-smoke-<profile>/`.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeDisposableContents } from '../config/e2e-fresh-contents.mjs';
import { judge } from './lib/verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = 'contents-e2e-load';
const START_TIMEOUT_MS = 180_000;
const POLL_MS = 250;
/** The limit of one look at a server ("does it answer?"). */
const LOOK_TIMEOUT_MS = 2_000;
/** How long a child may take to stop before it is killed. */
const STOP_TIMEOUT_MS = 10_000;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const profiles = option('profiles', 'smoke,agentic')
  .split(',')
  .map(name => name.trim())
  .filter(name => name !== '');
const maxErrorPct = Number(option('max-error-pct', '0'));
const keep = process.argv.includes('--keep');

const log = message => console.log(`[local-smoke] ${message}`);
const loopback = port => `http://127.0.0.1:${port}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The children this script started, stopped again when it ends. */
const children = [];
function start(name, args, { cwd = root, env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[local-smoke] ${name} ended by itself (${signal ?? `code ${code}`})`);
      finish(1);
    }
  });
  children.push(child);
  return child;
}

/** Run a script to its end; resolves with its exit code. */
function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    child.on('exit', code => resolve(code ?? 1));
  });
}

function until(check, what) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    // A look that fails counts as "not yet": the limit applies to it as well.
    const look = async () => {
      const ok = await check().catch(() => false);
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${what}`));
      }
    };
    const timer = setInterval(() => {
      look().catch(reject);
    }, POLL_MS);
  });
}
// One look has a limit of its own: a server that takes the connection and
// never answers must not hold the wait up beyond its limit.
const answers = url => async () => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(LOOK_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
};

/** Ask a child to stop; resolves when it is gone. It is killed when it takes too long. */
function stopped(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const hard = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

let stopping = false;
function finish(code) {
  if (stopping) return;
  stopping = true;
  // The server is gone before its contents directory is removed: a server that
  // is still shutting down would write into the directory again.
  Promise.all(children.map(child => stopped(child)))
    .then(() => {
      if (!keep) removeDisposableContents(root, CONTENTS_DIR);
    })
    .catch(error => console.error(`[local-smoke] ${CONTENTS_DIR} not removed: ${error.message}`))
    .finally(() => process.exit(code));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(130));

async function main() {
  const [llmPort, sitePort, serverPort] = [await freePort(), await freePort(), await freePort()];
  const stubUrl = loopback(llmPort);
  const baseUrl = loopback(serverPort);
  removeDisposableContents(root, CONTENTS_DIR);

  // The fake LLM, fast: this run checks that things work, not how long a model takes.
  start('the fake LLM', ['tests/load/stub/server.mjs'], {
    env: {
      STUB_HOST: '127.0.0.1',
      STUB_LLM_PORT: String(llmPort),
      STUB_SITE_PORT: String(sitePort),
      STUB_TTFT_MS: '50',
      STUB_TOKENS: '40',
      STUB_TOKENS_PER_SEC: '400',
      STUB_SITE_PAGES: '30',
      STUB_SITE_LATENCY_MS: '5'
    }
  });
  start('the iHub server', ['server.js'], {
    cwd: path.join(root, 'server'),
    env: {
      NODE_ENV: 'development',
      WORKERS: '1',
      CONTENTS_DIR,
      HOST: '127.0.0.1',
      PORT: String(serverPort),
      // As the sizing lab does (docker-compose.yml): load from one address must not
      // hit the per-address limits, and the crawl goes to the stub site on this machine.
      IHUB_PLATFORM__RATE_LIMIT__AUTH_API__LIMIT: '100000',
      IHUB_PLATFORM__RATE_LIMIT__PUBLIC_API__LIMIT: '1000000',
      IHUB_PLATFORM__RATE_LIMIT__ADMIN_API__LIMIT: '100000',
      IHUB_PLATFORM__RATE_LIMIT__INFERENCE_API__LIMIT: '1000000',
      IHUB_PLATFORM__SSRF__ALLOWED_HOSTS: '["127.0.0.1"]',
      IHUB_PLATFORM__PROJECTS__LIMITS__MAX_PROJECTS_PER_USER: '50'
    }
  });
  await until(answers(`${stubUrl}/v1/models`), 'the fake LLM');
  await until(answers(`${baseUrl}/api/health`), 'the iHub server');
  log(`iHub at ${baseUrl}, fake LLM at ${stubUrl}`);

  const resultsDir = path.join(root, 'tests', 'load', 'results');
  let failed = false;
  for (const profile of profiles) {
    const runId = `local-smoke-${profile}`;
    fs.rmSync(path.join(resultsDir, runId), { recursive: true, force: true });
    const env = {
      LT_BASE_URL: baseUrl,
      LT_STUB_MODEL_URL: stubUrl,
      LT_LLM_URL: 'none',
      LT_MODEL_ID: 'loadtest-stub',
      LT_CRAWL_URL: `${loopback(sitePort)}/docs/`,
      LT_STUB_STATS_URL: `${stubUrl}/__stats`,
      LT_RESULTS_DIR: resultsDir,
      LT_RUN_ID: runId
    };
    log(`--- ${profile}: setup`);
    if ((await run(['tests/load/setup.mjs', '--profile', profile], env)) !== 0) {
      console.error(`[local-smoke] FAILED: setup for ${profile}`);
      failed = true;
      continue;
    }
    log(`--- ${profile}: run`);
    if ((await run(['tests/load/run.mjs', '--profile', profile], env)) !== 0) {
      console.error(`[local-smoke] FAILED: the run of ${profile} did not finish`);
      failed = true;
      continue;
    }
    const result = JSON.parse(
      fs.readFileSync(path.join(resultsDir, runId, 'shard-0.json'), 'utf8')
    );
    const verdict = judge(result, { maxErrorPct });
    for (const line of verdict.lines) log(`${profile}: ${line}`);
    log(`${profile}: ${verdict.ok ? 'passed' : 'FAILED'}`);
    if (!verdict.ok) failed = true;
  }
  finish(failed ? 1 : 0);
}

main().catch(error => {
  console.error(`[local-smoke] ${error.stack || error.message}`);
  finish(1);
});
