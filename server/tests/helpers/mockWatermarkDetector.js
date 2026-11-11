// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A mock watermark detector for CI and for UI work (#3331).
 *
 * Scoring is a simulation, not Gumbel: a text registered through `markText`
 * whose key is among the request's `keys` gets `p_value` 1e-9, everything else
 * 0.47; `num_scored_tokens` is `round(words * 1.3)`. Every request is recorded,
 * so a test can assert exactly which keys, headers and fields were sent.
 *
 * Modes: `ok`, `401`, `500`, `slow`, `badJson`, `oversize`, `redirect` (to
 * `redirectTo`), `unknownKey` (answers for a key id that was never sent).
 *
 * @example
 * const mock = await startMockDetector({ token: 'secret' });
 * mock.markText('some text', 4242);
 * // ... call the detector at mock.url ...
 * await mock.close();
 */
import http from 'node:http';

/**
 * @param {Object} [options]
 * @param {string} [options.token] - Bearer token to require (default: any).
 * @param {number} [options.port]
 * @param {string} [options.host]
 */
export async function startMockDetector({ token, port = 0, host = '127.0.0.1', server } = {}) {
  const calls = [];
  const marked = new Map(); // text -> key value
  let mode = 'ok';
  let redirectTo = null;

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'slow') return; // never answers; the client times out
      if (mode === 'redirect') {
        res.writeHead(307, { Location: redirectTo || '/elsewhere' });
        return res.end();
      }
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        return res.end('{}');
      }
      if (mode === '401') {
        res.writeHead(401);
        return res.end('{}');
      }
      if (mode === '500') {
        res.writeHead(500);
        return res.end('{}');
      }
      if (mode === 'badJson') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('not json');
      }
      if (mode === 'oversize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ num_scored_tokens: 1, results: [], pad: 'x'.repeat(100_000) })
        );
      }
      const text = body?.text ?? '';
      const keys = Array.isArray(body?.keys) ? body.keys : [];
      const words = text.split(/\s+/).filter(Boolean).length;
      const markedKey = marked.get(text);
      const results = keys.map(entry => ({
        key_id: entry.key_id,
        p_value: markedKey !== undefined && entry.key === markedKey ? 1e-9 : 0.47,
        score: 0
      }));
      if (mode === 'unknownKey') results.push({ key_id: 'wm-9999-9', p_value: 1e-12 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ num_scored_tokens: Math.round(words * 1.3), results }));
    });
  };

  const instance = server || http.createServer(handler);
  if (server) server.on('request', handler);
  await new Promise(resolve => instance.listen(port, host, resolve));
  const address = instance.address();
  return {
    url: `${server ? 'https' : 'http'}://${host}:${address.port}/detect`,
    port: address.port,
    calls,
    markText(text, keyValue) {
      marked.set(text, keyValue);
    },
    setMode(next, options = {}) {
      mode = next;
      if (options.redirectTo) redirectTo = options.redirectTo;
    },
    close: () => new Promise(resolve => instance.close(resolve))
  };
}
