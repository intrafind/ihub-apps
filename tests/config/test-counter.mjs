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
 *   stores the text with the write.
 * - `GET /count/<key>` (the tool `e2e_counter_read`) answers
 *   `{ key, count, values }`.
 *
 * For the test itself:
 *
 * - `GET /__counter` answers `{ total, counters: { <key>: { count, values } } }`.
 * - `POST /__counter/reset` sets everything to zero and answers `{ total: 0, counters: {} }`.
 *
 * Every write is counted, also two writes for one tool call: a double write
 * shows as a count of 2. The counter never deduplicates.
 */

import http from 'node:http';

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
 *   write: (key: string, value?: string) => number,
 *   read: (key: string) => {key: string, count: number, values: string[]},
 *   count: (key: string) => number,
 *   snapshot: () => {total: number, counters: Record<string, {count: number, values: string[]}>},
 *   reset: () => void,
 *   handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>
 * }} `handle` answers the request when it is one of the counter's and resolves to
 *   whether it did, so another server can serve the counter next to its own paths.
 */
export function createCounter() {
  /** @type {Map<string, {count: number, values: string[]}>} */
  const counters = new Map();

  const entry = key => counters.get(key) || { count: 0, values: [] };
  const write = (key, value) => {
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
  const reset = () => counters.clear();

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
      answer(res, 200, read(key));
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
      answer(res, 200, { key, count: write(key, value) });
      return true;
    }
    answer(res, 405, { error: 'GET or POST' });
    return true;
  };

  return { write, read, count: key => entry(key).count, snapshot, reset, handle };
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
