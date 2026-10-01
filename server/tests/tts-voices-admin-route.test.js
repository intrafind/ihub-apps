/**
 * Route tests for the text-to-speech voices of a model (Admin → Models):
 * `GET|POST /api/admin/models/:modelId/tts/voices` and
 * `DELETE /api/admin/models/:modelId/tts/voices/:voiceId`.
 *
 * The provider is a fake; these cover what the routes own: which models have
 * voices, input validation of a new voice, and how provider failures are
 * reported.
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
  enabled: false
};
const chatModel = { id: 'mistral-small', modelId: 'mistral-small-latest', provider: 'mistral' };

const state = { calls: [], audits: [], failWith: null };

class TtsUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TtsUpstreamError';
  }
}

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async entry => {
    state.audits.push(entry);
  }
}));

jest.unstable_mockModule('../tts/mistralTtsProvider.js', () => ({
  default: {
    id: 'mistral',
    sampleRate: 24000,
    resolveUpstream: () => ({ apiKey: 'k' }),
    synthesize: async () => ({ usage: null }),
    listVoices: async () => {
      if (state.failWith) throw state.failWith;
      return [
        { id: 'v1', slug: 'en_paul_neutral', name: 'Paul', languages: ['en_us'], type: 'preset' }
      ];
    },
    createVoice: async (cfg, voice) => {
      state.calls.push(voice);
      if (state.failWith) throw state.failWith;
      return { id: 'new-id', name: voice.name, languages: voice.languages, type: 'custom' };
    },
    deleteVoice: async (cfg, id) => {
      state.calls.push({ deleted: id });
    }
  }
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: configCache } = await import('../configCache.js');

beforeAll(() => {
  configCache.setCacheEntry('config/models.json', [ttsModel, chatModel]);
});

afterAll(() => {
  const timer = configCache.refreshTimers?.get('config/models.json');
  if (timer) clearTimeout(timer);
  configCache.refreshTimers?.delete('config/models.json');
});

const app = express();
app.use(express.json({ limit: '20mb' }));
registerAdminModelsRoutes(app);

const base = '/api/admin/models/voxtral-mini-tts/tts/voices';
const sample = Buffer.from('RIFF....WAVEfmt ').toString('base64');

beforeEach(() => {
  state.calls = [];
  state.audits = [];
  state.failWith = null;
});

describe('text-to-speech voices of a model', () => {
  test('lists the voices of a TTS model, even a disabled one', async () => {
    const res = await request(app).get(base);
    expect(res.status).toBe(200);
    expect(res.body.voices[0]).toMatchObject({ slug: 'en_paul_neutral' });
  });

  test('a chat model has no voices', async () => {
    const res = await request(app).get('/api/admin/models/mistral-small/tts/voices');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not-tts-model');
  });

  test('an unknown model is 404', async () => {
    const res = await request(app).get('/api/admin/models/nope/tts/voices');
    expect(res.status).toBe(404);
  });

  test('creates a voice from a sample and records it in the audit log', async () => {
    const res = await request(app)
      .post(base)
      .send({
        name: '  Anna  ',
        audio: sample,
        filename: '../anna recording.wav',
        languages: ['de', 'xx', 'de'],
        gender: 'robot'
      });
    expect(res.status).toBe(200);
    expect(res.body.voice).toMatchObject({ id: 'new-id', name: 'Anna' });
    const [call] = state.calls;
    expect(call.name).toBe('Anna');
    expect(call.audio.equals(Buffer.from(sample, 'base64'))).toBe(true);
    // Path and spaces are gone; only known languages, once; no made-up gender.
    expect(call.filename).toBe('.._anna_recording.wav');
    expect(call.languages).toEqual(['de']);
    expect(call.gender).toBeUndefined();
    expect(state.audits[0]).toMatchObject({ action: 'create', resource: 'tts-voice' });
  });

  test.each([
    ['no name', { audio: sample }, 'invalid-name'],
    ['no audio', { name: 'Anna' }, 'invalid-audio'],
    [
      'an unsupported file type',
      { name: 'Anna', audio: sample, filename: 'anna.exe' },
      'invalid-audio'
    ]
  ])('rejects a voice with %s', async (_label, body, code) => {
    const res = await request(app).post(base).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(state.calls).toHaveLength(0);
  });

  test('rejects a sample over 10 MB', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    const res = await request(app).post(base).send({ name: 'Anna', audio: big });
    expect(res.status).toBe(413);
  });

  test('reports the provider message when creating fails', async () => {
    state.failWith = new TtsUpstreamError('Mistral TTS failed (HTTP 422): sample too short');
    const res = await request(app).post(base).send({ name: 'Anna', audio: sample });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Mistral TTS failed (HTTP 422): sample too short');
  });

  test('does not leak an unexpected error', async () => {
    state.failWith = new Error('ECONNREFUSED 10.0.0.5:443');
    const res = await request(app).get(base);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Could not list voices');
  });

  test('deletes a voice by id, and refuses a malformed id', async () => {
    const ok = await request(app).delete(`${base}/01a0f7a6-649d-732a`);
    expect(ok.status).toBe(200);
    expect(state.calls).toEqual([{ deleted: '01a0f7a6-649d-732a' }]);
    const bad = await request(app).delete(`${base}/a%2Fb`);
    expect(bad.status).toBe(400);
  });
});
