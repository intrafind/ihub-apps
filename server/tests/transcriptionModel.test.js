/**
 * Voxtral transcription model — unit tests.
 *
 * Covers the first-class `modelType: 'transcription'` schema changes, the
 * transcription provider registry, and the model-aware upstream resolution used
 * by the realtime WebSocket proxy (permission enforcement, modelType/enabled
 * checks, and that every session — dictation included — must name a model).
 */
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import vllmRealtimeProvider, {
  extractTranscriptText
} from '../transcription/vllmRealtimeProvider.js';
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

  // The browser reads only the index and the audio of an MP4/MOV, so a video may
  // be as large as 50 GB; the other types keep their bounds
  describe('upload size bounds', () => {
    const withUpload = upload =>
      appConfigSchema.safeParse({ ...app, upload: { enabled: true, ...upload } });

    test('a video can be 50 GB (51200 MB), not more', () => {
      expect(withUpload({ videoUpload: { maxFileSizeMB: 51200 } }).success).toBe(true);
      expect(withUpload({ videoUpload: { maxFileSizeMB: 51201 } }).success).toBe(false);
    });

    test('audio, images and files keep their bounds', () => {
      expect(withUpload({ audioUpload: { maxFileSizeMB: 2000 } }).success).toBe(true);
      expect(withUpload({ audioUpload: { maxFileSizeMB: 2001 } }).success).toBe(false);
      expect(withUpload({ imageUpload: { maxFileSizeMB: 100 } }).success).toBe(true);
      expect(withUpload({ imageUpload: { maxFileSizeMB: 101 } }).success).toBe(false);
      expect(withUpload({ fileUpload: { maxFileSizeMB: 100 } }).success).toBe(true);
      expect(withUpload({ fileUpload: { maxFileSizeMB: 101 } }).success).toBe(false);
    });
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
    // An hour: a 30-minute video transcribes out of the box
    expect(r.data.transcription.maxDurationSeconds).toBe(3600);
    expect(r.data.transcription.inputs).toEqual({ upload: true, record: true, video: true });
  });

  test('an app that sets its own transcription length keeps it, up to two hours', () => {
    const parse = maxDurationSeconds =>
      appConfigSchema.safeParse({
        ...app,
        transcription: { enabled: true, modelId: 'm', maxDurationSeconds }
      });
    expect(parse(900).data.transcription.maxDurationSeconds).toBe(900);
    expect(parse(7200).success).toBe(true);
    expect(parse(7201).success).toBe(false);
  });
});

describe('extractTranscriptText', () => {
  test('reads the documented delta/done fields', () => {
    expect(extractTranscriptText({ type: 'transcription.delta', delta: 'he' }, ['delta'])).toBe(
      'he'
    );
    expect(extractTranscriptText({ type: 'transcription.done', text: 'hello' }, ['text'])).toBe(
      'hello'
    );
  });

  test('tolerates field-name variants (text on a delta frame)', () => {
    expect(
      extractTranscriptText({ type: 'transcription.delta', text: 'hi' }, ['delta', 'text'])
    ).toBe('hi');
    expect(extractTranscriptText({ transcript: 'yo' }, ['delta', 'text', 'transcript'])).toBe('yo');
  });

  test('reads a nested .text field', () => {
    expect(extractTranscriptText({ delta: { text: 'nested' } }, ['delta'])).toBe('nested');
  });

  test('returns empty string when no text field is present', () => {
    expect(extractTranscriptText({ type: 'session.created' })).toBe('');
    expect(extractTranscriptText({})).toBe('');
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
    configCache.setCacheEntry('config/platform.json', { speech: {} });
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

  test('fails closed when permissions could not be computed (no permissions object)', async () => {
    const r = await resolveTranscriptionUpstream({
      modelId: 'voxtral-mini-realtime',
      user: { id: 'u', name: 'u' } // enhanceUserWithPermissions threw → no permissions
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

  test('without a modelId there is nothing to resolve: dictation names its model too', async () => {
    const r = await resolveTranscriptionUpstream({ user: wildcard });
    expect(r).toEqual({ ok: false, code: 'no-model', error: 'No transcription model selected' });
  });
});
