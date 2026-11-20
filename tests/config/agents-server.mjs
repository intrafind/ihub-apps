// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the stack of the agents end-to-end suite (`webServer.command` of
 * `playwright.agents.config.js`) and stays as its helper:
 *
 * 1. a fresh `contents-e2e-agents/` seeded like every e2e run (`e2e-contents.mjs`:
 *    raised rate limits, no remote marketplace, the two stub models), plus the
 *    regular users `e2e-user` and `e2e-other` and the app `e2e-tools`
 *    (`agents-scenario.mjs`);
 * 2. the model stub (`e2e-llm-stub.mjs`), in this process, so the requests it has
 *    seen and its hangs outlive a restart of the server;
 * 3. the iHub server and the Vite client, as `npm run dev` does, on the suite's own
 *    ports;
 * 4. a control endpoint on `CONTROL_PORT`, for specs:
 *    - `GET /__status` answers `{ starts, overlay, running }`;
 *    - `POST /__restart` stops the server and starts it again on the same contents
 *      directory, and answers once it is healthy. Body (optional JSON):
 *      `{ "signal": "SIGKILL" }` to stop it the hard way (default `SIGTERM`), and
 *      `{ "overlay": { "platform": {…}, "features": {…} } }` to start it with other
 *      settings.
 *
 * ## Overlays
 *
 * `platform.json` is read once at startup, so a spec cannot switch a platform
 * setting while the server runs. An overlay is laid over `config/platform.json` and
 * `config/features.json` as they were seeded; a restart without `overlay` leaves
 * the files as they are. The first start takes its overlay from
 * `E2E_AGENTS_OVERLAY` (JSON), which is how the transport matrix runs the `@matrix`
 * specs once per overlay (see `agents-run.mjs`).
 */

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from './e2e-contents.mjs';
import { e2eContentsDir, removeDisposableContents } from './e2e-fresh-contents.mjs';
import {
  parseOverlay,
  readBaseline,
  seedAgentsApps,
  seedAgentsUsers,
  writeOverlay
} from './agents-contents.mjs';
import {
  CLIENT_PORT,
  CONTENTS_DIR,
  CONTROL_PORT,
  LLM_PORT,
  SERVER_PORT
} from './agents-scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Refuses anything but a `contents-e2e*` directory inside the repository.
const contentsDir = e2eContentsDir(root, { E2E_CONTENTS_DIR: CONTENTS_DIR });
const contentsPath = path.resolve(root, contentsDir);
const api = `http://127.0.0.1:${SERVER_PORT}`;

/** How long a stopped server may take to exit, and a started one to answer. */
const STOP_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 120_000;

process.chdir(root);
// Before any server module is imported: they read it once.
process.env.CONTENTS_DIR = contentsDir;
removeDisposableContents(root, contentsDir);

await prepareE2eContents({ root, contentsDir, llmPort: LLM_PORT });
const bcrypt = createRequire(path.join(root, 'server', 'package.json'))('bcryptjs');
seedAgentsUsers(contentsPath, { passwordHash: password => bcrypt.hashSync(password, 10) });
seedAgentsApps(contentsPath);

const baseline = readBaseline(contentsPath);
let overlay = parseOverlay(process.env.E2E_AGENTS_OVERLAY);
writeOverlay(contentsPath, baseline, overlay);

let server = null;
let starts = 0;
let stopping = false;
let shuttingDown = false;

/** Start the iHub server the way `npm run server` does, on the suite's port. */
function startServer() {
  starts++;
  const child = spawn(process.execPath, ['--env-file-if-exists=../.env', 'server.js'], {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      WORKERS: '1',
      CONTENTS_DIR: contentsDir,
      HOST: '127.0.0.1',
      PORT: String(SERVER_PORT)
    }
  });
  child.on('exit', code => {
    if (server === child) server = null;
    // A server that goes away by itself ends the run: the specs would only time out.
    if (!stopping && !shuttingDown) {
      console.error(`[agents-server] the iHub server exited with code ${code}`);
      shutdown(code || 1);
    }
  });
  server = child;
}

/** Stop the server and wait until the process is gone. */
function stopServer(signal) {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise(resolve => {
    const hard = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill(signal);
  });
}

async function waitUntilHealthy() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`${api}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (!server) throw new Error('The iHub server exited while it was starting.');
    if (Date.now() > deadline) throw new Error('The iHub server did not become healthy in time.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** One restart at a time: a second request waits for the first. */
const SHUTTING_DOWN = 'The helper is shutting down; no server is started.';
let restarting = Promise.resolve();
function restart({ signal = 'SIGTERM', overlay: nextOverlay } = {}) {
  const run = async () => {
    // A restart that was waiting when the shutdown began starts nothing: the
    // shutdown has signalled its children already and would miss a new one.
    if (shuttingDown) throw new Error(SHUTTING_DOWN);
    stopping = true;
    try {
      await stopServer(signal);
      // The shutdown may have begun while the old server was going down.
      if (shuttingDown) throw new Error(SHUTTING_DOWN);
      if (nextOverlay !== undefined) {
        overlay = nextOverlay;
        writeOverlay(contentsPath, baseline, overlay);
      }
      startServer();
    } finally {
      stopping = false;
    }
    await waitUntilHealthy();
  };
  restarting = restarting.then(run, run);
  return restarting;
}

// The Vite client, proxying the API to the suite's server port. It stays up over a
// restart of the server.
const client = spawn(
  path.join(root, 'client', 'node_modules', '.bin', 'vite'),
  ['--host', '127.0.0.1', '--port', String(CLIENT_PORT), '--strictPort'],
  {
    cwd: path.join(root, 'client'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', VITE_API_TARGET: api }
  }
);
client.on('exit', code => {
  if (!shuttingDown) {
    console.error(`[agents-server] the Vite client exited with code ${code}`);
    shutdown(code || 1);
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const control = http.createServer(async (req, res) => {
  const answer = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const status = () => ({ starts, overlay, running: !!server });
  try {
    if (req.method === 'GET' && req.url === '/__status') return answer(200, status());
    if (req.method === 'POST' && req.url === '/__restart') {
      const body = await readJsonBody(req);
      if (body.signal !== undefined && !['SIGTERM', 'SIGKILL'].includes(body.signal)) {
        return answer(400, { error: 'signal must be SIGTERM or SIGKILL' });
      }
      let nextOverlay;
      try {
        nextOverlay = body.overlay === undefined ? undefined : parseOverlay(body.overlay);
      } catch (error) {
        return answer(400, { error: error.message });
      }
      await restart({ signal: body.signal, overlay: nextOverlay });
      return answer(200, status());
    }
    return answer(404, { error: 'not found' });
  } catch (error) {
    return answer(500, { error: error.message });
  }
});
control.listen(CONTROL_PORT, '127.0.0.1');

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  control.close();
  server?.kill('SIGTERM');
  client.kill('SIGTERM');
  // The stub may hold open sockets (a hang nobody released): do not wait for them.
  setTimeout(() => process.exit(code), 500).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

startServer();
