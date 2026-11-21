// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The fault harness: real server processes that a test kills and starts again
 * (docs/run-testing.md, "The fault tier").
 *
 * ```js
 * const stack = await startStack();                 // one worker, fresh contents
 * const api = await stack.api();                    // signed in as the admin
 * await stack.restart({ killPoint: 'e2e-counter-after-write' });
 * const turn = api.chatTurn(TOOLS_APP, 'e2e-tool:e2e_counter_write:{"key":"k"}');
 * await stack.waitKilledAt('e2e-counter-after-write');
 * assert.equal(stack.counter.count('k'), 1);
 * await stack.restart();                            // same contents, no kill point
 * await stack.stop();
 * ```
 *
 * What lives where:
 *
 * - The **server** is `node server/server.js` with `NODE_ENV=test` and the test
 *   tools, one process (or a primary with two workers) per stack, in a process
 *   group of its own. The harness signals that group and nothing else: it never
 *   looks a process up by name or port.
 * - The **model stub** (`tests/config/e2e-llm-stub.mjs`) and the **counter**
 *   (`tests/config/test-counter.mjs`) run in the process of the test. A killed
 *   server takes neither along, so what the model was asked and how often a
 *   write ran are still there afterwards.
 * - The **contents directory** is `contents-e2e-faults-<random>` in the
 *   repository, seeded by `seed.mjs` in a process of its own and removed by
 *   `stack.stop()` (kept with `KEEP_FAULT_CONTENTS=1`, with the output of its
 *   servers in `faults-server.log`). `startStack({ contents })` starts on a
 *   directory another stack left, and does not remove it.
 *
 * A kill point is named when a server is started (`startStack({ killPoint })`,
 * `stack.restart({ killPoint })`). The server writes the name to a file before
 * it dies; `stack.waitKilledAt(name)` waits for that line and, with one worker,
 * for the process to be gone. Nothing here reads a log line to find out where a
 * server was, and nothing sleeps: every wait is for a condition, with a limit
 * that also holds when a server takes a connection and never answers.
 *
 * The harness imports no server module: the server code reads its settings once
 * per process, and one test file may start several stacks.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLlmStub } from '../../../tests/config/e2e-llm-stub.mjs';
import { startCounter } from '../../../tests/config/test-counter.mjs';
import { writeStubModels } from '../../../tests/config/e2e-contents.mjs';
import {
  disposableContentsPath,
  removeDisposableContents
} from '../../../tests/config/e2e-fresh-contents.mjs';
import { ADMIN, MODELS } from '../../../tests/config/agents-scenario.mjs';
import { documentedKillPointNames } from './killpoints.mjs';
import {
  EXIT_TIMEOUT_MS,
  KILL_POINT_TIMEOUT_MS,
  LOOK_TIMEOUT_MS,
  POLL_MS,
  RESTART_TIMEOUT_MS,
  SERVER_LOG,
  START_TIMEOUT_MS,
  afterStop,
  childEnvironment,
  keepsContents
} from './settings.mjs';

export { ADMIN, MODELS, OTHER, TOOLS_APP, USER } from '../../../tests/config/agents-scenario.mjs';
export { CASE_TIMEOUT_MS, SETUP_TIMEOUT_MS } from './settings.mjs';
export {
  COUNTER_READ,
  COUNTER_WRITE,
  TEST_TOOLS_INSTALLATION
} from '../../../tests/config/test-tools-contents.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

/** How much of a server log a failure message quotes. */
const LOG_TAIL_BYTES = 4000;

/** Loaded before the server by a start with the clock ahead. */
const CLOCK_AHEAD = pathToFileURL(path.join(here, 'fixtures', 'clockAhead.mjs')).href;

const loopback = port => `http://127.0.0.1:${port}`;

/** Every server of this process that may still run: stopped when the process ends. */
const live = new Set();
/** The contents directories this process seeded, does not keep and has not removed yet. */
const seeded = new Set();
/** The temporary directories (logs, reached-files) of stacks that were not stopped. */
const scratches = new Set();
process.once('exit', () => {
  for (const target of live) target.signal('SIGKILL');
  for (const scratch of scratches) fs.rmSync(scratch, { recursive: true, force: true });
  for (const contentsDir of seeded) {
    try {
      removeDisposableContents(root, contentsDir);
    } catch {
      // Best effort: the run is over, and the directory is git-ignored.
    }
  }
});
// A test run that is interrupted ends without the `exit` event, and the servers
// are in process groups of their own, which the signal of a terminal does not
// reach. Ending through `process.exit` runs the handler above, so an interrupted
// run leaves no server and no contents directory behind.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => process.exit(1));
}

