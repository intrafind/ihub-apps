/**
 * Voxtral transcription model — unit tests.
 *
 * Covers the first-class `modelType: 'transcription'` schema changes, the
 * transcription provider registry, and the model-aware upstream resolution used
 * by the realtime WebSocket proxy (permission enforcement, modelType/enabled
 * checks, and the platform.speech.realtime dictation fallback).
 */
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import vllmRealtimeProvider from '../transcription/vllmRealtimeProvider.js';
import {
  resolveTranscriptionUpstream,
  hasEnabledTranscriptionModel
} from '../websocket/realtimeTranscription.js';
import configCache from '../configCache.js';

const baseModel = {
  id: 'voxtral-mini-realtime',
  modelId: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
  name: { en: 'Voxtral' },
  description: { en: 'desc' },
  url: 'ws://localhost:8080/v1/realtime',
  provider: 'vllm-realtime',
  modelType: 'transcription',
  apiKey: '',
  enabled: true
};

describe('modelConfigSchema — modelType / transcription', () => {
  test('defaults modelType to "chat" for existing models', () => {
    const r = modelConfigSchema.safeParse({
      id: 'gpt',
      modelId: 'gpt',
      name: { en: 'g' },
      description: { en: 'd' },
      url: 'https://api.openai.com/v1',
      provider: 'openai'
    });
    expect(r.success).toBe(true);
    expect(r.data.modelType).toBe('chat');
  });

  test('accepts a transcription model with a ws:// URL', () => {
    const r = modelConfigSchema.safeParse(baseModel);
    expect(r.success).toBe(true);
    expect(r.data.modelType).toBe('transcription');
  });

  test('accepts a wss:// URL', () => {
    const r = modelConfigSchema.safeParse({
      ...baseModel,
      url: 'wss://voxtral.example/v1/realtime'
    });
    expect(r.success).toBe(true);
  });

  test('rejects provider "vllm-realtime" on a chat model', () => {
    const r = modelConfigSchema.safeParse({ ...baseModel, modelType: 'chat' });
    expect(r.success).toBe(false);
  });
});

describe('appConfigSchema — videoUpload / transcription blocks', () => {
  const app = {
    id: 'x',
    name: { en: 'X' },
    description: { en: 'd' },
    color: '#4F46E5',
    icon: 'chat',
    system: { en: 's' }
  };

  test('videoUpload block survives parsing (previously silently stripped)', () => {
    const r = appConfigSchema.safeParse({
      ...app,
      upload: { enabled: true, videoUpload: { enabled: true, extractAudio: true } }
    });
    expect(r.success).toBe(true);
    expect(r.data.upload.videoUpload.enabled).toBe(true);
    expect(r.data.upload.videoUpload.extractAudio).toBe(true);
    expect(r.data.upload.videoUpload.maxFileSizeMB).toBe(50);
  });

  test('transcription block survives parsing with defaults', () => {
    const r = appConfigSchema.safeParse({
      ...app,
      transcription: { enabled: true, modelId: 'voxtral-mini-realtime' }
    });
    expect(r.success).toBe(true);
    expect(r.data.transcription.enabled).toBe(true);
    expect(r.data.transcription.modelId).toBe('voxtral-mini-realtime');
    expect(r.data.transcription.streaming).toBe(true);
    expect(r.data.transcription.maxDurationSeconds).toBe(900);
    expect(r.data.transcription.inputs).toEqual({ upload: true, record: true, video: true });
  });
});

