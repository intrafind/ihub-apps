#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Time to first token of two commits, measured back to back on one machine
 * against the paced fake LLM, with a verdict: the performance gate of a pull
 * request that changes the chat path.
 *
 *   node tests/load/compare.mjs --base origin/main                # the working tree against main
 *   node tests/load/compare.mjs --base <sha> --head <sha>         # two commits
 *   node tests/load/compare.mjs --base <sha> --repetitions 5 --turns 12 --out compare.json
 *
 * How it measures. The base commit (and the head commit, when `--head` names
 * one; else the working tree) is checked out into a temporary git worktree
 * that shares this checkout's `node_modules`. One fake LLM serves both
 * (`stub/server.mjs`, the `loadtest-stub` model of the `capacity-stub` profile,
 * with a fixed time to first token and no jitter). Each repetition starts the
 * iHub server of the base and of the head in turn, one after the other — the
 * order alternates between repetitions, so a machine that slows down over the
 * run burdens both — each on a fresh contents directory, prepares it with
 * `setup.mjs` (the model and a user), sends one warm-up turn and then
 * `--turns` chat turns, one at a time, each in a new chat, through the chat
 * route (`ChatSession`, the SSE stream and the POST). TTFT is the time from
 * the POST to the first visible answer token. A repetition's figure is the
 * median of its turns.
 *
 * The verdict, from the medians of the repetitions:
 *
 * - `pass`: the head's median is at most `--gate-pct` (10) % above the base's;
 * - `fail` (exit code 1): it is more;
 * - `release-gate` (exit code 0): the spread of the base's repetitions
 *   ((max - min) / median) is above `--spread-pct` (10) %. The machine is too
 *   noisy for the gate: the numbers are reported and a person measures before
 *   the release.
 *
 * Everything it starts, it stops: the servers, the fake LLM, the worktrees
 * and the contents directories. The numbers are printed and, with `--out`,
 * written as JSON.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = 'contents-e2e-compare';
const START_TIMEOUT_MS = 180_000;
const POLL_MS = 250;
const LOOK_TIMEOUT_MS = 2_000;
const STOP_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 120_000;

/** `git` by its full path in a system directory, never through PATH. */
const GIT = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git'].find(
  candidate => fs.existsSync(candidate)
);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positive(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[compare] --${name} must be a positive number`);
    process.exit(2);
  }
  return value;
}

const log = message => console.log(`[compare] ${message}`);
// The fake LLM and the servers listen on this machine only: no TLS.
const loopback = port => `http://127.0.0.1:${port}`; // NOSONAR

/** The median of a list of numbers. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** (max - min) / median, in percent. */
export function spreadPct(values) {
  if (values.length === 0) return Number.NaN;
  return ((Math.max(...values) - Math.min(...values)) / median(values)) * 100;
}

/**
 * The verdict of a comparison.
 *
 * @param {Object} params
 * @param {number[]} params.base - the base's figure per repetition (ms)
 * @param {number[]} params.head - the head's figure per repetition (ms)
 * @param {number} [params.gatePct=10]
 * @param {number} [params.maxSpreadPct=10]
 * @returns {{verdict: 'pass'|'fail'|'release-gate', baseMedian: number, headMedian: number,
 *   deltaPct: number, baseSpreadPct: number, headSpreadPct: number}}
 */
export function judgeComparison({ base, head, gatePct = 10, maxSpreadPct = 10 }) {
  const baseMedian = median(base);
  const headMedian = median(head);
  const deltaPct = ((headMedian - baseMedian) / baseMedian) * 100;
  const baseSpreadPct = spreadPct(base);
  const headSpreadPct = spreadPct(head);
  let verdict;
  if (!(baseSpreadPct <= maxSpreadPct)) verdict = 'release-gate';
  else verdict = headMedian <= baseMedian * (1 + gatePct / 100) ? 'pass' : 'fail';
  return { verdict, baseMedian, headMedian, deltaPct, baseSpreadPct, headSpreadPct };
}

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

function git(args, cwd = root) {
  if (!GIT) throw new Error('git was not found in a system directory');
  return execFileSync(GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The children this script started, stopped again when it ends. */
const children = new Set();
/** The worktrees this script added, removed again when it ends. */
const worktrees = [];
let stopping = false;

function start(name, args, { cwd, env = {} }) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping && !child.expectedExit) {
      console.error(`[compare] ${name} ended by itself (${signal ?? `code ${code}`})`);
      finish(1);
    }
  });
  children.add(child);
  return child;
}

