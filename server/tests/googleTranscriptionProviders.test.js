/**
 * Google Gemini transcription providers — unit tests.
 *
 * Covers the two new transcription providers added for issue #2282: the Live
 * API streaming provider (`google-live`) and the batch provider
 * (`google-transcribe`). Tests exercise the pure parts of each — frame
 * building, frame interpretation, credential resolution, the WAV wrapper and
 * the interactions response parser — plus the invariant that matters most:
 * an API key must never leak into the URL the bridge logs.
 */
import {
  modelConfigSchema,
  TRANSCRIPTION_ONLY_PROVIDERS
} from '../validators/modelConfigSchema.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import googleLive, {
  DEFAULT_LIVE_URL,
  INPUT_AUDIO_MIME_TYPE,
  formatUpstreamError
} from '../transcription/googleLiveProvider.js';
import googleTranscribe, {
  buildTranscriptionConfig,
  extractTranscript,
  isPendingStatus,
  normalizeApiBase,
  pcm16ToWav
} from '../transcription/googleTranscribeProvider.js';
import vllmRealtime from '../transcription/vllmRealtimeProvider.js';
import { resolveApiKey } from '../transcription/credentials.js';

const liveModel = {
  id: 'gemini-3.5-transcribe-live',
  modelId: 'gemini-3.5-transcribe-live',
  name: { en: 'live' },
  description: { en: 'd' },
  url: DEFAULT_LIVE_URL,
  provider: 'google-live',
  modelType: 'transcription',
  enabled: true
};

const batchModel = {
  id: 'gemini-3.5-transcribe',
  modelId: 'gemini-3.5-transcribe',
  name: { en: 'batch' },
  description: { en: 'd' },
  url: 'https://generativelanguage.googleapis.com',
  provider: 'google-transcribe',
  modelType: 'transcription',
  enabled: true
};

describe('modelConfigSchema — Google transcription providers', () => {
  test('accepts both new providers on a transcription model', () => {
    expect(modelConfigSchema.safeParse(liveModel).success).toBe(true);
    expect(modelConfigSchema.safeParse(batchModel).success).toBe(true);
  });

  test('rejects a transcription-only provider on a chat model', () => {
    for (const provider of TRANSCRIPTION_ONLY_PROVIDERS) {
      const result = modelConfigSchema.safeParse({
        ...liveModel,
        provider,
        modelType: 'chat'
      });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toContain('only valid for modelType');
    }
  });

  test('accepts a wss:// url', () => {
    expect(modelConfigSchema.safeParse({ ...liveModel, url: 'wss://example/ws' }).success).toBe(
      true
    );
  });

  test('supportsTemperature is optional and defaults to unset', () => {
    const chat = {
      id: 'c',
      modelId: 'c',
      name: { en: 'c' },
      description: { en: 'd' },
      url: 'https://x',
      provider: 'anthropic'
    };
    expect(modelConfigSchema.parse(chat).supportsTemperature).toBeUndefined();
    expect(
      modelConfigSchema.parse({ ...chat, supportsTemperature: false }).supportsTemperature
    ).toBe(false);
  });
});

describe('transcription provider registry', () => {
  test('resolves every transcription-only provider', () => {
    expect(getTranscriptionProvider('google-live')).toBe(googleLive);
    expect(getTranscriptionProvider('google-transcribe')).toBe(googleTranscribe);
    expect(getTranscriptionProvider('vllm-realtime')).toBe(vllmRealtime);
    expect(getTranscriptionProvider('nope')).toBeNull();
  });

  test('every registered provider declares a mode and the calls that mode needs', () => {
    for (const id of TRANSCRIPTION_ONLY_PROVIDERS) {
      const provider = getTranscriptionProvider(id);
      expect(provider).not.toBeNull();
      expect(['stream', 'batch']).toContain(provider.mode);
      expect(typeof provider.resolveUpstream).toBe('function');
      if (provider.mode === 'stream') {
        for (const fn of [
          'connect',
          'openFrames',
          'readyFrames',
          'audioFrame',
          'stopFrames',
          'interpret'
        ]) {
          expect(typeof provider[fn]).toBe('function');
        }
        expect(typeof provider.readyFallbackMs).toBe('number');
      } else {
        expect(typeof provider.transcribe).toBe('function');
      }
    }
  });
});

