/**
 * Google Gemini text-to-speech provider — unit tests.
 *
 * `gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts` as `provider: 'google'`,
 * `modelType: 'tts'`: the streaming endpoint it calls, the request it sends,
 * the 16-bit PCM it hands on (whole samples, no WAV header), how it treats a
 * cut-off or refused stream, and that the key never lands in the URL.
 */
import http from 'node:http';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { getTtsProvider } from '../tts/index.js';
import googleTts, {
  API_BASE,
  PREBUILT_VOICES,
  buildRequest,
  createPcm16Aligner,
  describeError,
  listVoices,
  resolveUpstream,
  streamUrl,
  synthesize
} from '../tts/googleTtsProvider.js';

const model = {
  id: 'gemini-3.8-flash-tts',
  modelId: 'gemini-3.8-flash-tts',
  name: { en: 'Gemini TTS' },
  description: { en: 'Reads aloud' },
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent',
  provider: 'google',
  modelType: 'tts',
  tts: { voice: 'Puck' },
  enabled: true
};

describe('registry and schema', () => {
  test('a google TTS model validates and resolves to the Gemini provider', () => {
    expect(modelConfigSchema.safeParse(model).success).toBe(true);
    expect(getTtsProvider('google')).toBe(googleTts);
    expect(googleTts.sampleRate).toBe(24000);
  });

  test('the shipped default models validate', async () => {
    for (const id of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']) {
      const { default: shipped } = await import(`../defaults/models/${id}.json`, {
        with: { type: 'json' }
      });
      expect(modelConfigSchema.safeParse(shipped).success).toBe(true);
      expect(shipped.enabled).toBe(false);
    }
  });
});

describe('endpoint and request', () => {
  const savedEnv = process.env.GOOGLE_API_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = savedEnv;
  });

  test('streamUrl streams over SSE from a method URL, a base URL or nothing', () => {
    expect(streamUrl(model.url, 'm')).toBe(`${model.url}?alt=sse`);
    expect(
      streamUrl(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent',
        'm'
      )
    ).toBe(`${model.url}?alt=sse`);
    expect(streamUrl('https://generativelanguage.googleapis.com', 'gemini-3.8-flash-tts')).toBe(
      `${model.url}?alt=sse`
    );
    expect(streamUrl('', 'gemini-3.8-flash-tts')).toBe(
      `${API_BASE}/models/gemini-3.8-flash-tts:streamGenerateContent?alt=sse`
    );
  });

  test('resolveUpstream takes the model voice and keeps the key out of the URL', () => {
    const cfg = resolveUpstream({ ...model, apiKey: 'secret-key' });
    expect(cfg).toEqual({
      url: `${model.url}?alt=sse`,
      apiKey: 'secret-key',
      model: 'gemini-3.8-flash-tts',
      voice: 'Puck'
    });
  });

  test('falls back to GOOGLE_API_KEY and the default voice', () => {
    process.env.GOOGLE_API_KEY = 'env-key';
    const cfg = resolveUpstream({ ...model, tts: undefined });
    expect(cfg.apiKey).toBe('env-key');
    expect(cfg.voice).toBe('Kore');
  });

  test('a voice per language wins for a message in that language', () => {
    const cfg = resolveUpstream(
      { ...model, tts: { voice: 'Puck', voices: { de: 'Leda' } } },
      {
        language: 'de'
      }
    );
    expect(cfg.voice).toBe('Leda');
  });

  test('asks for audio in the chosen voice', () => {
    expect(buildRequest('Hello', 'Charon')).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { voice: 'Charon' } }
      }
    });
  });

  test('lists the prebuilt voices', async () => {
    const voices = await listVoices();
    expect(voices).toHaveLength(PREBUILT_VOICES.length);
    expect(voices[0]).toMatchObject({ id: 'Zephyr', name: 'Zephyr', type: 'preset' });
  });
});

