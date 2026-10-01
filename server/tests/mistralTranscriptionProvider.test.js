/**
 * Mistral realtime transcription provider — unit tests.
 *
 * `voxtral-mini-transcribe-realtime-2602` on the Mistral platform: a
 * `provider: 'mistral'`, `modelType: 'transcription'` model, next to the
 * self-hosted Voxtral on vLLM. Covers the frames it sends and reads, its
 * credentials, and that the key never lands in the url the bridge logs.
 */
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import mistral, {
  AUDIO_FORMAT,
  DEFAULT_REALTIME_URL,
  formatUpstreamError
} from '../transcription/mistralRealtimeProvider.js';

const model = {
  id: 'voxtral-mini-transcribe-realtime',
  modelId: 'voxtral-mini-transcribe-realtime-2602',
  name: { en: 'Voxtral' },
  description: { en: 'd' },
  url: DEFAULT_REALTIME_URL,
  provider: 'mistral',
  modelType: 'transcription',
  enabled: true
};

describe('registry and schema', () => {
  test('a mistral transcription model resolves to the realtime provider', () => {
    expect(getTranscriptionProvider('mistral')).toBe(mistral);
    expect(mistral.mode).toBe('stream');
    expect(mistral.readyFallbackMs).toBe(0);
  });

  test('the model config validates, and mistral stays a chat provider', () => {
    expect(modelConfigSchema.safeParse(model).success).toBe(true);
    const chat = { ...model, modelType: undefined, url: 'https://api.mistral.ai/v1' };
    expect(modelConfigSchema.safeParse(chat).success).toBe(true);
  });
});

describe('connection', () => {
  const savedEnv = process.env.MISTRAL_API_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = savedEnv;
  });

  test('resolveUpstream defaults the endpoint and keeps the key out of the url', () => {
    const cfg = mistral.resolveUpstream({ ...model, url: undefined, apiKey: 'secret-key' });
    expect(cfg.url).toBe(DEFAULT_REALTIME_URL);
    expect(cfg.url).not.toContain('secret-key');
    expect(cfg.apiKey).toBe('secret-key');
    expect(cfg.model).toBe('voxtral-mini-transcribe-realtime-2602');
    expect(cfg.targetStreamingDelayMs).toBeNull();
  });

  test('falls back to MISTRAL_API_KEY, the key the chat models use', () => {
    process.env.MISTRAL_API_KEY = 'env-key';
    expect(mistral.resolveUpstream(model).apiKey).toBe('env-key');
  });

  test('connect() puts the model in the query and the key in a Bearer header', () => {
    const { url, options } = mistral.connect({
      url: DEFAULT_REALTIME_URL,
      model: 'voxtral-mini-transcribe-realtime-2602',
      apiKey: 'k123'
    });
    expect(url).toBe(`${DEFAULT_REALTIME_URL}?model=voxtral-mini-transcribe-realtime-2602`);
    expect(url).not.toContain('k123');
    expect(options.headers).toEqual({ Authorization: 'Bearer k123' });
  });

  test('connect() never sends the key over a connection without TLS', () => {
    expect(() =>
      mistral.connect({ url: 'ws://proxy.internal/v1/audio/transcriptions/realtime', apiKey: 'k' })
    ).toThrow(/wss:\/\//);
  });

  test('connect() sends no Authorization header without a key', () => {
    expect(mistral.connect({ url: DEFAULT_REALTIME_URL, model: 'm' }).options.headers).toEqual({});
  });
});

describe('frames', () => {
  test('nothing on open; the audio format once the session exists', () => {
    expect(mistral.openFrames()).toEqual([]);
    expect(mistral.readyFrames({})).toEqual([
      { type: 'session.update', session: { audio_format: AUDIO_FORMAT } }
    ]);
  });

  test('a configured streaming delay goes into the session update', () => {
    const cfg = mistral.resolveUpstream({ ...model, config: { targetStreamingDelayMs: 480 } });
    expect(mistral.readyFrames(cfg)[0].session.target_streaming_delay_ms).toBe(480);
    const bad = mistral.resolveUpstream({ ...model, config: { targetStreamingDelayMs: 'soon' } });
    expect(mistral.readyFrames(bad)[0].session).not.toHaveProperty('target_streaming_delay_ms');
  });

  test('audio is appended as base64; stop flushes and ends the stream', () => {
    expect(mistral.audioFrame('AAEC')).toEqual({ type: 'input_audio.append', audio: 'AAEC' });
    expect(mistral.stopFrames()).toEqual([
      { type: 'input_audio.flush' },
      { type: 'input_audio.end' }
    ]);
  });

  test('interpret maps session, text deltas, the done transcript and errors', () => {
    expect(mistral.interpret({ type: 'session.created', session: {} })).toEqual({
      kind: 'session-ready'
    });
    expect(mistral.interpret({ type: 'transcription.text.delta', text: 'Hel' })).toEqual({
      kind: 'delta',
      text: 'Hel'
    });
    expect(
      mistral.interpret({ type: 'transcription.done', text: 'Hello world', language: 'en' })
    ).toEqual({ kind: 'final', text: 'Hello world' });
    expect(
      mistral.interpret({ type: 'error', error: { message: 'Unauthorized', code: 401 } })
    ).toEqual({ kind: 'error', error: '401: Unauthorized' });
    for (const type of ['session.updated', 'transcription.language', 'transcription.segment']) {
      expect(mistral.interpret({ type, text: 'x' })).toEqual({ kind: 'ignore' });
    }
  });

  test('formatUpstreamError copes with every shape', () => {
    expect(formatUpstreamError(undefined)).toBe('unknown');
    expect(formatUpstreamError('boom')).toBe('boom');
    expect(formatUpstreamError({ message: { detail: 'bad' }, code: 3 })).toBe(
      '3: {"detail":"bad"}'
    );
    expect(formatUpstreamError({})).toBe('unknown');
  });
});
