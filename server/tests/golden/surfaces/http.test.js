// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The client the surfaces read their routes with (`http.js`): what it makes of
 * a stream that arrives in pieces, of a body that is not what its header says,
 * and of a request that never gets an answer. Each of these would otherwise
 * show as a recording that differs with the machine, or as a job that hangs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { openRequest, request } from './http.js';

/** A server on a free loopback port that answers every request with `handler`. */
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('a frame that arrives in pieces is read once it is whole, whatever the pieces are', async t => {
  let continueWriting;
  const firstPieceRead = new Promise(resolve => (continueWriting = resolve));
  const port = await serve(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // As `sendSSE` writes a frame: the event line, then the data line.
    res.write('event: stream/connected\n');
    await firstPieceRead;
    res.write('data: {"type":"stream/connected"}\n\n');
    res.write('event: run/ended\ndata: {"type":"run/ended"}');
    res.end('\n\n');
  });
  const open = openRequest({ port, method: 'GET', path: '/' });
  await open.headersReceived;
  // Wait until the first piece is here: only then is the case the one this test is about.
  while (!open.text.includes('\n')) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(open.frames, [], 'half a frame is not a frame yet');
  continueWriting();
  const ended = await open.until(frame => frame.data?.type === 'run/ended', 'run/ended');
  assert.deepEqual(ended, { event: 'run/ended', data: { type: 'run/ended' } });
  const response = await open.done;
  assert.deepEqual(response.stream, [
    { event: 'stream/connected', data: { type: 'stream/connected' } },
    { event: 'run/ended', data: { type: 'run/ended' } }
  ]);
});

test('a body that says it is JSON and is not fails the request, and says which', async t => {
  const port = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"result":');
  });
  await assert.rejects(
    request({ port, method: 'GET', path: '/broken' }),
    /GET \/broken answered 200 with a body that is not JSON/
  );
});

test('a request that gets no answer ends every wait on it', async () => {
  // A port nothing listens on: taken, and given back.
  const taken = net.createServer();
  await new Promise(resolve => taken.listen(0, '127.0.0.1', resolve));
  const { port } = taken.address();
  await new Promise(resolve => taken.close(resolve));

  const open = openRequest({ port, method: 'GET', path: '/' });
  const waiting = open.until(() => false, 'a frame that cannot come');
  await assert.rejects(open.done, /ECONNREFUSED/);
  await assert.rejects(waiting, /ECONNREFUSED/);
  await assert.rejects(open.headersReceived, /ECONNREFUSED/);
  // A wait that starts after the failure does not start waiting.
  await assert.rejects(
    open.until(() => true, 'any frame'),
    /ECONNREFUSED/
  );
});
