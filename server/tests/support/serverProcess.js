// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Start the real server (`server/server.js`) as a child process on a scratch
 * contents directory, for tests and scripts that need the real start-up path:
 * what the process does when the bucket is not there, and the end-to-end run.
 *
 * Usage:
 *
 * ```js
 * const contentsDir = await seedContents(await fs.mkdtemp(...));
 * await writeStorageConfig(contentsDir, { blobs: { provider: 's3', s3: {...} } });
 * const server = await startServer({ contentsDir });
 * const outcome = await server.settled;   // { ready: true } or { ready: false, exitCode }
 * await server.stop();
 * ```
 *
 * @module tests/support/serverProcess
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A free TCP port on 127.0.0.1. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Environment every child gets: this process's, without what would redirect storage. */
function childEnv(contentsDir, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^IHUB_(STORAGE|S3)_/.test(name) || name === 'TOKEN_ENCRYPTION_KEY') delete env[name];
  }
  return {
    ...env,
    NODE_ENV: 'production',
    CONTENTS_DIR: contentsDir,
    TELEMETRY_ENABLED: 'false',
    ...extra
  };
}

/** Run a child to its end and collect what it printed. */
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
}

/**
 * Turn an empty directory into a fresh installation: default configuration
 * copied and every migration applied, exactly as the server's own first start
 * does it (`startup/bootstrap.js`, `prepareContents`), without starting the
 * server. The storage settings can then be written before the first boot.
 *
 * @param {string} contentsDir - Absolute path of an empty directory.
 * @returns {Promise<string>} `contentsDir`.
 * @throws {Error} When seeding fails; the message carries the output's tail.
 */
export async function seedContents(contentsDir) {
  await fs.mkdir(contentsDir, { recursive: true });
  const script =
    "const m = await import('./server/startup/bootstrap.js'); await m.prepareContents(); process.exit(0);";
  const { code, output } = await run(['--input-type=module', '-e', script], childEnv(contentsDir));
  const platform = path.join(contentsDir, 'config', 'platform.json');
  if (code !== 0 || !(await fs.stat(platform).catch(() => null))) {
    throw new Error(`Seeding ${contentsDir} failed (exit ${code}): ${output.slice(-1500)}`);
  }
  return contentsDir;
}

/**
 * Merge settings into the `storage` section of `config/platform.json`.
 *
 * @param {string} contentsDir
 * @param {Object} storage - Merged one level deep (`blobs`, `encryption`, …).
 * @returns {Promise<Object>} The `storage` section as written.
 */
export async function writeStorageConfig(contentsDir, storage) {
  const file = path.join(contentsDir, 'config', 'platform.json');
  const platform = JSON.parse(await fs.readFile(file, 'utf8'));
  platform.storage = { ...(platform.storage || {}), ...storage };
  await fs.writeFile(file, `${JSON.stringify(platform, null, 2)}\n`);
  return platform.storage;
}

/**
 * Every file below a directory, as paths relative to it. Empty when the
 * directory does not exist.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function filesBelow(dir) {
  const found = [];
  const walk = async current => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  return found.sort();
}

/**
 * Blob files on local disk that are not the storage layer's own bookkeeping.
 *
 * With blobs in a bucket nothing a user uploaded may be written below
 * `data/blobs`. The one thing that may live there is the internal namespace
 * `_ihub` (the key check object of the at-rest encryption of documents and
 * logs, which stay on disk); each of its files must be an encrypted envelope.
 *
 * @param {string} contentsDir
 * @returns {Promise<{user: string[], internal: string[], internalNotEncrypted: string[]}>}
 *   Relative paths below `data/blobs`. `user` must be empty when S3 is active.
 */
export async function localBlobFiles(contentsDir) {
  const root = path.join(contentsDir, 'data', 'blobs');
  const all = await filesBelow(root);
  const isInternal = file => file.split(path.sep)[0] === '_ihub';
  const internal = all.filter(isInternal);
  const internalNotEncrypted = [];
  for (const file of internal) {
    const head = (await fs.readFile(path.join(root, file))).subarray(0, 4).toString('latin1');
    if (head !== 'IHB1') internalNotEncrypted.push(file);
  }
  return { user: all.filter(file => !isInternal(file)), internal, internalNotEncrypted };
}

/**
 * Start the server.
 *
 * @param {Object} options
 * @param {string} options.contentsDir - A seeded contents directory.
 * @param {number} [options.port] - A free port is picked when omitted.
 * @param {Object} [options.env] - Extra environment (`WORKERS`, `IHUB_S3_ADOPT_BUCKET`, …).
 * @param {number} [options.readyTimeoutMs=120000]
 * @returns {Promise<{port: number, baseUrl: string, child: import('node:child_process').ChildProcess,
 *   output: () => string,
 *   settled: Promise<{ready: boolean, exitCode: number|null, signal: string|null, health?: Object, reason?: string}>,
 *   stop: () => Promise<{exitCode: number|null, signal: string|null, clean: boolean}>}>}
 *   `settled` resolves when `/api/health` answers 200 or the process ends,
 *   whichever comes first; it never rejects.
 */
export async function startServer({ contentsDir, port, env = {}, readyTimeoutMs = 120_000 }) {
  const listenPort = port || (await findFreePort());
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: REPO_ROOT,
    env: childEnv(contentsDir, {
      HOST: '127.0.0.1',
      PORT: String(listenPort),
      WORKERS: '1',
      ...env
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  const exited = new Promise(resolve =>
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  );
  const baseUrl = `http://127.0.0.1:${listenPort}`;

  const settled = (async () => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const end = await exited;
        return { ready: false, ...end, reason: 'the process ended before it served' };
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(3000)
        });
        if (response.ok) {
          return { ready: true, exitCode: null, signal: null, health: await response.json() };
        }
      } catch {
        // Not listening yet.
      }
      await Promise.race([sleep(200), exited]);
    }
    return {
      ready: false,
      exitCode: null,
      signal: null,
      reason: `no /api/health within ${readyTimeoutMs} ms`
    };
  })();

  return {
    port: listenPort,
    baseUrl,
    child,
    output: () => output,
    settled,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { ...(await exited), clean: true };
      }
      child.kill('SIGTERM');
      const end = await Promise.race([exited, sleep(30_000).then(() => null)]);
      if (end) return { ...end, clean: true };
      child.kill('SIGKILL');
      return { ...(await exited), clean: false };
    }
  };
}