describe('transcription provider registry', () => {
  test('resolves the vllm-realtime provider', () => {
    expect(getTranscriptionProvider('vllm-realtime')).toBe(vllmRealtimeProvider);
  });

  test('returns null for an unknown provider', () => {
    expect(getTranscriptionProvider('nope')).toBeNull();
  });

  test('resolveUpstream returns the modelId as the upstream model and empty key when unset', async () => {
    const up = await vllmRealtimeProvider.resolveUpstream(baseModel);
    expect(up.url).toBe('ws://localhost:8080/v1/realtime');
    expect(up.model).toBe('mistralai/Voxtral-Mini-4B-Realtime-2602');
    expect(up.apiKey).toBe('');
  });

  test('resolveUpstream expands ${ENV} placeholders in the URL', async () => {
    process.env.TEST_VOXTRAL_URL = 'ws://envhost:9000/v1/realtime';
    const up = await vllmRealtimeProvider.resolveUpstream({
      ...baseModel,
      url: '${TEST_VOXTRAL_URL}'
    });
    expect(up.url).toBe('ws://envhost:9000/v1/realtime');
    delete process.env.TEST_VOXTRAL_URL;
  });

  test('resolveUpstream passes through a plaintext API key', async () => {
    const up = await vllmRealtimeProvider.resolveUpstream({ ...baseModel, apiKey: 'plain-secret' });
    expect(up.apiKey).toBe('plain-secret');
  });
});

describe('resolveTranscriptionUpstream / hasEnabledTranscriptionModel', () => {
  const chatModel = {
    id: 'gpt',
    modelId: 'gpt',
    name: { en: 'g' },
    description: { en: 'd' },
    url: 'https://api.openai.com/v1',
    provider: 'openai',
    modelType: 'chat',
    enabled: true
  };
  const disabledModel = { ...baseModel, id: 'voxtral-disabled', enabled: false };

  beforeEach(() => {
    configCache.setCacheEntry('config/models.json', [baseModel, chatModel, disabledModel]);
    configCache.setCacheEntry('config/platform.json', {
      speech: {
        realtime: {
          enabled: true,
          url: 'ws://platform-dictation:8080/v1/realtime',
          model: 'platform-model',
          apiKey: ''
        }
      }
    });
  });

  afterAll(() => {
    for (const key of ['config/models.json', 'config/platform.json']) {
      const timer = configCache.refreshTimers?.get(key);
      if (timer) clearTimeout(timer);
      configCache.refreshTimers?.delete(key);
    }
  });

  const permitted = { permissions: { models: new Set(['voxtral-mini-realtime']) } };
  const wildcard = { permissions: { models: new Set(['*']) } };
  const denied = { permissions: { models: new Set(['something-else']) } };

  test('hasEnabledTranscriptionModel is true when an enabled transcription model exists', () => {
    expect(hasEnabledTranscriptionModel()).toBe(true);
  });

  test('resolves an enabled, permitted transcription model', async () => {
    const r = await resolveTranscriptionUpstream({
      modelId: 'voxtral-mini-realtime',
      user: permitted
    });
    expect(r.ok).toBe(true);
    expect(r.upstream.url).toBe('ws://localhost:8080/v1/realtime');
    expect(r.upstream.model).toBe('mistralai/Voxtral-Mini-4B-Realtime-2602');
  });

  test('wildcard permission is allowed', async () => {
    const r = await resolveTranscriptionUpstream({
      modelId: 'voxtral-mini-realtime',
      user: wildcard
    });
    expect(r.ok).toBe(true);
  });

  test('denies a user without permission for the model', async () => {
    const r = await resolveTranscriptionUpstream({
      modelId: 'voxtral-mini-realtime',
      user: denied
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not permitted/i);
  });

  test('rejects an unknown model', async () => {
    const r = await resolveTranscriptionUpstream({ modelId: 'does-not-exist', user: wildcard });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown/i);
  });

  test('rejects a chat model routed as transcription', async () => {
    const r = await resolveTranscriptionUpstream({ modelId: 'gpt', user: wildcard });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a transcription model/i);
  });

  test('rejects a disabled transcription model', async () => {
    const r = await resolveTranscriptionUpstream({ modelId: 'voxtral-disabled', user: wildcard });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/i);
  });

  test('falls back to the platform dictation backend when no modelId is given', async () => {
    const r = await resolveTranscriptionUpstream({ user: wildcard });
    expect(r.ok).toBe(true);
    expect(r.upstream.url).toBe('ws://platform-dictation:8080/v1/realtime');
    expect(r.upstream.model).toBe('platform-model');
  });

  test('returns an error when neither a modelId nor platform realtime is configured', async () => {
    configCache.setCacheEntry('config/platform.json', { speech: { realtime: { enabled: false } } });
    const r = await resolveTranscriptionUpstream({ user: wildcard });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });
});
