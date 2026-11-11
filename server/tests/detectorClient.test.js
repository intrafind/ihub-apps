// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The watermark detector client (#3331) against the mock detector: request
 * shape, failure modes, redirects, and that nothing leaves iHub without a token.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import configCache from '../configCache.js';
import { callDetector } from '../services/provenance/watermark/DetectorClient.js';
import { startMockDetector } from './helpers/mockWatermarkDetector.js';

const TOKEN = 'detector-token-123456';
let mock;

function setCredentials(token = TOKEN) {
  configCache.setCacheEntry('config/credentials.json', {
    credentials: token ? { 'wm-detector': { id: 'wm-detector', type: 'bearer', token } } : {}
  });
}

const call = (overrides = {}) =>
  callDetector({
    url: mock.url,
    credentialRef: 'wm-detector',
    text: 'one two three four five six seven eight nine ten',
    keys: [
      { keyId: 'wm-2026-2', key: 222222222 },
      { keyId: 'wm-2026-1', key: 111111111 }
    ],
    tokenizer: 'org/tok',
    algorithm: 'gumbel',
    prf: 'philox',
    contextWidth: 4,
    timeoutMs: 400,
    ...overrides
  });

beforeAll(async () => {
  mock = await startMockDetector({ token: TOKEN });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.calls.length = 0;
  mock.setMode('ok');
  setCredentials();
});
afterEach(() => configCache.setCacheEntry('config/platform.json', {}));

describe('callDetector', () => {
  test('sends the documented request: bearer, active key first, text as given', async () => {
    mock.markText('one two three four five six seven eight nine ten', 111111111);
    const answer = await call();
    expect(mock.calls).toHaveLength(1);
    const [sent] = mock.calls;
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.body).toEqual({
      text: 'one two three four five six seven eight nine ten',
      tokenizer: 'org/tok',
      algorithm: 'gumbel',
      prf: 'philox',
      context_width: 4,
      keys: [
        { key_id: 'wm-2026-2', key: 222222222 },
        { key_id: 'wm-2026-1', key: 111111111 }
      ]
    });
    expect(answer.numScoredTokens).toBe(13);
    expect(answer.results).toEqual([
      { keyId: 'wm-2026-2', pValue: 0.47, score: 0 },
      { keyId: 'wm-2026-1', pValue: 1e-9, score: 0 }
    ]);
  });

  test('refuses before any network call without a credential', async () => {
    setCredentials(null);
    await expect(call()).rejects.toMatchObject({ code: 'WATERMARK_DETECTOR_NOT_CONFIGURED' });
    await expect(call({ credentialRef: undefined })).rejects.toMatchObject({
      code: 'WATERMARK_DETECTOR_NOT_CONFIGURED'
    });
    expect(mock.calls).toHaveLength(0);
  });

  test.each([
    ['401', 'unauthorized'],
    ['500', 'http_error'],
    ['badJson', 'bad_response'],
    ['oversize', 'too_large'],
    ['slow', 'timeout']
  ])('mode %s maps to %s', async (mode, reason) => {
    mock.setMode(mode);
    await expect(call()).rejects.toMatchObject({
      code: 'WATERMARK_DETECTOR_UNREACHABLE',
      details: { reason }
    });
  });

  test('a redirect is refused and the second host is never hit', async () => {
    let hit = false;
    const other = http.createServer((req, res) => {
      hit = true;
      res.end('{}');
    });
    await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
    mock.setMode('redirect', { redirectTo: `http://127.0.0.1:${other.address().port}/steal` });
    await expect(call()).rejects.toMatchObject({
      code: 'WATERMARK_DETECTOR_UNREACHABLE',
      details: { reason: 'redirect' }
    });
    await new Promise(resolve => other.close(resolve));
    expect(hit).toBe(false);
  });

  test('plain http to a public address is refused before any call', async () => {
    await expect(
      call({ url: 'http://detector.example/detect', resolve: async () => ['93.184.216.34'] })
    ).rejects.toMatchObject({ details: { reason: 'url_refused' } });
  });

  test('a response that does not match the contract is rejected', async () => {
    const bad = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ num_scored_tokens: 'many', results: [] }));
    });
    await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve));
    await expect(
      call({ url: `http://127.0.0.1:${bad.address().port}/detect` })
    ).rejects.toMatchObject({ details: { reason: 'bad_response' } });
    await new Promise(resolve => bad.close(resolve));
  });
});
