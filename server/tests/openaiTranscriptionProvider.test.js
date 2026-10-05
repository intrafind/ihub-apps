/**
 * OpenAI-compatible transcription provider — unit tests.
 *
 * Whisper on T-Systems LLM Hub, OpenAI or a vLLM server, as a transcription
 * model of the `openai` / `local` API type: the endpoint it calls, the key it
 * uses (a linked provider's, as for chat models), the upload it sends, how a
 * long recording is split between words, and how failures read.
 */
import http from 'node:http';
import { getTranscriptionProvider } from '../transcription/index.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import configCache from '../configCache.js';
import openaiTranscribe, {
  DEFAULT_OPENAI_BASE,
  describeError,
  resolveUpstream,
  splitPcm,
  transcribe,
  transcriptionsUrl
} from '../transcription/openaiTranscribeProvider.js';

const llmHubWhisper = {
  id: 'llmhub-whisper-large-v3-turbo',
  modelId: 'whisper-large-v3-turbo',
  name: { en: 'Whisper Large v3 Turbo' },
  description: { en: 'Imported from llm-server.llmhub.t-systems.net.' },
  url: 'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions',
  provider: 'openai',
  providerId: 'llmhub',
  modelType: 'transcription',
  enabled: true
};

afterAll(() => {
  for (const key of ['config/providers.json']) {
    const timer = configCache.refreshTimers?.get(key);
    if (timer) clearTimeout(timer);
    configCache.refreshTimers?.delete(key);
  }
});

describe('registry and schema', () => {
  test('the openai and local API types run OpenAI-compatible transcription', () => {
    expect(getTranscriptionProvider('openai')).toBe(openaiTranscribe);
    expect(getTranscriptionProvider('local')).toBe(openaiTranscribe);
    expect(openaiTranscribe.mode).toBe('batch');
  });

  test('an imported LLM Hub Whisper model validates', () => {
    expect(modelConfigSchema.safeParse(llmHubWhisper).success).toBe(true);
  });
});

describe('transcriptionsUrl', () => {
  test.each([
    [
      'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions',
      'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions'
    ],
    [
      'https://llm-server.llmhub.t-systems.net/v2',
      'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions'
    ],
    [
      'https://llm-server.llmhub.t-systems.net/v2/chat/completions/',
      'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions'
    ],
    ['http://gpu:8000/v1/models', 'http://gpu:8000/v1/audio/transcriptions'],
    [
      'https://gw.example/openai/v1?api-version=1',
      'https://gw.example/openai/v1/audio/transcriptions?api-version=1'
    ]
  ])('%s → %s', (url, expected) => {
    expect(transcriptionsUrl(url, 'openai')).toBe(expected);
  });

  test('openai without a URL uses OpenAI; local has nothing to fall back on', () => {
    expect(transcriptionsUrl('', 'openai')).toBe(`${DEFAULT_OPENAI_BASE}/audio/transcriptions`);
    expect(transcriptionsUrl('', 'local')).toBe('');
  });
});

describe('resolveUpstream', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    configCache.setCacheEntry('config/providers.json', { providers: [] });
  });

  test('a model linked to LLM Hub uses the key stored on that provider', () => {
    configCache.setCacheEntry('config/providers.json', {
      providers: [
        { id: 'llmhub', apiType: 'openai', apiKey: 'hub-key' },
        { id: 'openai', apiKey: 'openai-key' }
      ]
    });
    expect(resolveUpstream(llmHubWhisper)).toEqual({
      url: llmHubWhisper.url,
      apiKey: 'hub-key',
      model: 'whisper-large-v3-turbo',
      options: {}
    });
  });

  test('…then that provider’s environment variable, never the OpenAI one', () => {
    process.env.OPENAI_API_KEY = 'openai-env';
    expect(resolveUpstream(llmHubWhisper).apiKey).toBe('');
    process.env.LLMHUB_API_KEY = 'hub-env';
    expect(resolveUpstream(llmHubWhisper).apiKey).toBe('hub-env');
  });

  test('an unlinked model uses its own key, then OPENAI_API_KEY / LOCAL_API_KEY', () => {
    const plain = { ...llmHubWhisper, providerId: undefined, id: 'whisper' };
    expect(resolveUpstream({ ...plain, apiKey: 'own' }).apiKey).toBe('own');
    process.env.OPENAI_API_KEY = 'openai-env';
    expect(resolveUpstream(plain).apiKey).toBe('openai-env');
    expect(resolveUpstream({ ...plain, provider: 'local' }).apiKey).toBe('');
  });
});

