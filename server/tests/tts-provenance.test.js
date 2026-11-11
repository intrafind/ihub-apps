// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Provenance of `POST /api/voice/speech` (#3328): the response names its
 * output in `X-AI-Content-Id`, one record holds the SHA-256 of exactly the PCM
 * streamed (never the audio), a WAV wrapper of that PCM verifies to the same
 * record, and an aborted stream or `recordTts: false` writes none.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { jest, describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { makePcm, makeWav } from './helpers/mediaFixtures.js';

const ttsModel = {
  id: 'google-tts',
  modelId: 'gemini-tts',
  provider: 'google',
  modelType: 'tts',
  enabled: true,
  contentMarking: { audio: { by: 'provider', scheme: 'synthid' } }
};

const state = { platform: {}, signals: [], streamUntilAbort: false, pieces: [] };

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = { id: 'u1', permissions: { models: new Set(['*']) } };
    next();
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform, getModels: () => ({ data: [ttsModel] }) }
}));
jest.unstable_mockModule('../tts/googleTtsProvider.js', () => ({
  default: {
    id: 'google',
    sampleRate: 24000,
    resolveUpstream: model => ({ model: model.modelId, voice: 'v' }),
    synthesize: async ({ signal, onAudio }) => {
      if (state.streamUntilAbort) {
        state.signals.push(signal);
        while (!signal.aborted) {
          await onAudio(Buffer.alloc(4800));
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      for (const piece of state.pieces) await onAudio(piece);
      return { usage: null };
    }
  }
}));

const { startTestStorage } = await import('./helpers/testStorage.js');
const { default: registerVoiceRoutes } = await import('../routes/voiceRoutes.js');
const { default: registerProvenanceRoutes } = await import('../routes/provenanceRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { getProvenanceStore } = await import('../services/provenance/ProvenanceStore.js');

let storage;
let app;
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const speak = () =>
  request(app).post('/api/voice/speech').send({ text: 'Hello there.' }).buffer(true).parse(binary);

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-tts-prov-' });
  app = express();
  app.use(express.json({ limit: '2mb' }));
  registerVoiceRoutes(app);
  registerProvenanceRoutes(app);
  app.use(errorHandler);
});
afterAll(async () => storage.stop());
beforeEach(() => {
  state.platform = {
    speech: { tts: { enabled: true, defaultModelId: 'google-tts' } },
    provenance: { verify: { access: 'public' } },
    rateLimit: {}
  };
  state.signals = [];
  state.streamUntilAbort = false;
  state.pieces = [];
});

describe('TTS provenance', () => {
  test('the response carries X-AI-Content-Id and the record hashes the streamed PCM', async () => {
    const pcm = makePcm(1, 24000, 5);
    // Split unevenly: the hash is incremental, over the bytes as written.
    state.pieces = [pcm.subarray(0, 1001), pcm.subarray(1001)];
    const res = await speak();
    expect(res.status).toBe(200);
    expect(res.headers['x-ai-generated']).toBe('true');
    const id = res.headers['x-ai-content-id'];
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.body.equals(pcm)).toBe(true);

    const records = await getProvenanceStore().findByHash(sha(pcm));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      output_id: id,
      kind: 'audio',
      model: { id: 'google-tts' },
      content_hash: { normalization: 'none', value: sha(pcm), bytes: pcm.length },
      container: { encoding: 'pcm_s16le', sample_rate: 24000, channels: 1 },
      provider_marking: {
        declared: 'synthid',
        c2pa: { present: false, status: 'unsupported_format' }
      }
    });
    expect(JSON.stringify(records)).not.toContain(pcm.toString('base64').slice(0, 40));
  });

  test('a WAV wrapper of the streamed PCM verifies to the same record', async () => {
    const pcm = makePcm(1, 24000, 7);
    state.pieces = [pcm];
    const res = await speak();
    const verified = await request(app)
      .post('/api/provenance/_verify')
      .attach('file', makeWav(pcm), 'speech.wav');
    expect(verified.status).toBe(200);
    expect(verified.body.found).toBe(true);
    expect(verified.body.records[0].output_id).toBe(res.headers['x-ai-content-id']);
    expect(verified.body.kind).toBe('audio');
  });

  test('recordTts: false writes no record, the header stays', async () => {
    state.platform.provenance.media = { recordTts: false };
    const pcm = makePcm(1, 24000, 9);
    state.pieces = [pcm];
    const res = await speak();
    expect(res.headers['x-ai-content-id']).toBeTruthy();
    expect(await getProvenanceStore().findByHash(sha(pcm))).toHaveLength(0);
  });

  test('an aborted stream writes no record', async () => {
    state.streamUntilAbort = true;
    const recordSpy = jest.spyOn(getProvenanceStore(), 'record');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let id;
    try {
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: server.address().port,
            path: '/api/voice/speech',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          },
          res => {
            id = res.headers['x-ai-content-id'];
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          }
        );
        req.on('error', error => {
          if (error.code !== 'ECONNRESET') reject(error);
        });
        req.end(JSON.stringify({ text: 'A sentence long enough to matter. '.repeat(40) }));
      });
      for (let i = 0; i < 100 && !state.signals[0]?.aborted; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    expect(id).toBeTruthy();
    expect(recordSpy).not.toHaveBeenCalled();
    recordSpy.mockRestore();
  });
});
