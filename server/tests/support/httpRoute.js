// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Drives a registered route's handler chain over a real HTTP connection.
 *
 * A response double cannot show what a client sees when a streamed download
 * breaks: whether the transfer ended or was cut, and how `Content-Length`
 * relates to what arrived. This mounts the handlers on an Express app, calls
 * it with Node's own HTTP client and reports exactly that.
 *
 * @module tests/support/httpRoute
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';
import errorHandler from '../../middleware/errorHandler.js';

/**
 * What the client saw.
 *
 * @typedef {Object} RouteOutcome
 * @property {number|null} status - Status code; null when the connection
 *   broke before the response headers.
 * @property {Object} headers - Response headers, lower-cased names.
 * @property {Buffer} body - The bytes that arrived.
 * @property {boolean} complete - True only when the response ended as HTTP
 *   says it should (all of `Content-Length`, or the final chunk). False for
 *   a transfer that was cut: what every HTTP client reports as a failed
 *   download.
 * @property {Error|null} error - What the client's request or response failed with.
 */

/**
 * Call a handler chain as `GET` (or another method) over HTTP.
 *
 * @param {Function[]} handlers - The chain as the route registered it.
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Object} [options.params] - Route parameters.
 * @param {Object} [options.query] - Query parameters.
 * @param {Object} [options.body] - JSON body.
 * @param {Object} [options.user] - `req.user`.
 * @param {Object} [options.headers] - Request headers.
 * @returns {Promise<RouteOutcome>}
 */
export async function callRoute(
  handlers,
  { method = 'GET', params = {}, query = {}, body, user, headers = {} } = {}
) {
  const app = express();
  app.use(express.json());
  app.all(
    '/probe',
    (req, _res, next) => {
      req.user = user;
      Object.assign(req.params, params);
      Object.defineProperty(req, 'query', { value: { ...query }, configurable: true });
      next();
    },
    ...handlers
  );
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise(resolve => {
      const chunks = [];
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const request = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/probe',
          method,
          agent: false,
          headers: {
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
            ...headers
          }
        },
        response => {
          const done = error =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
              complete: response.complete === true && !error,
              error: error || null
            });
          response.on('data', chunk => chunks.push(chunk));
          response.once('end', () => done(null));
          response.once('error', done);
          response.once('aborted', () => done(new Error('aborted')));
        }
      );
      request.once('error', error =>
        resolve({ status: null, headers: {}, body: Buffer.concat(chunks), complete: false, error })
      );
      request.end(payload || undefined);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

/**
 * Make the next `openRead` of a blob store hand out a stream that delivers
 * `after` genuine bytes and then fails with `error`: what an encrypted blob
 * does when one of its later segments does not verify.
 *
 * @param {Object} blobs - The blob store the code under test reads through.
 * @param {Object} options
 * @param {number} options.after - Bytes delivered before the failure.
 * @param {Error} options.error - What the stream fails with.
 * @returns {() => void} Restores the store.
 */
export function failNextOpenRead(blobs, { after, error }) {
  const original = blobs.openRead;
  let used = false;
  blobs.openRead = async function failingOpenRead(...args) {
    const opened = await original.apply(this, args);
    if (!opened || used) return opened;
    used = true;
    const source = opened.stream;
    const failing = Readable.from(
      (async function* cut() {
        let sent = 0;
        for await (const chunk of source) {
          const room = after - sent;
          if (chunk.length >= room) {
            if (room > 0) yield chunk.subarray(0, room);
            throw error;
          }
          sent += chunk.length;
          yield chunk;
        }
        throw error;
      })(),
      { objectMode: false }
    );
    return { ...opened, stream: failing };
  };
  return () => {
    blobs.openRead = original;
  };
}