describe('splitPcm', () => {
  const RATE = 16000;
  const pcmOf = (seconds, sample) => {
    const buf = Buffer.alloc(Math.round(seconds * RATE) * 2);
    for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(sample(i / 2), i);
    return buf;
  };

  test('a recording within the limit stays whole', () => {
    const pcm = pcmOf(5, () => 1000);
    expect(splitPcm(pcm, { sampleRate: RATE, maxChunkSeconds: 30 })).toEqual([pcm]);
  });

  test('a long recording is cut in the pause before the limit, in whole samples', () => {
    // Loud everywhere except a 200 ms pause at 25 s.
    const pause = [25 * RATE, 25.2 * RATE];
    const pcm = pcmOf(70, n => (n >= pause[0] && n < pause[1] ? 0 : n % 2 ? 8000 : -8000));
    const parts = splitPcm(pcm, { sampleRate: RATE, maxChunkSeconds: 30 });

    expect(Buffer.concat(parts)).toEqual(pcm);
    expect(parts.every(part => part.length % 2 === 0)).toBe(true);
    expect(parts.every(part => part.length <= 30 * RATE * 2)).toBe(true);
    const firstCut = parts[0].length / 2;
    expect(firstCut).toBeGreaterThanOrEqual(pause[0]);
    expect(firstCut).toBeLessThan(pause[1]);
  });
});

describe('describeError', () => {
  test('names the status and the service’s own message', () => {
    expect(
      describeError(404, JSON.stringify({ error: { message: 'model not found' } }), true)
    ).toBe('the service answered HTTP 404: model not found');
    expect(describeError(403, JSON.stringify({ detail: 'Model not in plan' }), true)).toBe(
      'the service answered HTTP 403: Model not in plan'
    );
  });

  test('tells a missing key from a rejected one', () => {
    expect(describeError(401, '', false)).toMatch(/needs an API key/);
    expect(describeError(401, '', true)).toMatch(/rejected the API key/);
  });
});

describe('against a stub /audio/transcriptions endpoint', () => {
  let server;
  let url;
  let handler;
  const requests = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('latin1')
        });
        handler(req, res);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/v2/audio/transcriptions`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    requests.length = 0;
  });

  const cfg = overrides => ({
    url,
    apiKey: 'hub-key',
    model: 'whisper-large-v3-turbo',
    options: {},
    ...overrides
  });
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  test('uploads the recording as WAV with the model, and returns the text', async () => {
    handler = (req, res) => json(res, { text: ' Hallo Welt ' });
    const { text } = await transcribe({
      cfg: cfg({ options: { language: 'de', prompt: 'iHub, IntraFind' } }),
      pcm: Buffer.alloc(32000)
    });

    expect(text).toBe('Hallo Welt');
    const [request] = requests;
    expect(request.url).toBe('/v2/audio/transcriptions');
    expect(request.headers.authorization).toBe('Bearer hub-key');
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.body).toMatch(/name="file"; filename="audio\.wav"/);
    expect(request.body).toContain('RIFF');
    expect(request.body).toMatch(/name="model"\r\n\r\nwhisper-large-v3-turbo\r\n/);
    expect(request.body).toMatch(/name="response_format"\r\n\r\njson\r\n/);
    expect(request.body).toMatch(/name="language"\r\n\r\nde\r\n/);
    expect(request.body).toMatch(/name="prompt"\r\n\r\niHub, IntraFind\r\n/);
  });

  test('a long recording goes up in parts, transcribed in order', async () => {
    let n = 0;
    handler = (req, res) => json(res, { text: `part ${++n}` });
    const { text } = await transcribe({
      cfg: cfg({ options: { maxChunkSeconds: 30 } }),
      pcm: Buffer.alloc(70 * 16000 * 2)
    });
    expect(requests).toHaveLength(3);
    expect(text).toBe('part 1 part 2 part 3');
  });

  test('without a key, no Authorization header is sent', async () => {
    handler = (req, res) => json(res, { text: 'ok' });
    await transcribe({ cfg: cfg({ apiKey: '' }), pcm: Buffer.alloc(320) });
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  test('a server answering with bare text works too', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('plain transcript\n');
    };
    expect((await transcribe({ cfg: cfg(), pcm: Buffer.alloc(320) })).text).toBe(
      'plain transcript'
    );
  });

  test('an error carries the status and the service’s message, not the URL', async () => {
    handler = (req, res) => json(res, { error: { message: 'model not found' } }, 404);
    await expect(transcribe({ cfg: cfg(), pcm: Buffer.alloc(320) })).rejects.toMatchObject({
      status: 404,
      message: 'the service answered HTTP 404: model not found'
    });
  });

  test('an empty recording sends nothing', async () => {
    expect(await transcribe({ cfg: cfg(), pcm: Buffer.alloc(0) })).toEqual({ text: '' });
    expect(requests).toHaveLength(0);
  });
});
