// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A real HTTP server for the surfaces that are recorded through their route:
 * an Express app with the product's route modules, the product's error
 * handler, and one thing in front of them that the product does not have, a
 * middleware that signs the request in as the principal of the case. The
 * login itself is not what these goldens are about.
 *
 * Nothing here waits on a timer. A stream is read until a frame says the turn
 * is over, a response until it ends.
 *
 * @module tests/golden/surfaces/http
 */
import http from 'node:http';
import express from 'express';
import errorHandler from '../../../middleware/errorHandler.js';
import { byCodeUnit } from '../byCodeUnit.js';

/**
 * Start a server on a free port of the loopback interface.
 *
 * @param {Object} options
 * @param {(req: Object) => Object|null} options.user - The principal of a request.
 * @param {(app: Object) => void} options.register - Mounts the routes.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startRouteServer({ user, register }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => {
    req.user = user(req);
    next();
  });
  register(app);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/** Parse the text of an SSE response into frames; comment lines are keep-alives and are dropped. */
export function parseSse(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter(line => line && !line.startsWith(':'));
    if (lines.length === 0) continue;
    const frame = {};
    for (const line of lines) {
      const at = line.indexOf(':');
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (field === 'data') {
        frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
      } else {
        frame[field] = value;
      }
    }
    if (typeof frame.data === 'string') {
      try {
        frame.data = JSON.parse(frame.data);
      } catch {
        // Not JSON (the `[DONE]` of an OpenAI stream): kept as text.
      }
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * The headers of a response that say nothing about behaviour: the connection, the date, and two
 * that follow from the length of the body (which holds the product version).
 */
const UNRECORDED_HEADERS = new Set([
  'connection',
  'content-length',
  'date',
  'etag',
  'keep-alive',
  'transfer-encoding',
  'x-powered-by'
]);

function recordedHeaders(headers) {
  const out = {};
  for (const name of Object.keys(headers).sort(byCodeUnit)) {
    if (!UNRECORDED_HEADERS.has(name)) out[name] = headers[name];
  }
  return out;
}

/**
 * Send one request and read the response as it comes.
 *
 * The returned object is the open exchange: `frames` grows while an SSE
 * response streams, `until(predicate)` resolves when a frame matches,
 * `done` when the response ended (or was cut), and `abort()` cuts the
 * connection from the client's side.
 *
 * @param {Object} options
 * @param {number} options.port
 * @param {string} options.method
 * @param {string} options.path
 * @param {Object} [options.body] - Sent as JSON.
 * @param {Object} [options.headers]
 * @returns {{frames: Object[], until: (predicate: (frame: Object) => boolean) => Promise<Object>,
 *   headersReceived: Promise<void>, done: Promise<Object>, abort: () => void}}
 */
export function openRequest({ port, method, path, body, headers = {} }) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const exchange = { frames: [], status: null, headers: {}, text: '' };
  const waiters = [];
  let ended = false;
  let parsedUpTo = 0;
  let resolveHeaders;
  exchange.headersReceived = new Promise(resolve => (resolveHeaders = resolve));

  const isStream = () => String(exchange.headers['content-type'] || '').includes('event-stream');
  const drain = final => {
    if (!isStream()) return;
    // Only whole frames: a frame ends with an empty line.
    const end = final ? exchange.text.length : exchange.text.lastIndexOf('\n\n') + 2;
    if (end <= parsedUpTo) return;
    exchange.frames.push(...parseSse(exchange.text.slice(parsedUpTo, end)));
    parsedUpTo = end;
    for (const waiter of waiters.splice(0)) {
      const found = exchange.frames.find(waiter.predicate);
      if (found) waiter.resolve(found);
      else waiters.push(waiter);
    }
  };

  exchange.done = new Promise((resolve, reject) => {
    const finish = cut => {
      if (ended) return;
      ended = true;
      drain(true);
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`the response ended before the awaited frame (${waiter.what})`));
      }
      const record = { status: exchange.status, headers: recordedHeaders(exchange.headers) };
      if (isStream()) record.stream = exchange.frames;
      else if (String(exchange.headers['content-type'] || '').includes('json')) {
        record.body = exchange.text ? JSON.parse(exchange.text) : null;
      } else record.body = exchange.text;
      if (cut) record.cutByClient = true;
      resolve(record);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload === null
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...headers
        }
      },
      res => {
        exchange.status = res.statusCode;
        exchange.headers = res.headers;
        resolveHeaders();
        res.setEncoding('utf8');
        res.on('data', chunk => {
          exchange.text += chunk;
          drain(false);
        });
        res.on('end', () => finish(false));
        res.on('close', () => finish(exchange.aborted === true));
        res.on('error', () => finish(exchange.aborted === true));
      }
    );
    req.on('error', error => {
      if (exchange.aborted) finish(true);
      else reject(error);
    });
    exchange.abort = () => {
      exchange.aborted = true;
      req.destroy();
    };
    req.end(payload ?? undefined);
  });

  exchange.until = (predicate, what = 'a frame') => {
    const found = exchange.frames.find(predicate);
    if (found) return Promise.resolve(found);
    if (ended)
      return Promise.reject(new Error(`the response ended before the awaited frame (${what})`));
    return new Promise((resolve, reject) => waiters.push({ predicate, resolve, reject, what }));
  };
  return exchange;
}

/** Send one request and resolve with the whole response. */
export function request(options) {
  return openRequest(options).done;
}

/**
 * Send one request and resolve with the request and its response, as a golden holds an exchange.
 *
 * @param {number} port
 * @param {Object} options - `method`, `path`, `body` and `headers` of {@link openRequest}.
 * @returns {Promise<{request: Object, response: Object}>}
 */
export async function exchange(port, { method, path, body, headers }) {
  const response = await request({ port, method, path, body, headers });
  return {
    request: { method, path, ...(headers ? { headers } : {}), ...(body ? { body } : {}) },
    response
  };
}
