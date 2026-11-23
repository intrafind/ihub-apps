// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A mock of the detection endpoint of an iFinder Model Gateway
 * (`POST /v1/gateway/detections/text`), plus an OAuth2 token endpoint
 * (`POST /oauth/token`, client credentials) for tests of the client-credentials
 * login.
 *
 * A text registered through `markText` is `DETECTED` with that key file name
 * (`key_label`); everything else is `NOT_DETECTED`. Every request is recorded.
 *
 * Modes: `ok`, `short` (`UNCLEAR`, too few tokens), `detectorsDown` (`UNCLEAR`,
 * a detector did not answer), `unavailable` (`503`), `badContract`, `401`.
 *
 * @example
 * const gateway = await startMockModelGateway({ token: 'secret' });
 * gateway.markText('some text', 'key-2026-11');
 * // ... call gateway.url ...
 * await gateway.close();
 */
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * @param {Object} [options]
 * @param {string} [options.token] - Bearer token to require on the detection endpoint
 * @param {{clientId: string, clientSecret: string, accessToken: string}} [options.oauth]
 *   - Enables the token endpoint; the detection endpoint then wants `accessToken`
 */
export async function startMockModelGateway({ token, oauth } = {}) {
  const calls = [];
  const tokenCalls = [];
  const marked = new Map(); // text -> key label
  let mode = 'ok';
  const required = oauth ? oauth.accessToken : token;

  const scheme = (verdict, result, reasons = []) => ({
    scheme: 'vllm',
    verdict,
    unclear_reasons: reasons,
    ...(result ? { strongest_result: result } : {}),
    evaluation: { correction: 'BONFERRONI', alpha: 0.001, min_scored_tokens: 50, tests: 2 },
    detectors: [{ name: 'gemma', type: 'IF_VLLM_DETECTOR', status: 'ANSWERED' }]
  });

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/oauth/token') {
        const form = new URLSearchParams(raw);
        tokenCalls.push(Object.fromEntries(form));
        const ok =
          oauth &&
          form.get('grant_type') === 'client_credentials' &&
          form.get('client_id') === oauth.clientId &&
          form.get('client_secret') === oauth.clientSecret;
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify(ok ? { access_token: oauth.accessToken, expires_in: 300 } : {})
        );
      }
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if ((required && req.headers.authorization !== `Bearer ${required}`) || mode === '401') {
        res.writeHead(401);
        return res.end('{}');
      }
      if (mode === 'unavailable') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no detector answered' }));
      }
      if (mode === 'badContract') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ verdict: 'DETECTED' }));
      }
      const text = body?.text ?? '';
      const words = text.split(/\s+/).filter(Boolean).length;
      const label = marked.get(text);
      const result = {
        detector: 'gemma',
        key_label: label || 'key-2026-11',
        algorithm: 'gumbel',
        parameters: { context_width: 4, deduplicate_contexts: true, prf: 'philox' },
        p_value: label ? 2e-9 : 0.6,
        num_scored_tokens: Math.round(words * 1.3)
      };
      let schemes;
      if (mode === 'short') schemes = [scheme('UNCLEAR', result, ['TOO_FEW_SCORED_TOKENS'])];
      else if (mode === 'detectorsDown')
        schemes = [scheme('UNCLEAR', null, ['DETECTOR_UNAVAILABLE'])];
      else schemes = [scheme(label ? 'DETECTED' : 'NOT_DETECTED', result)];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          detection: {
            verdict: schemes[0].verdict,
            alpha: 0.001,
            text_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
            detected_at: '2026-11-23T10:00:00Z',
            gateway_version: '6.9.0',
            schemes
          }
        })
      );
    });
  };

  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/v1/gateway/detections/text`,
    tokenUrl: `${base}/oauth/token`,
    calls,
    tokenCalls,
    markText(text, keyLabel) {
      marked.set(text, keyLabel);
    },
    setMode(next) {
      mode = next;
    },
    close: () => new Promise(resolve => server.close(resolve))
  };
}
