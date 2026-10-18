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
import http from 'node:http';
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
  ANNOTATED_MAX_SECONDS,
  annotatedParts,
  buildTranscriptionConfig,
  extractTranscript,
  extractWords,
  isPendingStatus,
  normalizeApiBase
} from '../transcription/googleTranscribeProvider.js';
import { formatClock } from '../transcription/transcriptFormat.js';
import { pcm16ToWav } from '../transcription/wav.js';
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

  test('interpret asks the bridge for a fresh session on goAway', () => {
    expect(googleLive.interpret({ goAway: { timeLeft: '10s' } })).toEqual({ kind: 'go-away' });
  });

  test('interpret ignores control frames that need no client action', () => {
    for (const frame of [
      {},
      { serverContent: { turnComplete: true } },
      { serverContent: {} },
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

  test('timestamps and speakers switch to verbatim mode with the matching options', () => {
    expect(buildTranscriptionConfig({}, { timestamps: true }).mode).toEqual({
      type: 'verbatim',
      timestamp_granularities: ['word']
    });
    expect(buildTranscriptionConfig({}, { speakers: true }).mode).toEqual({
      type: 'verbatim',
      diarization_mode: 'speaker'
    });
    expect(buildTranscriptionConfig({}, { timestamps: true, speakers: true }).mode).toEqual({
      type: 'verbatim',
      timestamp_granularities: ['word'],
      diarization_mode: 'speaker'
    });
  });

  test('smart mode and custom vocabulary are dropped when timestamps or speakers are on', () => {
    // Gemini rejects both combinations; the language codes stay.
    const cfg = buildTranscriptionConfig(
      { mode: 'smart', customVocabulary: ['iHub', 'IntraFind'], languageCodes: ['de-DE'] },
      { timestamps: true }
    );
    expect(cfg.custom_vocabulary).toBeUndefined();
    expect(cfg.mode).not.toBe('smart');
    expect(cfg.language_codes).toEqual(['de-DE']);
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

  test('reads the word annotations with their offsets as seconds', () => {
    const body = {
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: 'Hello world',
              annotations: [
                {
                  type: 'word_info',
                  text: 'Hello',
                  speaker: 'spk_1',
                  start_offset: '0.100s',
                  end_offset: '0.450s'
                },
                {
                  type: 'word_info',
                  text: 'world',
                  speaker: 'spk_1',
                  start_offset: '0.500s',
                  end_offset: '0.850s'
                },
                { type: 'something_else', text: 'ignored' },
                { type: 'word_info', text: 'nobody', start_offset: 'soon' }
              ]
            },
            { type: 'text', text: 'no annotations' }
          ]
        }
      ]
    };
    expect(extractWords(body)).toEqual([
      { text: 'Hello', speaker: 'spk_1', start: 0.1, end: 0.45 },
      { text: 'world', speaker: 'spk_1', start: 0.5, end: 0.85 },
      { text: 'nobody', speaker: undefined, start: null, end: null }
    ]);
    expect(extractWords({})).toEqual([]);
  });

  test('a recording up to 30 minutes is one part; a longer one is cut into equal parts', () => {
    const rate = 16000;
    const pcmOf = seconds => Buffer.alloc(Math.round(seconds * rate) * 2);

    expect(annotatedParts(pcmOf(ANNOTATED_MAX_SECONDS))).toHaveLength(1);

    // 30:10 is two halves (give or take the move to a pause), not a full part
    // and a ten-second tail.
    const two = annotatedParts(pcmOf(ANNOTATED_MAX_SECONDS + 10));
    expect(two).toHaveLength(2);
    for (const part of two) {
      expect(part.length / (rate * 2)).toBeGreaterThan(800);
      expect(part.length / (rate * 2)).toBeLessThanOrEqual(ANNOTATED_MAX_SECONDS);
    }

    // 70 minutes is three parts, none over the limit.
    const three = annotatedParts(pcmOf(70 * 60));
    expect(three).toHaveLength(3);
    expect(three.every(part => part.length / (rate * 2) <= ANNOTATED_MAX_SECONDS)).toBe(true);
    expect(Buffer.concat(three).length).toBe(70 * 60 * rate * 2);
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

describe('googleTranscribeProvider — timestamps and speakers (stub Gemini API)', () => {
  let server;
  let base;
  let uploads;
  let interactions;
  let deletions;
  let answers;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const json = (payload, headers = {}) => {
          res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'POST' && req.url === '/upload/v1beta/files') {
          return json({}, { 'x-goog-upload-url': `${base}/session/${uploads.length + 1}` });
        }
        if (req.method === 'POST' && req.url.startsWith('/session/')) {
          uploads.push(body.length);
          const name = `files/f${uploads.length}`;
          return json({
            file: { name, uri: `${base}/${name}`, mimeType: 'audio/wav', state: 'ACTIVE' }
          });
        }
        if (req.method === 'POST' && req.url === '/v1beta/interactions') {
          interactions.push(JSON.parse(body.toString()));
          return json(answers[interactions.length - 1] ?? answers[answers.length - 1]);
        }
        if (req.method === 'DELETE') {
          deletions.push(req.url);
          return json({});
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    uploads = [];
    interactions = [];
    deletions = [];
    answers = [];
  });

  const cfg = options => ({ url: base, apiKey: 'k', model: 'gemini-3.5-transcribe', options });
  const word = (text, speaker, start, end) => ({
    type: 'word_info',
    text,
    speaker,
    start_offset: `${start}s`,
    end_offset: `${end}s`
  });
  const completed = (text, annotations) => ({
    id: 'interactions/x',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }]
  });
  const talk = completed('Welcome to the talk Thanks for having me', [
    word('Welcome', 'spk_1', 0.1, 0.5),
    word('to', 'spk_1', 0.6, 0.7),
    word('the', 'spk_1', 0.8, 0.9),
    word('talk', 'spk_1', 1.0, 1.4),
    word('Thanks', 'spk_2', 3.0, 3.4),
    word('for', 'spk_2', 3.5, 3.6),
    word('having', 'spk_2', 3.7, 4.0),
    word('me', 'spk_2', 4.1, 4.3)
  ]);

  test('a transcript to read carries speakers and times, in verbatim mode without vocabulary', async () => {
    answers = [talk];
    const { text } = await googleTranscribe.transcribe({
      cfg: cfg({
        timestamps: true,
        speakers: true,
        customVocabulary: ['iHub'],
        languageCodes: ['en-US']
      }),
      pcm: Buffer.alloc(32000),
      annotate: true
    });

    expect(text).toBe(
      '[00:00] Speaker 1: Welcome to the talk\n[00:03] Speaker 2: Thanks for having me'
    );
    expect(interactions).toHaveLength(1);
    expect(interactions[0].generation_config.transcription_config).toEqual({
      mode: {
        type: 'verbatim',
        timestamp_granularities: ['word'],
        diarization_mode: 'speaker'
      },
      language_codes: ['en-US']
    });
    expect(deletions).toEqual(['/v1beta/files/f1']);
  });

  test('speakers without timestamps give turns, no times', async () => {
    answers = [talk];
    const { text } = await googleTranscribe.transcribe({
      cfg: cfg({ speakers: true, speakerLabel: 'Sprecher' }),
      pcm: Buffer.alloc(32000),
      annotate: true
    });
    expect(text).toBe('Sprecher 1: Welcome to the talk\nSprecher 2: Thanks for having me');
    expect(interactions[0].generation_config.transcription_config.mode).toEqual({
      type: 'verbatim',
      diarization_mode: 'speaker'
    });
  });

  test('without annotate (dictation, voice mode) the config is ignored: smart text, vocabulary kept', async () => {
    answers = [completed('Welcome to the talk', [])];
    const { text } = await googleTranscribe.transcribe({
      cfg: cfg({ timestamps: true, speakers: true, customVocabulary: ['iHub'] }),
      pcm: Buffer.alloc(32000)
    });

    expect(text).toBe('Welcome to the talk');
    expect(interactions[0].generation_config.transcription_config).toEqual({
      mode: 'smart',
      custom_vocabulary: ['iHub']
    });
  });

  test('a recording over 30 minutes goes up in parts and the times keep counting', async () => {
    const seconds = 31 * 60;
    answers = [talk]; // both parts: the same words, from 0 s of their own part
    const { text } = await googleTranscribe.transcribe({
      cfg: cfg({ timestamps: true }),
      pcm: Buffer.alloc(seconds * 16000 * 2),
      annotate: true
    });

    expect(interactions).toHaveLength(2);
    expect(uploads).toHaveLength(2);
    expect(deletions).toHaveLength(2);
    // The second part starts where the first ended (its upload less the 44-byte
    // header); its first word is 0.1 s into it.
    const secondStart = (uploads[0] - 44) / 32000;
    expect(secondStart).toBeGreaterThan(900);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[00:00] Welcome to the talk Thanks for having me');
    expect(lines[1]).toBe(
      `[${formatClock(secondStart + 0.1)}] Welcome to the talk Thanks for having me`
    );
  });

  test('a response without annotations still gives the plain transcript', async () => {
    answers = [completed('Hello there.', undefined)];
    const { text } = await googleTranscribe.transcribe({
      cfg: cfg({ timestamps: true }),
      pcm: Buffer.alloc(32000),
      annotate: true
    });
    expect(text).toBe('Hello there.');
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