/**
 * Remove a contents directory that a stack kept. Refuses anything but a
 * `contents-e2e*` directory of the repository.
 *
 * @param {string} contentsDir - `stack.contentsDir`
 */
export function removeContents(contentsDir) {
  removeDisposableContents(root, contentsDir);
}

/**
 * What this process would still clean up if it ended now: for the self-test of
 * the harness.
 *
 * @returns {{servers: number, contents: string[], scratch: number}} The servers
 *   that run, the contents directories that would be removed, and the number of
 *   temporary directories
 */
export function leftBehind() {
  return { servers: live.size, contents: [...seeded], scratch: scratches.size };
}

/**
 * Wait for a condition, not for time: `check` is called until it returns
 * something truthy, which is the result. Fails after `timeoutMs`, also while a
 * look is still on its way: a check that never returns does not hold the limit up.
 *
 * @template T
 * @param {() => T|Promise<T>} check
 * @param {Object} options
 * @param {string} options.what - Names the condition in the failure message
 * @param {number} [options.timeoutMs]
 * @param {() => string} [options.detail] - More for the failure message (a log tail)
 * @returns {Promise<T>}
 */
export function until(check, { what, timeoutMs = START_TIMEOUT_MS, detail = () => '' }) {
  return new Promise((resolve, reject) => {
    // Held on an object: the callbacks of a look set it, the timers read it.
    const state = { busy: false, over: false };
    const finish = (settle, value) => {
      if (state.over) return;
      state.over = true;
      clearInterval(timer);
      clearTimeout(limit);
      settle(value);
    };
    // The limit has a timer of its own. Looked at only after a check returned,
    // it would never apply to a check that hangs.
    const limit = setTimeout(() => {
      finish(reject, new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${detail()}`));
    }, timeoutMs);
    const look = async () => {
      const value = await check();
      if (value) finish(resolve, value);
    };
    const timer = setInterval(() => {
      // One look at a time: a slow check is not started again while it runs.
      if (state.busy) return;
      state.busy = true;
      look()
        .finally(() => {
          state.busy = false;
        })
        .catch(error => finish(reject, error));
    }, POLL_MS);
  });
}

/** A port nothing listens on right now, on the loopback interface. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Whether an address answers with a success. One look has a limit of its own:
 * a server that takes the connection and never answers counts as "not yet".
 *
 * @param {string} address
 * @returns {Promise<boolean>}
 */
async function answers(address) {
  try {
    return (await fetch(address, { signal: AbortSignal.timeout(LOOK_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/** The environment of a child: see `childEnvironment` in `settings.mjs`. */
const childEnv = extra => childEnvironment(process.env, extra);

/** A namespace or key as one path segment, or throws. */
function plainName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`"${name}" is not a plain name`);
  }
  return name;
}

/** The name of a kill point spec: `after-write@2` is `after-write`. */
const killPointName = spec => String(spec).split('@')[0];

/**
 * The kill point variables of a start: the spec and a file of its own for the
 * name the process writes before it dies.
 *
 * @param {string|undefined} spec - `<name>` or `<name>@<n>`
 * @param {string} dir - Where the file goes
 * @returns {{env: Object, reachedFile: string|null}}
 * @throws {Error} When the name is not listed in KILLPOINTS.md
 */
function arm(spec, dir) {
  if (!spec) return { env: {}, reachedFile: null };
  const known = documentedKillPointNames();
  if (!known.includes(killPointName(spec))) {
    throw new Error(
      `Unknown kill point "${killPointName(spec)}". KILLPOINTS.md lists: ${known.join(', ')}`
    );
  }
  const reachedFile = path.join(dir, `killpoint-${crypto.randomUUID()}.reached`);
  return {
    env: { IHUB_TEST_KILLPOINT: spec, IHUB_TEST_KILLPOINT_FILE: reachedFile },
    reachedFile
  };
}

/** Signal a process group by the id of its first process. A group that is not there is no error. */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * Start a Node process in a process group of its own, with its output in a file.
 *
 * @param {Object} options
 * @param {string} options.script
 * @param {string} options.cwd
 * @param {Object} options.env
 * @param {string} options.logFile
 * @param {string[]} [options.nodeArgs] - Options of `node`, before the script
 * @returns {{pid: number, exited: Promise<{code: number|null, signal: string|null}>,
 *   running: () => boolean, signal: (signal: string) => void, logTail: () => string}}
 */
function launch({ script, cwd, env, logFile, nodeArgs = [] }) {
  const log = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [...nodeArgs, script], {
    cwd,
    env,
    // A group of its own: a signal to the group reaches a primary and its workers
    // at once, as a machine that goes down does, and reaches nothing else.
    detached: true,
    stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  const state = { gone: false };
  const exit = Promise.withResolvers();
  const target = {
    pid: child.pid,
    exited: exit.promise,
    running: () => !state.gone,
    /**
     * Signal the group this harness started. Once its first process is gone,
     * nothing is sent: the id of an empty group is free, and the system may
     * have given it to a process this harness never started.
     */
    signal(signal) {
      if (state.gone) return;
      signalGroup(child.pid, signal);
    },
    logTail() {
      try {
        const text = fs.readFileSync(logFile, 'utf8');
        return `\n--- last output of ${path.basename(script)} ---\n${text.slice(-LOG_TAIL_BYTES)}`;
      } catch {
        return '';
      }
    }
  };
  live.add(target);
  child.once('exit', (code, signal) => {
    try {
      // Workers of a primary that died may still be there for a moment. This is
      // the one signal after the first process ended, sent the moment it did:
      // while a worker lives, the id of the group is still the group's.
      signalGroup(child.pid, 'SIGKILL');
    } finally {
      state.gone = true;
      live.delete(target);
      exit.resolve({ code, signal });
    }
  });
  return target;
}

/**
 * Signal a process group and wait until its first process is gone. A process
 * that ended by itself is not signalled.
 */
async function end(target, signal) {
  if (!target) return;
  if (!target.running()) {
    await target.exited;
    return;
  }
  target.signal(signal);
  const hard = setTimeout(() => target.signal('SIGKILL'), EXIT_TIMEOUT_MS);
  await target.exited;
  clearTimeout(hard);
}

function reached(reachedFile, name) {
  try {
    return fs.readFileSync(reachedFile, 'utf8').split('\n').includes(name);
  } catch {
    return false;
  }
}

/**
 * Wait until a process wrote the name of its kill point, and, when the whole
 * process dies there, until it is gone.
 */
async function killedAt(target, reachedFile, name, { timeoutMs, processDies }) {
  if (!reachedFile) {
    throw new Error(`The process was started without a kill point; it cannot die at "${name}".`);
  }
  await until(() => reached(reachedFile, name), {
    what: `the kill point "${name}"`,
    timeoutMs,
    detail: () => target.logTail()
  });
  if (!processDies) return null;
  const exit = await target.exited;
  if (exit.signal !== 'SIGKILL') {
    throw new Error(
      `The process reached "${name}" and then ended with ${exit.signal ?? `code ${exit.code}`}, not SIGKILL.`
    );
  }
  return exit;
}

/** Parse the complete SSE blocks of a text; returns the frames and the rest. */
function takeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf('\n\n');
    if (cut < 0) break;
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const frame = JSON.parse(data);
      frames.push({ ...frame, type: frame.type, data: frame.data ?? {} });
    } catch {
      // A keep-alive or a line that is not JSON.
    }
  }
  return { frames, rest };
}

/**
 * A request on a connection of its own, which is closed after the answer.
 * `fetch` keeps its connections and uses them again, and a connection stays
 * with the worker that took it: with two workers, requests that share one
 * never reach the other worker. Each of these is handed out anew.
 *
 * @param {string} address
 * @param {{method: string, headers: Object, body?: string, signal?: AbortSignal}} init
 * @returns {Promise<{status: number, body: AsyncIterable<Uint8Array>}>} As much
 *   of a `fetch` response as a stream of the client below reads
 */
function requestOnOwnConnection(address, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = http.request(address, { method, headers, signal, agent: false }, response =>
      resolve({ status: response.statusCode, body: response })
    );
    request.once('error', reject);
    request.end(body);
  });
}

/**
 * An HTTP client for one signed-in user.
 *
 * @param {string} baseUrl
 * @param {string} cookie - The `authToken` cookie of the sign-in
 */
function client(baseUrl, cookie) {
  const request = async (method, pathname, { body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, ok: response.ok, body: json, text };
  };

  /**
   * A request whose response is an event stream. Resolves once the response has
   * started. `frames` grows while the stream is read; `until` waits for a frame;
   * `done` resolves (it never rejects) when the stream ended, with the error
   * that ended it when the server went away. `ownConnection` sends it on a
   * connection of its own (see `requestOnOwnConnection`).
   */
  const stream = async (method, pathname, { body, headers = {}, ownConnection = false } = {}) => {
    const controller = new AbortController();
    const send = ownConnection ? requestOnOwnConnection : fetch;
    const response = await send(`${baseUrl}${pathname}`, {
      method,
      headers: {
        cookie,
        accept: 'text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const frames = [];
    const waiters = new Set();
    let ended = null;
    const settle = () => {
      for (const waiter of [...waiters]) {
        const found = frames.find(frame => waiter.predicate(frame));
        if (found) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(found);
        } else if (ended) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(
            new Error(
              `The stream of ${method} ${pathname} ended before ${waiter.what}` +
                (ended.error ? ` (${ended.error.message})` : '') +
                `. Frames: ${frames.map(frame => frame.type).join(', ') || 'none'}`
            )
          );
        }
      }
    };
    const done = (async () => {
      let rest = '';
      let error = null;
      try {
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          const taken = takeFrames(rest + decoder.decode(chunk, { stream: true }));
          rest = taken.rest;
          frames.push(...taken.frames);
          settle();
        }
      } catch (caught) {
        error = caught;
      }
      ended = { error };
      settle();
      return { frames, error };
    })();
    return {
      status: response.status,
      frames,
      done,
      abort: () => controller.abort(),
      until(predicate, what, timeoutMs = KILL_POINT_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
          const waiter = { predicate, what, resolve, reject, timer: null };
          waiter.timer = setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `Timed out after ${timeoutMs} ms waiting for ${what} on ${method} ${pathname}. ` +
                  `Frames: ${frames.map(frame => frame.type).join(', ') || 'none'}`
              )
            );
          }, timeoutMs);
          waiters.add(waiter);
          settle();
        });
      }
    };
  };

  /**
   * One chat turn through `POST /api/apps/{appId}/chat/{chatId}` with the answer
   * on the same connection. Resolves when the stream ended, also when the
   * server died in the middle: `error` then holds what ended it. With
   * `ownConnection` the turn does not share a connection with an earlier one,
   * so with two workers it is not bound to the worker of an earlier turn.
   */
  const chatTurn = async (
    appId,
    message,
    { chatId, modelId = MODELS.tools, extra = {}, ownConnection = false } = {}
  ) => {
    const id = chatId || `fault-${crypto.randomUUID()}`;
    let opened;
    try {
      opened = await stream('POST', `/api/apps/${appId}/chat/${id}`, {
        ownConnection,
        body: {
          messages: [{ role: 'user', content: message, messageId: `msg-${crypto.randomUUID()}` }],
          modelId,
          language: 'en',
          ...extra
        }
      });
    } catch (error) {
      // The server went away before it answered at all.
      return { chatId: id, status: 0, frames: [], answer: '', error };
    }
    const { frames, error } = await opened.done;
    const answer = frames
      .filter(frame => frame.type === 'step/delta' && frame.data.kind === 'text')
      .map(frame => frame.data.content || '')
      .join('');
    return { chatId: id, status: opened.status, frames, answer, error };
  };

  return {
    cookie,
    get: (pathname, options) => request('GET', pathname, options),
    post: (pathname, body, options) => request('POST', pathname, { ...options, body }),
    put: (pathname, body, options) => request('PUT', pathname, { ...options, body }),
    delete: (pathname, options) => request('DELETE', pathname, options),
    stream,
    chatTurn
  };
}

async function signIn(baseUrl, credentials) {
  const response = await fetch(`${baseUrl}/api/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password })
  });
  if (!response.ok) {
    throw new Error(
      `sign-in as ${credentials.username}: ${response.status} ${await response.text()}`
    );
  }
  const cookie = response.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ');
  return client(baseUrl, cookie);
}

/** The model stub of a stack, in this process. */
async function startStub(options) {
  const server = await startLlmStub(0, options);
  const url = loopback(server.address().port);
  const json = async (pathname, init) => {
    const response = await fetch(`${url}${pathname}`, init);
    if (!response.ok) throw new Error(`model stub ${pathname}: ${response.status}`);
    return response.json();
  };
  return {
    url,
    port: server.address().port,
    /** The chat requests the stub got; with `marker`, the ones with a message that contains it. */
    async requests(marker) {
      const query = marker ? `?marker=${encodeURIComponent(marker)}` : '';
      return (await json(`/__requests${query}`)).items;
    },
    /** `{ aborted, hanging }`: calls the server gave up, and the keys of the hangs that wait. */
    stats: () => json('/__stats'),
    /** Wait until the hang `e2e-hang:<key>` reached the stub. */
    hanging: (key, timeoutMs = KILL_POINT_TIMEOUT_MS) =>
      until(async () => (await json('/__stats')).hanging.includes(key), {
        what: `the model call e2e-hang:${key}`,
        timeoutMs
      }),
    release: key => json(`/__release/${encodeURIComponent(key)}`, { method: 'POST' }),
    releaseAll: () => json('/__release-all', { method: 'POST' }),
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

/** Run `seed.mjs` on a contents directory and wait for it, at most `timeoutMs`. */
async function seedContents({ contentsDir, seed, logFile, timeoutMs }) {
  const target = launch({
    script: path.join(here, 'seed.mjs'),
    cwd: root,
    env: childEnv({
      NODE_ENV: 'test',
      CONTENTS_DIR: contentsDir,
      FAULTS_SEED: JSON.stringify(seed)
    }),
    logFile
  });
  // Held on an object: the timer sets it, the lines after the wait read it.
  const state = { late: false };
  const timer = setTimeout(() => {
    state.late = true;
    target.signal('SIGKILL');
  }, timeoutMs);
  const exit = await target.exited;
  clearTimeout(timer);
  if (state.late) {
    throw new Error(
      `Seeding ${contentsDir} did not finish within ${timeoutMs} ms${target.logTail()}`
    );
  }
  if (exit.code !== 0) {
    throw new Error(
      `Seeding ${contentsDir} failed (${exit.signal ?? `code ${exit.code}`})${target.logTail()}`
    );
  }
}

/**
 * Start a stack: a seeded contents directory, the model stub, the counter and
 * a real server.
 *
 * @param {Object} [options]
 * @param {number} [options.workers=1] - 1 for one process, 2 for a primary with two workers
 * @param {string} [options.contents] - The name of an existing `contents-e2e*`
 *   directory to start on, as another stack left it. Its two stub models are
 *   pointed at the model stub of this stack, nothing else is changed, and
 *   `stack.stop()` leaves the directory where it is: it belongs to whoever
 *   made it. Without it a fresh directory is seeded and removed again.
 * @param {Object} [options.stub] - Options of `startLlmStub` (a scripted model)
 * @param {string} [options.killPoint] - `<name>` or `<name>@<n>` of KILLPOINTS.md
 * @param {Object} [options.env] - More environment for the server
 * @param {{features?: Object, platform?: Object, apps?: Object[], workflows?: Object}} [options.seed] -
 *   What the contents directory gets beyond the standard (see `seed.mjs`)
 * @param {boolean} [options.keepContents] - Keep the contents directory when the
 *   stack stops, with the output of its servers in `faults-server.log`. The
 *   default is what `KEEP_FAULT_CONTENTS=1` says.
 * @param {number} [options.startTimeoutMs] - The limit of the whole start, seed
 *   and server together. A start that runs into it stops what it started and
 *   rejects.
 * @returns {Promise<Object>} The stack (see the module comment and the returned object)
 */
export async function startStack({
  workers = 1,
  contents,
  stub: stubOptions,
  killPoint,
  env: extraEnv = {},
  seed = {},
  keepContents = keepsContents(),
  startTimeoutMs = START_TIMEOUT_MS
} = {}) {
  if (workers !== 1 && workers !== 2) throw new Error('workers must be 1 or 2');
  // One limit for the seed and the first start together: see SETUP_TIMEOUT_MS.
  const deadline = Date.now() + startTimeoutMs;
  const remaining = () => Math.max(deadline - Date.now(), 1);
  const ownsContents = !contents;
  const contentsDir = contents || `contents-e2e-faults-${crypto.randomBytes(4).toString('hex')}`;
  // Refuses anything but a `contents-e2e*` directory inside the repository.
  const contentsPath = disposableContentsPath(root, contentsDir);
  if (!ownsContents && !fs.existsSync(path.join(contentsPath, 'config', 'platform.json'))) {
    throw new Error(
      `"${contentsDir}" is not a contents directory a stack left. ` +
        'Leave `contents` out to start on a fresh one.'
    );
  }
  if (!ownsContents && Object.keys(seed).length > 0) {
    throw new Error('`seed` is for a fresh contents directory; `contents` names one that exists.');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-faults-'));
  scratches.add(scratch);
  const logFile = path.join(scratch, SERVER_LOG);

  const stub = await startStub(stubOptions);
  const counterServer = await startCounter();
  const port = await freePort();
  const url = loopback(port);
  let server = null;
  let reachedFile = null;
  let starts = 0;

  const start = async ({
    killPoint: spec,
    env: startEnv = {},
    clockAheadMs = 0,
    timeoutMs = START_TIMEOUT_MS
  } = {}) => {
    const armed = arm(spec, scratch);
    reachedFile = armed.reachedFile;
    starts += 1;
    server = launch({
      script: 'server.js',
      cwd: path.join(root, 'server'),
      // A cluster primary passes the options of `node` on to its workers.
      nodeArgs: clockAheadMs > 0 ? ['--import', CLOCK_AHEAD] : [],
      env: childEnv({
        NODE_ENV: 'test',
        WORKERS: String(workers),
        CONTENTS_DIR: contentsDir,
        HOST: '127.0.0.1',
        PORT: String(port),
        IHUB_TEST_TOOLS: '1',
        IHUB_TEST_COUNTER_URL: counterServer.url,
        ...extraEnv,
        ...startEnv,
        ...(clockAheadMs > 0 ? { FAULTS_CLOCK_AHEAD_MS: String(clockAheadMs) } : {}),
        ...armed.env
      }),
      logFile
    });
    const started = server;
    await until(
      async () => {
        if (!started.running()) {
          throw new Error(`The server exited while it was starting.${started.logTail()}`);
        }
        return answers(`${url}/api/health`);
      },
      { what: 'the server to answer /api/health', timeoutMs, detail: () => started.logTail() }
    );
  };

  const stack = {
    url,
    workers,
    contentsDir,
    contentsPath,
    logFile,
    stub,
    /** Whether `stop()` keeps the contents directory, with the output of the servers in it. */
    keepsContents: keepContents,
    /** The counter: `count(key)`, `read(key)`, `writers(key)`, `snapshot()`, `reset()`. */
    counter: counterServer.counter,
    /** How often a server was started on this contents directory. */
    get starts() {
      return starts;
    },
    get running() {
      return Boolean(server?.running());
    },
    /**
     * Signal the server (a primary and its workers at once). `SIGKILL` and
     * `SIGTERM` resolve when the process is gone; `SIGSTOP` and `SIGCONT` at once.
     *
     * @param {'SIGKILL'|'SIGTERM'|'SIGSTOP'|'SIGCONT'} [signal='SIGKILL']
     */
    async kill(signal = 'SIGKILL') {
      if (!server) return;
      if (signal === 'SIGSTOP' || signal === 'SIGCONT') {
        server.signal(signal);
        return;
      }
      await end(server, signal);
      server = null;
    },
    /**
     * Stop the server when it still runs, and start one on the same contents
     * directory. Resolves when it answers, or rejects after `RESTART_TIMEOUT_MS`
     * with the log of the server: before the case that restarts is cancelled.
     *
     * @param {Object} [options]
     * @param {string} [options.killPoint] - The kill point of the new server; none when absent
     * @param {'SIGKILL'|'SIGTERM'} [options.signal='SIGKILL'] - How a running server is stopped
     * @param {Object} [options.env] - More environment for this start
     * @param {number} [options.clockAheadMs] - Start the server with its clock this far
     *   ahead (`fixtures/clockAhead.mjs`): "the person came back later", without a sleep
     */
    async restart({ killPoint: spec, signal = 'SIGKILL', env, clockAheadMs } = {}) {
      await stack.kill(signal);
      await start({ killPoint: spec, env, clockAheadMs, timeoutMs: RESTART_TIMEOUT_MS });
    },
    /**
     * Wait until the server reached its kill point. With one worker the whole
     * server is gone afterwards; with two, the worker that reached it is, and
     * the primary starts another.
     *
     * @param {string} name
     * @param {number} [timeoutMs]
     */
    async waitKilledAt(name, timeoutMs = KILL_POINT_TIMEOUT_MS) {
      const exit = await killedAt(server, reachedFile, name, {
        timeoutMs,
        processDies: workers === 1
      });
      if (workers === 1) server = null;
      return exit;
    },
    /**
     * The names the server of this start wrote before it died there: one line
     * for each time a kill point fired. Empty for a start without a kill point.
     *
     * @returns {string[]}
     */
    killPointHits() {
      if (!reachedFile) return [];
      try {
        return fs
          .readFileSync(reachedFile, 'utf8')
          .split('\n')
          .filter(line => line !== '');
      } catch {
        return [];
      }
    },
    /**
     * Wait until the server answers again (a worker was replaced).
     *
     * @param {Object} [options]
     * @param {number} [options.timeoutMs]
     */
    healthy: ({ timeoutMs = START_TIMEOUT_MS } = {}) =>
      until(() => answers(`${url}/api/health`), {
        what: 'the server to answer /api/health',
        timeoutMs,
        detail: () => server?.logTail() ?? ''
      }),
    /**
     * An HTTP client signed in as a user: the default admin unless told otherwise.
     *
     * @param {{username: string, password: string}} [credentials]
     */
    api: (credentials = ADMIN) => signIn(url, credentials),
    /** The stored chat, as `GET /api/chats/{chatId}` answers it. */
    async readChat(chatId, api) {
      return (api || (await stack.api())).get(`/api/chats/${encodeURIComponent(chatId)}`);
    },
    /** The events of a run, as `GET /api/runs/{runId}/events` answers them. */
    async readLedger(runId, api) {
      return (api || (await stack.api())).get(`/api/runs/${encodeURIComponent(runId)}/events`);
    },
    /** The evidence record of a run, as `GET /api/runs/{runId}/evidence` answers it. */
    async evidence(runId, api) {
      return (api || (await stack.api())).get(`/api/runs/${encodeURIComponent(runId)}/evidence`);
    },
    /**
     * A document as the filesystem storage provider holds it on disk
     * (`data/<namespace>/<key>.json`), or null. This is what a server that
     * starts now would find: an API answer can come from the memory of the
     * running server and say more than the disk does.
     *
     * @param {string} namespace - For example `runs`, `chats`, `workflow-state`
     * @param {string} key
     * @returns {Object|null} The stored value
     */
    stored(namespace, key) {
      try {
        const file = path.join(
          contentsPath,
          'data',
          plainName(namespace),
          `${plainName(key)}.json`
        );
        return JSON.parse(fs.readFileSync(file, 'utf8')).data ?? null;
      } catch {
        return null;
      }
    },
    /**
     * The events of a run that are on disk (`data/logs/run/<runId>.jsonl`),
     * oldest first; empty when there is no file. The server writes its events
     * in batches, so this can be behind `readLedger`.
     *
     * @param {string} runId
     * @returns {Object[]}
     */
    journal(runId) {
      try {
        const file = path.join(contentsPath, 'data', 'logs', 'run', `${plainName(runId)}.jsonl`);
        return fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(line => line !== '')
          .map(line => JSON.parse(line));
      } catch {
        return [];
      }
    },
    /** The last output of the server, for a failure message. */
    logTail: () => server?.logTail() ?? '',
    /**
     * Stop everything, and remove the contents directory when this stack made
     * it. A directory that was handed in (`contents`) stays. A stack that
     * keeps its contents removes nothing and adds the output of its servers to
     * `faults-server.log` in the directory.
     */
    async stop() {
      await stack.kill('SIGKILL');
      await stub.releaseAll().catch(() => {});
      await stub.close();
      await counterServer.close();
      const { log, remove } = afterStop({ keep: keepContents, ownsContents });
      try {
        // A stack whose seed failed has no directory to put the log into. Added,
        // not copied: a second stack on the directory has a log of its own.
        if (log && fs.existsSync(contentsPath) && fs.existsSync(logFile)) {
          fs.appendFileSync(path.join(contentsPath, SERVER_LOG), fs.readFileSync(logFile));
        }
        if (remove) removeDisposableContents(root, contentsDir);
        // The entry is the one of the stack that made the directory: a stack
        // that was started on it leaves the entry, as it leaves the directory.
        if (ownsContents) seeded.delete(contentsDir);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
        scratches.delete(scratch);
      }
    }
  };

  try {
    if (ownsContents) {
      // What is kept is not removed when the process ends either.
      if (!keepContents) seeded.add(contentsDir);
      await seedContents({
        contentsDir,
        seed: { ...seed, llmPort: stub.port },
        logFile,
        timeoutMs: remaining()
      });
    } else {
      // The models of the directory name the stub of the stack that seeded it.
      writeStubModels({ root, contentsDir, llmPort: stub.port });
    }
    await start({ killPoint, timeoutMs: remaining() });
  } catch (error) {
    await stack.stop().catch(() => {});
    throw error;
  }
  return stack;
}

/**
 * Start the fixture server of the harness self-test (`fixtures/journalServer.mjs`):
 * a job with one write and a journal, on a counter in this process.
 *
 * @param {Object} [options]
 * @param {boolean} [options.guard=true] - false starts it with the protection
 *   against a repeated write switched off
 * @param {string} [options.killPoint]
 * @returns {Promise<Object>} `{ url, counter, running, runJob, job, waitKilledAt, restart, stop }`
 */
export async function startFixture({ guard = true, killPoint } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-faults-fixture-'));
  scratches.add(scratch);
  const logFile = path.join(scratch, 'fixture.log');
  const journal = path.join(scratch, 'journal.jsonl');
  const counterServer = await startCounter();
  const port = await freePort();
  const url = loopback(port);
  let server = null;
  let reachedFile = null;

  const start = async ({ killPoint: spec, guard: withGuard, timeoutMs = START_TIMEOUT_MS }) => {
    const armed = arm(spec, scratch);
    reachedFile = armed.reachedFile;
    server = launch({
      script: path.join(here, 'fixtures', 'journalServer.mjs'),
      cwd: root,
      env: childEnv({
        NODE_ENV: 'test',
        PORT: String(port),
        FIXTURE_JOURNAL: journal,
        FIXTURE_COUNTER_URL: counterServer.url,
        ...(withGuard ? {} : { FIXTURE_WRITE_GUARD: 'off' }),
        ...armed.env
      }),
      logFile
    });
    const started = server;
    await until(
      async () => {
        if (!started.running()) {
          throw new Error(`The fixture server exited while it was starting.${started.logTail()}`);
        }
        return answers(`${url}/health`);
      },
      {
        what: 'the fixture server to answer /health',
        timeoutMs,
        detail: () => started.logTail()
      }
    );
  };

  const fixture = {
    url,
    counter: counterServer.counter,
    /** Whether the process of the fixture server is there. */
    get running() {
      return Boolean(server?.running());
    },
    /**
     * Run a job. Resolves with the answer, or with `{ error }` when the server
     * died before it answered.
     */
    async runJob(id) {
      try {
        const response = await fetch(`${url}/jobs/${id}`, { method: 'POST' });
        return { status: response.status, body: await response.json() };
      } catch (error) {
        return { status: 0, error };
      }
    },
    /** The state of a job as the running server knows it. */
    async job(id) {
      return (await fetch(`${url}/jobs/${id}`)).json();
    },
    async waitKilledAt(name, timeoutMs = KILL_POINT_TIMEOUT_MS) {
      const exit = await killedAt(server, reachedFile, name, { timeoutMs, processDies: true });
      server = null;
      return exit;
    },
    /** Start the server again on the same journal. */
    async restart({ killPoint: spec, guard: withGuard = guard } = {}) {
      await end(server, 'SIGKILL');
      await start({ killPoint: spec, guard: withGuard, timeoutMs: RESTART_TIMEOUT_MS });
    },
    async stop() {
      await end(server, 'SIGKILL');
      server = null;
      await counterServer.close();
      fs.rmSync(scratch, { recursive: true, force: true });
      scratches.delete(scratch);
    }
  };

  try {
    await start({ killPoint, guard });
  } catch (error) {
    await fixture.stop().catch(() => {});
    throw error;
  }
  return fixture;
}
