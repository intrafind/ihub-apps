// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The connect ceiling against a real socket: `httpFetch`'s `onConnect` fires
 * once the connection is up, before the server has sent any headers, so a
 * provider that withholds its headers while it thinks (Google) is not
 * reported as unreachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpFetch } from '../../utils/httpConfig.js';
import { makeClient, MODELS, openaiText } from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'hi' }];

/** A local server that holds its response headers for `delayMs`. */
async function slowHeadersServer(delayMs, body = 'ok') {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(body);
      }, delayMs);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1/chat/completions` };
}

test('httpFetch calls onConnect when the socket connects, before the headers arrive', async () => {
  const { server, url } = await slowHeadersServer(200);
  try {
    const started = Date.now();
    let connectedAfter = null;
    const res = await httpFetch(url, {
      method: 'POST',
      body: '{}',
      onConnect: () => {
        connectedAfter = Date.now() - started;
      }
    });
    const headersAfter = Date.now() - started;
    await res.text();
    assert.ok(connectedAfter !== null, 'onConnect was called');
    assert.ok(connectedAfter < 150, `connected early (${connectedAfter}ms)`);
    assert.ok(headersAfter >= 190, `headers came later (${headersAfter}ms)`);
  } finally {
    server.close();
  }
});

test('httpFetch calls onConnect for a request on a reused keep-alive socket', async () => {
  const { server, url } = await slowHeadersServer(0);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await (await httpFetch(url, { method: 'POST', body: '{}', agent })).text();
    let connected = 0;
    await (
      await httpFetch(url, { method: 'POST', body: '{}', agent, onConnect: () => connected++ })
    ).text();
    assert.equal(connected, 1);
  } finally {
    agent.destroy();
    server.close();
  }
});

test('a provider that is reachable but slow to send headers is not a connect timeout', async () => {
  const wire = openaiText(['answered after thinking'])
    .map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
    .join('');
  const { server, url } = await slowHeadersServer(300, wire);
  try {
    const { client } = makeClient({
      connectTimeoutMs: 50,
      maxRetries: 0,
      models: [{ ...MODELS.openai, url }],
      // The default transport's shape: httpFetch with the ceiling's callback.
      transport: (request, ctx) =>
        httpFetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: ctx.signal,
          onConnect: ctx.onConnected
        })
    });
    const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 });
    const res = await client.collect(stream);
    assert.equal(res.content, 'answered after thinking');
  } finally {
    server.close();
  }
});
