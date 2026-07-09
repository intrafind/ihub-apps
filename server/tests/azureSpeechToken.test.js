/**
 * Azure Speech token broker — unit tests.
 *
 * The server holds the Azure subscription key and exchanges it for a short-lived
 * authorization token the browser SDK uses, so the key never reaches the client.
 * These tests lock in the STS request shape and the input guards (including the
 * region-format guard that prevents an attacker-influenced region from
 * redirecting the token request — SSRF).
 */
import { issueAzureSpeechToken } from '../services/azureSpeechToken.js';

const okFetch = token => async (url, opts) => ({
  ok: true,
  status: 200,
  text: async () => token,
  _url: url,
  _opts: opts
});

describe('issueAzureSpeechToken', () => {
  test('rejects when the subscription key is missing', async () => {
    const result = await issueAzureSpeechToken({ region: 'westeurope' }, okFetch('t'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/key/i);
  });

  test('rejects when the region is missing', async () => {
    const result = await issueAzureSpeechToken({ subscriptionKey: 'sk' }, okFetch('t'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/region/i);
  });

  test('rejects a malformed region (SSRF guard)', async () => {
    const result = await issueAzureSpeechToken(
      { subscriptionKey: 'sk', region: 'evil.example.com/redirect' },
      okFetch('t')
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/region/i);
  });

  test('POSTs to the regional STS endpoint with the subscription-key header', async () => {
    let captured;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, text: async () => 'the-token' };
    };
    const result = await issueAzureSpeechToken(
      { subscriptionKey: 'sk-123', region: 'westeurope' },
      fetchImpl
    );
    expect(result).toEqual({ ok: true, token: 'the-token', region: 'westeurope' });
    expect(captured.url).toBe('https://westeurope.api.cognitive.microsoft.com/sts/v1.0/issueToken');
    expect(captured.opts.method).toBe('POST');
    expect(captured.opts.headers['Ocp-Apim-Subscription-Key']).toBe('sk-123');
  });

  test('reports a non-OK STS response with its status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const result = await issueAzureSpeechToken(
      { subscriptionKey: 'sk', region: 'westeurope' },
      fetchImpl
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  test('reports a network failure without throwing', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await issueAzureSpeechToken(
      { subscriptionKey: 'sk', region: 'westeurope' },
      fetchImpl
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
