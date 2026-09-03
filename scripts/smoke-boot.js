#!/usr/bin/env node

import { spawn } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { createServer } from 'net';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

/**
 * Boot smoke test: starts the real server entrypoint and asserts it comes up,
 * serves /api/health and shuts down again on SIGTERM.
 *
 * The unit and integration suites import modules directly, so nothing there
 * fails when `server/server.js` itself throws on startup — a broken import, a
 * bad migration or a crash in the boot sequence ships green. This script is the
 * guard for that class of failure.
 *
 * Each scenario boots against a throwaway CONTENTS_DIR, so the fresh-install
 * path (default config copied from server/defaults, every migration applied
 * from scratch) is exercised too. CONTENTS_DIR is always resolved as
 * `path.join(rootDir, CONTENTS_DIR)`, so the throwaway directory has to be
 * repo-relative — an absolute path would be re-rooted inside the repo.
 *
 * Usage: node scripts/smoke-boot.js [--keep-logs]
 */

const READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const SCENARIOS = [
  {
    name: 'single-process (WORKERS=1)',
    env: { WORKERS: '1' }
  },
  {
    name: 'cluster round-robin (WORKERS=2)',
    env: { WORKERS: '2' }
  },
  {
    name: 'cluster sticky sessions (WORKERS=2, STICKY_SESSIONS=true)',
    env: { WORKERS: '2', STICKY_SESSIONS: 'true' }
  }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Reserve a free TCP port by binding to :0 and releasing it. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Scan captured server output for boot failures. Warnings are expected on a
 * fresh install (missing API keys, config validation notes) and are ignored.
 */
function findFatalLogLines(output) {
  return output
    .split('\n')
    .filter(line => /"level":"error"|Uncaught exception|UnhandledPromiseRejection/.test(line))
    .slice(0, 10);
}

async function waitForHealth(port, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        ok: false,
        reason: `process exited (code=${child.exitCode}, signal=${child.signalCode}) before serving`
      };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === 'OK') return { ok: true, body };
        return { ok: false, reason: `unexpected health payload: ${JSON.stringify(body)}` };
      }
    } catch {
      // not listening yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, reason: `did not serve /api/health within ${READY_TIMEOUT_MS / 1000}s` };
}

/** SIGTERM the server and wait for the process tree to actually exit. */
async function shutdown(child) {
  const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
  child.kill('SIGTERM');
  const result = await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
  if (!result) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
    return {
      ok: false,
      reason: `did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s of SIGTERM (needed SIGKILL)`
    };
  }
  return { ok: true };
}

async function runScenario(scenario, keepLogs) {
  const port = await findFreePort();
  // Repo-relative on purpose: the server joins CONTENTS_DIR onto the root dir.
  const contentsDir = join('.smoke-contents', randomUUID());
  const contentsPath = join(rootDir, contentsDir);
  await mkdir(contentsPath, { recursive: true });

  let output = '';
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CONTENTS_DIR: contentsDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      TELEMETRY_ENABLED: 'false',
      ...scenario.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));

  const failures = [];
  try {
    const ready = await waitForHealth(port, child, Date.now() + READY_TIMEOUT_MS);
    if (!ready.ok) failures.push(ready.reason);

    const fatal = findFatalLogLines(output);
    if (fatal.length)
      failures.push(`error-level log output during boot:\n    ${fatal.join('\n    ')}`);

    if (ready.ok) {
      const stopped = await shutdown(child);
      if (!stopped.ok) failures.push(stopped.reason);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (keepLogs) {
      console.log(`  log tail (${contentsPath}):`);
      console.log(
        output
          .split('\n')
          .slice(-20)
          .map(l => `    ${l}`)
          .join('\n')
      );
    }
    await rm(contentsPath, { recursive: true, force: true });
  }

  return { failures, output };
}

async function main() {
  const keepLogs = process.argv.includes('--keep-logs');
  let failed = 0;

  console.log('🔥 Boot smoke test: starting the real server entrypoint\n');

  for (const scenario of SCENARIOS) {
    process.stdout.write(`▶ ${scenario.name} ... `);
    const started = Date.now();
    const { failures, output } = await runScenario(scenario, keepLogs);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (failures.length === 0) {
      console.log(`✅ booted, served /api/health and shut down (${seconds}s)`);
      continue;
    }

    failed += 1;
    console.log(`❌ FAILED (${seconds}s)`);
    for (const failure of failures) console.log(`  - ${failure}`);
    if (!keepLogs) {
      console.log('  last 30 log lines:');
      console.log(
        output
          .split('\n')
          .slice(-30)
          .map(l => `    ${l}`)
          .join('\n')
      );
    }
  }

  if (!keepLogs) await rm(join(rootDir, '.smoke-contents'), { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\n❌ Boot smoke test failed: ${failed} of ${SCENARIOS.length} scenarios broken`);
    process.exit(1);
  }
  console.log(`\n✅ All ${SCENARIOS.length} boot scenarios passed`);
}

main().catch(error => {
  console.error('❌ Boot smoke test crashed:', error);
  process.exit(1);
});
