// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A mock of the detection endpoint built into iFinder's if-vllm model image
 * (`POST /watermark/v1/detect` on the vLLM port, RAG-1168), for tests of
 * `keyHolder: "model"`.
 *
 * The image holds its key files (`keys`, by label). A text registered through
 * `markText` with a label scores p = 1e-9 for that key's `gumbel` check;
 * everything else scores 0.5. Every key yields a `gumbel` and a
 * `dual_key_gumbel` check, as the real image does. `num_scored_tokens` is
 * `round(words * 1.3)`. Every request is recorded.
 *
 * Modes: `ok`, `401`, `500`, `badContract`.
 *
 * @example
 * const image = await startMockModelDetector({ apiKey: 'vllm-key', keys: ['key-2026-11'] });
 * image.markText('some text', 'key-2026-11');
 * // model.url = image.chatUrl; the detector is at image.detectUrl
 * await image.close();
 */
import http from 'node:http';

/**
 * @param {Object} [options]
 * @param {string} [options.apiKey] - `VLLM_API_KEY`: required as a bearer token when set
 * @param {string[]} [options.keys] - Key file names the image holds
 * @param {string} [options.tokenizer]
 */
export async function startMockModelDetector({
  apiKey,
  keys = ['key-2026-11'],
  tokenizer = 'org/model@abc1234'
} = {}) {
  const calls = [];
  const marked = new Map(); // text -> key label
  let mode = 'ok';

  const server = http.createServer((req, res) => {
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
      if (req.url !== '/watermark/v1/detect') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not Found' }));
      }
      if ((apiKey && req.headers.authorization !== `Bearer ${apiKey}`) || mode === '401') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      if (mode === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'detection failed' }));
      }
      if (mode === 'badContract') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: 'nope' }));
      }
      const text = body?.text ?? '';
      const tokens = Math.round(text.split(/\s+/).filter(Boolean).length * 1.3);
      const label = marked.get(text);
      const parameters = { context_width: 4, deduplicate_contexts: true, prf: 'philox' };
      // Different keys give different p-values (identical ones would count once).
      const results = keys.flatMap((key, index) => [
        {
          key_label: key,
          algorithm: 'gumbel',
          parameters,
          p_value: key === label ? 1e-9 : 0.5 + index / 100,
          score: 0,
          num_scored_tokens: tokens
        },
        {
          key_label: key,
          algorithm: 'dual_key_gumbel',
          parameters: { ...parameters, alpha: 0.4 },
          p_value: 0.6 + index / 100,
          score: 0,
          num_scored_tokens: tokens
        }
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tokenizer, vllm_version: '0.34.0', results }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    chatUrl: `${base}/v1/chat/completions`,
    detectUrl: `${base}/watermark/v1/detect`,
    calls,
    markText(text, keyLabel) {
      marked.set(text, keyLabel);
    },
    setMode(next) {
      mode = next;
    },
    close: () => new Promise(resolve => server.close(resolve))
  };
}