/** Run a script to its end; resolves with its exit code. */
function run(args, { cwd, env }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'inherit']
    });
    child.on('exit', code => resolve(code ?? 1));
  });
}

function stopped(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.expectedExit = true;
    const hard = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function until(check, what) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + START_TIMEOUT_MS;
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

const answers = url => async () => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(LOOK_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
};

/**
 * A checkout of `ref` in a temporary worktree that shares this checkout's
 * dependencies.
 */
function checkout(ref, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ihub-compare-${label}-`));
  git(['worktree', 'add', '--detach', dir, ref]);
  worktrees.push(dir);
  for (const modules of ['node_modules', 'server/node_modules', 'shared/node_modules']) {
    const source = path.join(root, modules);
    if (fs.existsSync(source) && !fs.existsSync(path.join(dir, modules))) {
      fs.symlinkSync(source, path.join(dir, modules), 'dir');
    }
  }
  return { label, ref, dir, sha: git(['rev-parse', 'HEAD'], dir).trim() };
}

function removeContents(tree) {
  fs.rmSync(path.join(tree.dir, CONTENTS_DIR), { recursive: true, force: true });
}

/** One repetition of one side: a fresh server, its setup, a warm-up turn and the measured turns. */
async function measure(tree, { stubUrl, turns, lib }) {
  removeContents(tree);
  const port = await freePort();
  const baseUrl = loopback(port);
  const server = start(`the iHub server of ${tree.label}`, ['server.js'], {
    cwd: path.join(tree.dir, 'server'),
    env: {
      NODE_ENV: 'development',
      WORKERS: '1',
      // Relative to the checkout's root, where the server looks for it.
      CONTENTS_DIR,
      HOST: '127.0.0.1',
      PORT: String(port),
      IHUB_PLATFORM__RATE_LIMIT__AUTH_API__LIMIT: '100000',
      IHUB_PLATFORM__RATE_LIMIT__PUBLIC_API__LIMIT: '1000000',
      IHUB_PLATFORM__RATE_LIMIT__ADMIN_API__LIMIT: '100000'
    }
  });
  try {
    await until(answers(`${baseUrl}/api/health`), `the iHub server of ${tree.label}`);
    const env = {
      LT_BASE_URL: baseUrl,
      LT_STUB_MODEL_URL: stubUrl,
      LT_LLM_URL: 'none',
      LT_MODEL_ID: 'loadtest-stub'
    };
    const setupArgs = [
      path.join(root, 'tests/load/setup.mjs'),
      '--profile',
      'capacity-stub',
      '--users',
      '1',
      '--skip-projects'
    ];
    if ((await run(setupArgs, { cwd: root, env })) !== 0) {
      throw new Error(`setup of ${tree.label} failed`);
    }
    const { client } = await lib.login({
      baseUrl,
      username: 'lt-0001',
      password: 'LoadTest-2026!'
    });
    await lib.ensureAiAcknowledged(client);
    const metrics = { count() {}, error() {}, trend() {} };
    const ctx = {
      client,
      metrics,
      config: { modelId: 'loadtest-stub', language: 'en', turnTimeoutSec: TURN_TIMEOUT_MS / 1000 }
    };
    const one = async () => {
      const session = new lib.ChatSession(ctx, { appId: 'chat', label: 'compare' });
      try {
        await session.open();
        const result = await session.turn({ content: 'Say a few words about load tests.' });
        if (result.ttft === null) throw new Error('a turn without an answer token');
        return result.ttft;
      } finally {
        session.close();
      }
    };
    await one(); // warm-up: the first turn pays for caches and lazy modules
    const ttfts = [];
    for (let i = 0; i < turns; i++) ttfts.push(await one());
    return { median: median(ttfts), ttfts };
  } finally {
    children.delete(server);
    await stopped(server);
    removeContents(tree);
  }
}

function finish(code) {
  if (stopping) return;
  stopping = true;
  Promise.all([...children].map(child => stopped(child)))
    .then(() => {
      for (const dir of worktrees) {
        try {
          git(['worktree', 'remove', '--force', dir]);
        } catch (error) {
          console.error(`[compare] worktree ${dir} not removed: ${error.message}`);
        }
      }
    })
    .catch(error => console.error(`[compare] cleanup failed: ${error.message}`))
    .finally(() => process.exit(code));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(130));

async function main() {
  const baseRef = option('base', process.env.LT_COMPARE_BASE);
  if (!baseRef) {
    console.error('[compare] --base <git ref> is required (the commit the head is compared with)');
    process.exit(2);
  }
  const headRef = option('head', null);
  const repetitions = positive('repetitions', 5);
  const turns = positive('turns', 12);
  const gatePct = positive('gate-pct', 10);
  const maxSpreadPct = positive('spread-pct', 10);
  const stubTtftMs = positive('stub-ttft-ms', 100);
  const out = option('out', null);

  const base = checkout(baseRef, 'base');
  const head = headRef
    ? checkout(headRef, 'head')
    : {
        label: 'head',
        ref: 'working tree',
        dir: root,
        sha: `${git(['rev-parse', 'HEAD']).trim()}${git(['status', '--porcelain']).trim() ? '+dirty' : ''}`
      };
  log(`base ${base.ref} (${base.sha}), head ${head.ref} (${head.sha})`);

  const [llmPort, sitePort] = [await freePort(), await freePort()];
  const stubUrl = loopback(llmPort);
  start('the fake LLM', ['tests/load/stub/server.mjs'], {
    cwd: root,
    env: {
      STUB_HOST: '127.0.0.1',
      STUB_LLM_PORT: String(llmPort),
      STUB_SITE_PORT: String(sitePort),
      STUB_TTFT_MS: String(stubTtftMs),
      STUB_JITTER: '0',
      STUB_TOKENS: '20',
      STUB_TOKENS_PER_SEC: '400'
    }
  });
  await until(answers(`${stubUrl}/v1/models`), 'the fake LLM');
  // The client of the load harness, from this checkout: both sides are asked the same way.
  const lib = {
    ...(await import('./lib/http.mjs')),
    ...(await import('./lib/chat.mjs'))
  };

  const results = { base: [], head: [] };
  for (let rep = 1; rep <= repetitions; rep++) {
    const order = rep % 2 === 1 ? [base, head] : [head, base];
    for (const tree of order) {
      const result = await measure(tree, { stubUrl, turns, lib });
      results[tree.label].push(result);
      log(
        `repetition ${rep}/${repetitions} ${tree.label}: median TTFT ${result.median.toFixed(1)} ms over ${turns} turns`
      );
    }
  }

  const judged = judgeComparison({
    base: results.base.map(r => r.median),
    head: results.head.map(r => r.median),
    gatePct,
    maxSpreadPct
  });
  const report = {
    base: { ref: base.ref, sha: base.sha, medians: results.base.map(r => r.median) },
    head: { ref: head.ref, sha: head.sha, medians: results.head.map(r => r.median) },
    turnsPerRepetition: turns,
    stubTtftMs,
    gatePct,
    maxSpreadPct,
    ...judged
  };
  const fixed = value => value.toFixed(1);
  log(`base medians (ms): ${report.base.medians.map(fixed).join(', ')}`);
  log(`head medians (ms): ${report.head.medians.map(fixed).join(', ')}`);
  log(
    `base median ${fixed(judged.baseMedian)} ms, head median ${fixed(judged.headMedian)} ms, ` +
      `head ${judged.deltaPct >= 0 ? '+' : ''}${fixed(judged.deltaPct)} % (gate +${gatePct} %)`
  );
  log(
    `spread of the base runs ${fixed(judged.baseSpreadPct)} %, of the head runs ${fixed(judged.headSpreadPct)} % (limit ${maxSpreadPct} %)`
  );
  if (judged.verdict === 'release-gate') {
    log(
      'verdict: release-gate — the base runs spread more than the limit; the numbers are reported and a person measures before the release'
    );
  } else {
    log(`verdict: ${judged.verdict}`);
  }
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  finish(judged.verdict === 'fail' ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[compare] ${error.stack || error.message}`);
    finish(1);
  });
}
