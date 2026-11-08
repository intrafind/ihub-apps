#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Upgrade check: an installation created by an earlier release must start on
 * this checkout and still answer.
 *
 * 1. The earlier release (`--from <tag>`) is checked out into a temporary
 *    worktree and started once on an empty contents directory, which seeds its
 *    configuration and applies its migrations — what an installed system looks
 *    like.
 * 2. This checkout is started on that same contents directory: every newer
 *    migration runs against real, older data.
 * 3. It must serve /api/health with storage ready, log no error, accept the
 *    default admin login, and answer a handful of read calls with JSON.
 *
 * `smoke-boot.js` covers the fresh-install path; this covers the upgrade path.
 *
 * Usage:  node scripts/check-upgrade.js [--from v5.6.5-RC13] [--keep-logs]
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { gitExecutable } from './git-executable.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const from = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : latestTag();
const keepLogs = argv.includes('--keep-logs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function latestTag() {
  return execFileSync(gitExecutable(), ['describe', '--tags', '--abbrev=0', 'origin/main'], {
    cwd: root,
    encoding: 'utf8'
  }).trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start `server/server.js` of `dir` on `contentsDir`; resolves once it serves, with its log. */
async function start(dir, contentsDir) {
  const port = await freePort();
  const log = { text: '' };
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CONTENTS_DIR: contentsDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      WORKERS: '1',
      TELEMETRY_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => (log.text += chunk));
  child.stderr.on('data', chunk => (log.text += chunk));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { child, port, log, ready: false, why: 'exited' };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const body = await response.json();
        return { child, port, log, ready: body?.storage?.ready === true, body };
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return { child, port, log, ready: false, why: 'timeout' };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(30_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const errorLines = text =>
  text
    .split('\n')
    .filter(line => /"level":"error"|Uncaught exception|UnhandledPromiseRejection/.test(line))
    .slice(0, 10);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-'));
  const oldDir = path.join(tmp, 'old');
  const contentsDir = path.join(tmp, 'contents');
  const git = (...args) => execFileSync(gitExecutable(), args, { cwd: root, stdio: 'pipe' });
  const failures = [];
  console.log(`⬆️  Upgrade check: ${from} -> this checkout\n`);
  try {
    git('worktree', 'add', '--detach', oldDir, from);
    for (const dir of ['node_modules', 'server/node_modules', 'client/node_modules']) {
      if (fs.existsSync(path.join(root, dir))) {
        fs.symlinkSync(path.join(root, dir), path.join(oldDir, dir));
      }
    }

    process.stdout.write(`▶ start ${from} on an empty contents directory ... `);
    const before = await start(oldDir, contentsDir);
    await stop(before.child);
    if (!before.ready) {
      console.log('✗');
      console.log(`  the earlier release did not come up (${before.why ?? 'storage not ready'})`);
      if (keepLogs) console.log(before.log.text.split('\n').slice(-20).join('\n'));
      process.exit(2);
    }
    console.log('ok');

    process.stdout.write('▶ start this checkout on the same contents ... ');
    const after = await start(root, contentsDir);
    if (!after.ready)
      failures.push(`did not serve with storage ready (${after.why ?? 'not ready'})`);
    const errors = errorLines(after.log.text);
    if (errors.length) failures.push(`error-level log output:\n    ${errors.join('\n    ')}`);

    if (after.ready) {
      const base = `http://127.0.0.1:${after.port}`;
      const login = await fetch(`${base}/api/auth/local/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
      });
      const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
      if (!login.ok) failures.push(`default admin login answered ${login.status}`);
      for (const route of [
        '/api/apps',
        '/api/models',
        '/api/configs/ui',
        '/api/admin/apps',
        '/api/admin/models',
        '/api/admin/groups',
        '/api/admin/integrations/installed',
        '/api/admin/skills'
      ]) {
        const response = await fetch(base + route, { headers: { cookie } });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !/json/.test(type)) {
          failures.push(`GET ${route} answered ${response.status} ${type}`);
        }
      }
    }
    await stop(after.child);
    console.log(failures.length ? '✗' : 'ok');
    if (keepLogs || failures.length) {
      console.log(after.log.text.split('\n').slice(-25).join('\n'));
    }
  } finally {
    try {
      git('worktree', 'remove', '--force', oldDir);
    } catch {
      /* removed with the temp directory */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      git('worktree', 'prune');
    } catch {
      /* nothing to prune */
    }
  }

  if (failures.length) {
    console.log(`\n❌ upgrade from ${from} failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n✅ ${from} -> this checkout: started, migrated and answered`);
  process.exit(0);
}

await main();
