// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The side-effect counter of the fault tests and of the agents browser suite.
 *
 * A test of "this write ran exactly once" needs a write whose effect a killed
 * server cannot take along and cannot hide. The counter lives in the process of
 * the test (the fault harness, `agents-server.mjs`), never in the server under
 * test. The server reaches it over HTTP through its test tools
 * (`server/services/integrations/protocols/native/connectors/testTools.js`):
 *
 * - `POST /count/<key>` (the tool `e2e_counter_write`) adds one to the counter of
 *   `<key>` and answers `{ key, count }`. A JSON body `{ "value": "<text>" }`
 *   stores the text with the write. The header `x-ihub-test-writer` names the
 *   process that wrote (the tool sends its process id), for a test that has to
 *   know which worker of a server did.
 * - `GET /count/<key>` (the tool `e2e_counter_read`) answers
 *   `{ key, count, values }`.
 *
 * For the test itself:
 *
 * - `GET /__counter` answers `{ total, counters: { <key>: { count, values } } }`.
 * - `POST /__counter/reset` sets everything to zero and answers `{ total: 0, counters: {} }`.
 *   It also ends a hold and answers the reads that waited.
 * - `POST /__counter/hold` makes every read wait from now on: a read (`GET /count/<key>`)
 *   is not answered until it is released. `GET /__counter/waiting` answers
 *   `{ holding, waiting: [<key>, …] }`, the keys of the reads that wait, in the order
 *   they arrived. `POST /__counter/release` answers the reads that wait now and keeps
 *   holding the ones that come later; it answers `{ released: <count> }`. A test of
 *   "these two calls ran at the same time" reads the waiting list: two keys in it were
 *   in flight together, with no timer involved. Writes are never held.
 *
 * Every write is counted, also two writes for one tool call: a double write
 * shows as a count of 2. The counter never deduplicates.
 */

import http from 'node:http';

/** The request header in which a write names the process it comes from. */
export const WRITER_HEADER = 'x-ihub-test-writer';

/** What names a writer: a process id, or a plain word a test chose. */
const WRITER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A key as the test tools accept it. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A body larger than this is refused: nothing a test stores is that long. */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * A counter and its HTTP handler.
 *
 * @returns {{
 *   write: (key: string, value?: string, writer?: string) => number,
 *   read: (key: string) => {key: string, count: number, values: string[]},
 *   count: (key: string) => number,
 *   writers: (key: string) => string[],
 *   snapshot: () => {total: number, counters: Record<string, {count: number, values: string[]}>},
 *   reset: () => void,
 *   hold: () => void,
 *   waiting: () => string[],
 *   release: () => number,
 *   handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>
 * }} `handle` answers the request when it is one of the counter's and resolves to
 *   whether it did, so another server can serve the counter next to its own paths.
 *   `writers` lists who wrote a key, one entry for each write that named its
 *   writer, in the order of the writes; it is not part of what `read` and
 *   `snapshot` answer.
 */
export function createCounter() {
  /** @type {Map<string, {count: number, values: string[]}>} */
  const counters = new Map();
  /** @type {Map<string, string[]>} */
  const writersOf = new Map();

  const entry = key => counters.get(key) || { count: 0, values: [] };
  const write = (key, value, writer) => {
    if (typeof writer === 'string' && WRITER.test(writer)) {
      writersOf.set(key, [...(writersOf.get(key) || []), writer]);
    }
    const next = entry(key);
    const updated = {
      count: next.count + 1,
      values: typeof value === 'string' ? [...next.values, value] : next.values
    };
    counters.set(key, updated);
    return updated.count;
  };
  const read = key => {
    const { count, values } = entry(key);
    return { key, count, values: [...values] };
  };
  const snapshot = () => {
    const all = {};
    let total = 0;
    for (const [key, { count, values }] of counters) {
      all[key] = { count, values: [...values] };
      total += count;
    }
    return { total, counters: all };
  };
  /** Whether reads wait, and the reads that do: the key and how to answer it. */
  let holding = false;
  /** @type {Array<{key: string, answer: () => void}>} */
  let held = [];
  const release = () => {
    const waited = held;
    held = [];
    for (const read of waited) read.answer();
    return waited.length;
  };
  const reset = () => {
    counters.clear();
    writersOf.clear();
    holding = false;
    release();
  };

  const answer = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const handle = async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/__counter' && req.method === 'GET') {
      answer(res, 200, snapshot());
      return true;
    }
    if (pathname === '/__counter/reset' && req.method === 'POST') {
      reset();
      answer(res, 200, snapshot());
      return true;
    }
    if (pathname === '/__counter/hold' && req.method === 'POST') {
      holding = true;
      answer(res, 200, { holding, waiting: held.map(read => read.key) });
      return true;
    }
    if (pathname === '/__counter/waiting' && req.method === 'GET') {
      answer(res, 200, { holding, waiting: held.map(read => read.key) });
      return true;
    }
    if (pathname === '/__counter/release' && req.method === 'POST') {
      answer(res, 200, { released: release() });
      return true;
    }
    if (!pathname.startsWith('/count/')) return false;

    let key;
    try {
      key = decodeURIComponent(pathname.slice('/count/'.length));
    } catch {
      key = '';
    }
    if (!KEY.test(key)) {
      answer(res, 400, {
        error: 'key must be 1 to 64 letters, digits, dots, underscores, hyphens'
      });
      return true;
    }
    if (req.method === 'GET') {
      // Answered with the count at the time of the release: the read "takes" that long.
      const respond = () => answer(res, 200, read(key));
      if (holding) {
        const waitingRead = { key, answer: respond };
        held.push(waitingRead);
        // A caller that gave up is not waiting any more.
        res.on('close', () => {
          held = held.filter(entryOf => entryOf !== waitingRead);
        });
      } else {
        respond();
      }
      return true;
    }
    if (req.method === 'POST') {
      let value;
      try {
        const text = await readBody(req);
        value = text ? JSON.parse(text)?.value : undefined;
      } catch {
        answer(res, 400, { error: 'the body must be JSON of at most 64 KB' });
        return true;
      }
      answer(res, 200, { key, count: write(key, value, req.headers[WRITER_HEADER]) });
      return true;
    }
    answer(res, 405, { error: 'GET or POST' });
    return true;
  };

  return {
    write,
    read,
    count: key => entry(key).count,
    writers: key => [...(writersOf.get(key) || [])],
    snapshot,
    reset,
    hold: () => {
      holding = true;
    },
    waiting: () => held.map(read => read.key),
    release,
    handle
  };
}

/**
 * A counter on a port of its own, on the loopback interface.
 *
 * @param {number} [port=0] - 0 for any free port
 * @returns {Promise<{counter: ReturnType<typeof createCounter>, url: string, port: number, close: () => Promise<void>}>}
 */
export function startCounter(port = 0) {
  const counter = createCounter();
  const server = http.createServer((req, res) => {
    counter
      .handle(req, res)
      .then(handled => {
        if (handled) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      })
      .catch(error => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      resolve({
        counter,
        port: bound,
        url: `http://127.0.0.1:${bound}`,
        close: () =>
          new Promise(done => {
            server.close(() => done());
            server.closeAllConnections();
          })
      });
    });
  });
}
