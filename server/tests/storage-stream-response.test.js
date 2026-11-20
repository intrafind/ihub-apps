// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `sendStream` and the ZIP writer at the edges of a response's life: a client
 * that hung up before the handler got to answer, a stream that fails before
 * its first byte, and an archive whose first member cannot be opened.
 */
import './support/scratchContents.js';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { etagOfSha256, isFreshFor, sendStream } = await import('../utils/streamResponse.js');
const { writeZip } = await import('../services/artifacts/artifactZip.js');

const SHA = 'a'.repeat(64);

function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Run `handler` behind a real HTTP server and close the server afterwards. */
async function withServer(handler, use) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await use(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

/** GET over a fresh connection; resolves with what the client saw. */
function get(port, headers = {}) {
  return new Promise(resolve => {
    const chunks = [];
    http
      .get({ host: '127.0.0.1', port, path: '/', agent: false, headers }, response => {
        const done = error =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
            complete: response.complete === true && !error
          });
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => done(null));
        response.once('error', done);
      })
      .once('error', error => resolve({ status: null, headers: {}, complete: false, error }));
  });
}

/** A stream with plenty to send that counts on being read or destroyed. */
const largeStream = () => Readable.from([Buffer.alloc(4 * 1024 * 1024, 7)], { objectMode: false });

describe('sendStream: a client that hung up before the handler answered', () => {
  for (const method of ['GET', 'HEAD']) {
    it(`returns and releases the stream (${method})`, async () => {
      let stream;
      let outcome;
      const handled = new Promise(resolve => {
        outcome = resolve;
      });
      await withServer(
        (req, res) => {
          // What a route does before it answers (authorization, the metadata,
          // opening the blob) takes until the client is gone.
          res.once('close', () => {
            stream = largeStream();
            sendStream(req, res, stream, { headers: { 'Content-Length': '4194304' } }).then(
              () => outcome('resolved'),
              error => outcome(`rejected: ${error.message}`)
            );
          });
        },
        async port => {
          const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(`${method} / HTTP/1.1\r\nHost: x\r\n\r\n`, () => socket.destroy());
          });
          assert.equal(await within(handled, 3000, 'sendStream'), 'resolved');
        }
      );
      assert.equal(stream.destroyed, true, 'the source is released');
    });
  }
});

describe('sendStream: a stream that fails before its first byte', () => {
  it('throws, and leaves none of the headers it was given on the error answer', async () => {
    const broken = new Error('the store went away');
    const outcome = await withServer(
      async (req, res) => {
        const stream = new Readable({ read() {} });
        stream.on('error', () => {});
        setImmediate(() => stream.destroy(broken));
        try {
          await sendStream(req, res, stream, {
            headers: {
              'Content-Type': 'image/png',
              'Content-Length': '100',
              'Cache-Control': 'private, max-age=31536000, immutable',
              ETag: etagOfSha256(SHA)
            }
          });
          res.end('not reached');
        } catch (error) {
          res.statusCode = 503;
          res.end(error.message);
        }
      },
      port => get(port)
    );
    assert.equal(outcome.status, 503);
    assert.equal(outcome.body.toString(), broken.message);
    assert.equal(outcome.headers['cache-control'], undefined);
    assert.equal(outcome.headers.etag, undefined);
    assert.equal(outcome.headers['content-type'], undefined);
  });
});

describe('isFreshFor', () => {
  /** Ask over HTTP with Express' own freshness check. */
  async function ask(headers) {
    const { default: express } = await import('express');
    const app = express();
    app.get('/', (req, res) => {
      const fresh = isFreshFor(req, res, etagOfSha256(SHA));
      res.json({ fresh, etagOnResponse: res.getHeader('ETag') ?? null });
    });
    return withServer(app, port => get(port, headers));
  }

  it('leaves the ETag on the response only for the 304 answer', async () => {
    const stale = JSON.parse((await ask({})).body.toString());
    assert.deepEqual(stale, { fresh: false, etagOnResponse: null });
    const other = JSON.parse((await ask({ 'if-none-match': '"other"' })).body.toString());
    assert.deepEqual(other, { fresh: false, etagOnResponse: null });
    // Express answers a fresh request's `res.json` with 304 by itself; the
    // tag it compared is the one that was set.
    const fresh = await ask({ 'if-none-match': `"${SHA}"` });
    assert.equal(fresh.status, 304);
    assert.equal(fresh.headers.etag, `"${SHA}"`);
  });
});

describe('writeZip: the first member cannot be opened', () => {
  it('does not end the response by itself, so the error answer still goes out', async () => {
    const outcome = await withServer(
      async (req, res) => {
        res.setHeader('Content-Type', 'application/zip');
        try {
          await writeZip(
            [
              {
                path: 'gone.bin',
                open: async () => {
                  throw new Error('NOT_FOUND');
                }
              },
              { path: 'a.txt', data: Buffer.from('a') }
            ],
            res
          );
          res.end();
        } catch (error) {
          // An error middleware that answers later than in the same tick
          // (it awaits something, or logs asynchronously).
          setTimeout(() => {
            res.removeHeader('Content-Type');
            res.statusCode = 404;
            res.end(error.message);
          }, 50);
        }
      },
      port => get(port)
    );
    assert.equal(outcome.status, 404, 'not an empty 200');
    assert.equal(outcome.body.toString(), 'NOT_FOUND');
    assert.equal(outcome.complete, true);
  });
});
