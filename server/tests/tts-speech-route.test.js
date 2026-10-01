/**
 * Route tests for `POST /api/voice/speech` (read aloud, issue #2642).
 *
 * The provider is replaced by a fake that emits PCM, so these cover what the
 * route owns: input validation, model resolution status codes, the streaming
 * response headers and body, chunked synthesis, and how an upstream failure
 * before the first audio byte is reported.
 *
 * Native ESM: uses `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const ttsModel = {
  id: 'voxtral-mini-tts',
  modelId: 'voxtral-mini-tts-latest',
  provider: 'mistral',
  modelType: 'tts',
  enabled: true
};

const state = {
  platform: {},
  models: [ttsModel],
  permissions: new Set(['*']),
  calls: [],
  failWith: null
};

class TtsUpstreamError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'TtsUpstreamError';
    this.status = status;
  }
}

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = { id: 'u1', permissions: { models: state.permissions } };
    next();
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    getModels: () => ({ data: state.models })
  }
}));

jest.unstable_mockModule('../tts/mistralTtsProvider.js', () => ({
  default: {
    id: 'mistral',
    sampleRate: 24000,
    resolveUpstream: model => ({ model: model.modelId, voice: 'v' }),
    synthesize: async ({ text, onAudio }) => {
      state.calls.push(text);
      if (state.failWith) throw state.failWith;
      await onAudio(Buffer.from([1, 0, 2, 0]));
      return { usage: null };
    }
  }
}));

const { default: registerVoiceRoutes } = await import('../routes/voiceRoutes.js');

const app = express();
app.use(express.json({ limit: '2mb' }));
registerVoiceRoutes(app);

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeEach(() => {
  state.platform = { speech: { tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' } } };
  state.models = [ttsModel];
  state.permissions = new Set(['*']);
  state.calls = [];
  state.failWith = null;
});

describe('POST /api/voice/speech', () => {
  test('streams 16-bit PCM with its format in the headers', async () => {
    const res = await request(app)
      .post('/api/voice/speech')
      .send({ text: 'Hello **world**.' })
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-audio-encoding']).toBe('pcm_s16le');
    expect(res.headers['x-audio-sample-rate']).toBe('24000');
    expect(res.headers['x-audio-channels']).toBe('1');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.body).toEqual(Buffer.from([1, 0, 2, 0]));
    // The provider gets speakable text, not Markdown.
    expect(state.calls).toEqual(['Hello world.']);
  });

  test('synthesizes a long message piece by piece into one stream', async () => {
    const text = 'A sentence that is long enough to matter here. '.repeat(80);
    const res = await request(app)
      .post('/api/voice/speech')
      .send({ text })
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(state.calls.length).toBeGreaterThan(1);
    expect(res.body.length).toBe(state.calls.length * 4);
  });

  test('400 without text', async () => {
    const res = await request(app).post('/api/voice/speech').send({ text: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid-text');
  });

  test('503 when read aloud is not configured', async () => {
    state.platform = { speech: { tts: { enabled: false, defaultModelId: 'voxtral-mini-tts' } } };
    const res = await request(app).post('/api/voice/speech').send({ text: 'Hi' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('not-configured');
  });

  test('403 when the user may not use the model', async () => {
    state.permissions = new Set(['some-chat-model']);
    const res = await request(app).post('/api/voice/speech').send({ text: 'Hi' });
    expect(res.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  test('404 for a model id that is not a TTS model', async () => {
    const res = await request(app).post('/api/voice/speech').send({ text: 'Hi', modelId: 'gpt-4' });
    expect(res.status).toBe(404);
  });

  test('422 when nothing is left to read', async () => {
    const res = await request(app)
      .post('/api/voice/speech')
      .send({ text: '```js\nconsole.log(1)\n```' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no-speakable-text');
  });

  test('502 with the provider message when it fails before any audio', async () => {
    state.failWith = new TtsUpstreamError('Mistral rejected the API key (HTTP 401)', {
      status: 401
    });
    const res = await request(app).post('/api/voice/speech').send({ text: 'Hi' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'Mistral rejected the API key (HTTP 401)',
      code: 'upstream-error'
    });
  });

  test('an unexpected error does not leak its message', async () => {
    state.failWith = new Error('ECONNREFUSED 10.0.0.5:443');
    const res = await request(app).post('/api/voice/speech').send({ text: 'Hi' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Text-to-speech failed');
  });
});
