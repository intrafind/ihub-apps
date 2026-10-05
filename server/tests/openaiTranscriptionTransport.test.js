/**
 * The OpenAI-compatible transcription provider uploads through the platform's
 * `httpFetch`, so its proxy, TLS settings and DNS guard apply — as they do to
 * the model import that found the endpoint. Native `fetch` would bypass them.
 *
 * Native ESM: uses `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';

const calls = [];
jest.unstable_mockModule('../utils/httpConfig.js', () => ({
  httpFetch: async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ text: 'Hallo' }),
      text: async () => ''
    };
  }
}));

const { transcribe } = await import('../transcription/openaiTranscribeProvider.js');

test('the upload goes through httpFetch as a multipart Buffer', async () => {
  const url = 'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions';
  const { text } = await transcribe({
    cfg: { url, apiKey: 'k', model: 'whisper-large-v3-turbo', options: {} },
    pcm: Buffer.alloc(320)
  });

  expect(text).toBe('Hallo');
  expect(calls).toHaveLength(1);
  const [{ url: calledUrl, options }] = calls;
  expect(calledUrl).toBe(url);
  expect(options.method).toBe('POST');
  expect(Buffer.isBuffer(options.body)).toBe(true);
  const boundary = options.headers['Content-Type'].match(/boundary=(.+)$/)[1];
  expect(options.body.toString('latin1')).toContain(`--${boundary}--`);
  expect(options.headers.Authorization).toBe('Bearer k');
});