describe('googleLiveProvider — connection', () => {
  test('resolveUpstream keeps the API key out of the url', () => {
    const cfg = googleLive.resolveUpstream({ ...liveModel, apiKey: 'secret-key' });
    expect(cfg.url).toBe(DEFAULT_LIVE_URL);
    expect(cfg.url).not.toContain('secret-key');
    expect(cfg.apiKey).toBe('secret-key');
    expect(cfg.model).toBe('gemini-3.5-transcribe-live');
  });

  test('falls back to the documented Live API endpoint when no url is set', () => {
    expect(googleLive.resolveUpstream({ ...liveModel, url: undefined }).url).toBe(DEFAULT_LIVE_URL);
  });

  test('connect() adds the key as a query parameter', () => {
    const { url, options } = googleLive.connect({ url: DEFAULT_LIVE_URL, apiKey: 'k123' });
    expect(new URL(url).searchParams.get('key')).toBe('k123');
    // The Live API authenticates via the query string, not a bearer header.
    expect(options.headers).toBeUndefined();
  });

  test('connect() omits the key when none is configured', () => {
    const { url } = googleLive.connect({ url: DEFAULT_LIVE_URL, apiKey: '' });
    expect(url).not.toContain('key=');
  });

  test('languageCodes come from model.config', () => {
    const cfg = googleLive.resolveUpstream({
      ...liveModel,
      config: { languageCodes: ['de-DE', '', 42, 'en-US'] }
    });
    expect(cfg.languageCodes).toEqual(['de-DE', 'en-US']);
  });
});

describe('googleLiveProvider — wire protocol', () => {
  const cfg = { model: 'gemini-3.5-transcribe-live', languageCodes: [] };

  test('setup is the first frame on the socket', () => {
    const frames = googleLive.openFrames(cfg);
    expect(frames).toHaveLength(1);
    expect(frames[0].setup.model).toBe('models/gemini-3.5-transcribe-live');
    expect(frames[0].setup.generationConfig.responseModalities).toEqual(['TEXT']);
    expect(frames[0].setup.inputAudioTranscription).toEqual({ languageCodes: [] });
    // Nothing further once the session is ready.
    expect(googleLive.readyFrames(cfg)).toEqual([]);
  });

  test('an already-prefixed model id is not double-prefixed', () => {
    const frames = googleLive.openFrames({ model: 'models/gemini-3.5-transcribe-live' });
    expect(frames[0].setup.model).toBe('models/gemini-3.5-transcribe-live');
  });

  test('audio frames carry base64 PCM at the required mime type', () => {
    expect(googleLive.audioFrame('QUJD')).toEqual({
      realtimeInput: { audio: { data: 'QUJD', mimeType: INPUT_AUDIO_MIME_TYPE } }
    });
    expect(INPUT_AUDIO_MIME_TYPE).toBe('audio/pcm;rate=16000');
  });

  test('stop sends audioStreamEnd so the tail utterance is finalized', () => {
    expect(googleLive.stopFrames()).toEqual([{ realtimeInput: { audioStreamEnd: true } }]);
  });

  test('interpret maps setupComplete to session-ready', () => {
    expect(googleLive.interpret({ setupComplete: {} })).toEqual({ kind: 'session-ready' });
  });

  test('interpret maps interim transcription to a delta and final to a segment', () => {
    expect(
      googleLive.interpret({ serverContent: { interimInputTranscription: { text: 'hel' } } })
    ).toEqual({ kind: 'delta', text: 'hel' });
    expect(
      googleLive.interpret({ serverContent: { inputTranscription: { text: 'hello' } } })
    ).toEqual({ kind: 'final', text: 'hello' });
  });

  test('interpret prefers the interim hypothesis when a frame carries both', () => {
    const event = googleLive.interpret({
      serverContent: {
        interimInputTranscription: { text: 'partial' },
        inputTranscription: { text: 'final' }
      }
    });
    expect(event).toEqual({ kind: 'delta', text: 'partial' });
  });

  test('interpret maps an error payload to a readable message', () => {
    expect(
      googleLive.interpret({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } })
    ).toEqual({ kind: 'error', error: 'INVALID_ARGUMENT: bad' });
    expect(formatUpstreamError('boom')).toBe('boom');
    expect(formatUpstreamError(null)).toBe('unknown');
    expect(formatUpstreamError({})).toBe('unknown');
  });

  test('interpret ignores control frames that need no client action', () => {
    for (const frame of [
      {},
      { serverContent: { turnComplete: true } },
      { serverContent: {} },
      { goAway: { timeLeft: '10s' } },
      { usageMetadata: { totalTokenCount: 1 } }
    ]) {
      expect(googleLive.interpret(frame)).toEqual({ kind: 'ignore' });
    }
  });

  test('waits for setupComplete rather than a fallback timer', () => {
    // Sending audio before setupComplete is a protocol error, so there must be
    // no window in which the bridge assumes readiness on its own.
    expect(googleLive.readyFallbackMs).toBe(0);
  });
});