describe('createPcm16Aligner', () => {
  test('carries a split sample into the next chunk', () => {
    const align = createPcm16Aligner();
    const a = align(Buffer.from([1, 2, 3]));
    const b = align(Buffer.from([4, 5]));
    expect([...a]).toEqual([1, 2]);
    expect([...b]).toEqual([3, 4]);
    expect([...align(Buffer.from([6]))]).toEqual([5, 6]);
  });

  test('drops a WAV header', () => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.write('WAVE', 8, 'ascii');
    const out = createPcm16Aligner()(Buffer.concat([header, Buffer.from([7, 8])]));
    expect([...out]).toEqual([7, 8]);
  });
});

describe('describeError', () => {
  test('names a rejected key', () => {
    const body = JSON.stringify({
      error: { code: 400, message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] }
    });
    expect(describeError(400, body)).toBe('Google rejected the API key');
    expect(describeError(403, '{}')).toMatch(/API key \(HTTP 403\)/);
  });

  test('reports the upstream message otherwise', () => {
    expect(describeError(400, JSON.stringify({ error: { message: 'Voice not found' } }))).toBe(
      'Google TTS failed (HTTP 400): Voice not found'
    );
  });
});

describe('against a stub Gemini endpoint', () => {
  let server;
  let base;
  let handler;
  const requests = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
        handler(req, res);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    requests.length = 0;
  });

  const cfg = () => ({
    url: `${base}?alt=sse`,
    apiKey: 'test-key',
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore'
  });
  const pcm = samples => {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
    return buf;
  };
  const event = (data, finishReason, usageMetadata) =>
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: data ? [{ inlineData: { mimeType: 'audio/L16;rate=24000', data } }] : []
          },
          ...(finishReason ? { finishReason } : {})
        }
      ],
      ...(usageMetadata ? { usageMetadata } : {})
    })}\r\n\r\n`;

  test('streams the PCM of every chunk, in whole samples, and returns the usage', async () => {
    const audio = pcm([0, 1000, -1000, 32767]);
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // A sample split across two chunks.
      res.write(event(audio.subarray(0, 3).toString('base64')));
      res.end(event(audio.subarray(3).toString('base64'), 'STOP', { totalTokenCount: 9 }));
    };
    const chunks = [];
    const { usage } = await synthesize({
      cfg: cfg(),
      text: 'Hello',
      onAudio: chunk => chunks.push(chunk)
    });
    expect(usage).toEqual({ totalTokenCount: 9 });
    expect(chunks.every(chunk => chunk.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(audio);
    expect(requests[0].url).toMatch(/\?alt=sse$/);
    expect(requests[0].url).not.toContain('test-key');
    expect(requests[0].headers['x-goog-api-key']).toBe('test-key');
    expect(requests[0].body).toEqual(buildRequest('Hello', 'Kore'));
  });

  test('a stream that ends without a finish reason rejects', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(event(pcm([1]).toString('base64')));
    };
    await expect(synthesize({ cfg: cfg(), text: 'Hi', onAudio: () => {} })).rejects.toMatchObject({
      name: 'TtsUpstreamError',
      message: expect.stringMatching(/ended before the audio was complete/)
    });
  });

  test('a stop for any other reason rejects with the reason', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(event(null, 'SAFETY'));
    };
    await expect(synthesize({ cfg: cfg(), text: 'Hi', onAudio: () => {} })).rejects.toThrow(
      /stopped early: SAFETY/
    );
  });

  test('an HTTP error carries the status and the upstream message', async () => {
    handler = (req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'models/x is not found' } }));
    };
    await expect(synthesize({ cfg: cfg(), text: 'Hi', onAudio: () => {} })).rejects.toMatchObject({
      name: 'TtsUpstreamError',
      status: 404,
      message: expect.stringMatching(/HTTP 404.*not found/)
    });
  });

  test('no key, no request', async () => {
    await expect(
      synthesize({ cfg: { ...cfg(), apiKey: '' }, text: 'Hi', onAudio: () => {} })
    ).rejects.toThrow(/No Google API key/);
    expect(requests).toHaveLength(0);
  });
});