describe('googleTranscribeProvider — request building', () => {
  test('normalizeApiBase tolerates trailing slashes and a /v1beta suffix', () => {
    expect(normalizeApiBase('https://host/')).toBe('https://host');
    expect(normalizeApiBase('https://host/v1beta')).toBe('https://host');
    expect(normalizeApiBase('https://host/v1beta/')).toBe('https://host');
    expect(normalizeApiBase('')).toBe('https://generativelanguage.googleapis.com');
    expect(normalizeApiBase(undefined)).toBe('https://generativelanguage.googleapis.com');
  });

  test('defaults to smart mode and omits empty optional fields', () => {
    expect(buildTranscriptionConfig()).toEqual({ mode: 'smart' });
    expect(buildTranscriptionConfig({ languageCodes: [], customVocabulary: [] })).toEqual({
      mode: 'smart'
    });
  });

  test('verbatim mode uses the object form Gemini expects', () => {
    expect(buildTranscriptionConfig({ mode: 'verbatim' }).mode).toEqual({ type: 'verbatim' });
  });

  test('passes language codes and custom vocabulary through, capped at 1000 phrases', () => {
    const cfg = buildTranscriptionConfig({
      languageCodes: ['de-DE', ''],
      customVocabulary: Array.from({ length: 1200 }, (_, i) => `term-${i}`)
    });
    expect(cfg.language_codes).toEqual(['de-DE']);
    expect(cfg.custom_vocabulary).toHaveLength(1000);
  });

  test('resolveUpstream normalizes the base url and reads model.config', () => {
    const cfg = googleTranscribe.resolveUpstream({
      ...batchModel,
      url: 'https://generativelanguage.googleapis.com/v1beta',
      config: { mode: 'verbatim' }
    });
    expect(cfg.url).toBe('https://generativelanguage.googleapis.com');
    expect(cfg.model).toBe('gemini-3.5-transcribe');
    expect(cfg.options).toEqual({ mode: 'verbatim' });
  });
});

describe('googleTranscribeProvider — PCM to WAV', () => {
  test('writes a valid 44-byte RIFF header for 16 kHz mono PCM16', () => {
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f]); // two samples
    const wav = pcm16ToWav(pcm);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000); // byte rate = rate * blockAlign
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  test('honours a different sample rate', () => {
    const wav = pcm16ToWav(Buffer.alloc(4), { sampleRate: 48000 });
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt32LE(28)).toBe(96000);
  });
});

describe('googleTranscribeProvider — response parsing', () => {
  test('collects text blocks across every step', () => {
    const body = {
      id: 'interactions/abc',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'Hello there.' }] },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'Second part.', annotations: [{ type: 'word_info' }] },
            { type: 'other', text: 'ignored' }
          ]
        }
      ]
    };
    expect(extractTranscript(body)).toBe('Hello there.\nSecond part.');
  });

  test('returns an empty string for a response with no transcript', () => {
    expect(extractTranscript({})).toBe('');
    expect(extractTranscript({ steps: [] })).toBe('');
    expect(extractTranscript({ steps: [{ content: [] }] })).toBe('');
    expect(extractTranscript({ steps: [{ content: [{ type: 'text', text: '' }] }] })).toBe('');
  });

  test('recognizes the statuses that still need polling', () => {
    expect(isPendingStatus('in_progress')).toBe(true);
    expect(isPendingStatus('queued')).toBe(true);
    expect(isPendingStatus('pending')).toBe(true);
    expect(isPendingStatus('completed')).toBe(false);
    expect(isPendingStatus('failed')).toBe(false);
    expect(isPendingStatus(undefined)).toBe(false);
  });

  test('an empty buffer short-circuits without touching the network', async () => {
    await expect(
      googleTranscribe.transcribe({
        cfg: { apiKey: 'k', url: '', model: 'm' },
        pcm: Buffer.alloc(0)
      })
    ).resolves.toEqual({ text: '' });
  });

  test('a missing API key fails with an actionable message', async () => {
    await expect(
      googleTranscribe.transcribe({
        cfg: { apiKey: '', url: '', model: 'm' },
        pcm: Buffer.alloc(4)
      })
    ).rejects.toThrow(/GOOGLE_API_KEY/);
  });
});

describe('transcription credential resolution', () => {
  test('a plaintext model key wins over everything else', () => {
    expect(resolveApiKey({ id: 'm', apiKey: 'on-the-model' }, { envVars: ['NOPE'] })).toBe(
      'on-the-model'
    );
  });

  test('${ENV} placeholders on the model key are expanded', () => {
    process.env.IHUB_TEST_TRANSCRIBE_KEY = 'from-placeholder';
    try {
      expect(resolveApiKey({ id: 'm', apiKey: '${IHUB_TEST_TRANSCRIBE_KEY}' })).toBe(
        'from-placeholder'
      );
    } finally {
      delete process.env.IHUB_TEST_TRANSCRIBE_KEY;
    }
  });

  test('falls back to the provider-wide environment variable', () => {
    const before = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'google-env-key';
    try {
      expect(resolveApiKey({ id: 'gemini-x' }, { envVars: ['GOOGLE_API_KEY'] })).toBe(
        'google-env-key'
      );
    } finally {
      if (before === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = before;
    }
  });

  test('a self-hosted model with no key resolves to the empty string, not a default', () => {
    // vLLM endpoints legitimately need no auth; inventing a key would send an
    // Authorization header the endpoint never asked for.
    expect(resolveApiKey({ id: 'voxtral-mini-realtime' })).toBe('');
    expect(vllmRealtime.resolveUpstream({ url: 'ws://localhost:8080/v1/realtime' }).apiKey).toBe(
      ''
    );
  });
});
