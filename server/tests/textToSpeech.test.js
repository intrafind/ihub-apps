/**
 * Read aloud (text-to-speech) — unit tests, issue #2642.
 *
 * Covers the `modelType: 'tts'` schema, Markdown → speakable text and its
 * chunking, TTS model resolution (platform switch, permissions, model type),
 * and the Mistral provider's SSE parsing and float32 → 16-bit conversion
 * against a local stub of the Mistral speech endpoint.
 */
import http from 'node:http';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { toSpeechText, splitSpeechText } from '../tts/speechText.js';
import { resolveTtsModel, prepareSpeech, getTtsProvider, isTtsModel } from '../tts/index.js';
import mistralTtsProvider, {
  createFloat32ToPcm16Converter,
  resolveUpstream,
  synthesize,
  voicesUrl,
  listVoices,
  createVoice,
  deleteVoice
} from '../tts/mistralTtsProvider.js';
import { detectSpeechLanguage, normalizeLanguage, selectVoice } from '../tts/language.js';
import configCache from '../configCache.js';

const ttsModel = {
  id: 'voxtral-mini-tts',
  modelId: 'voxtral-mini-tts-latest',
  name: { en: 'Voxtral TTS' },
  description: { en: 'Reads aloud' },
  url: 'https://api.mistral.ai/v1/audio/speech',
  provider: 'mistral',
  modelType: 'tts',
  tts: { voice: 'gb_jane_neutral' },
  enabled: true
};

describe('modelConfigSchema — modelType tts', () => {
  test('accepts a Mistral TTS model with a voice', () => {
    const result = modelConfigSchema.safeParse(ttsModel);
    expect(result.success).toBe(true);
    expect(result.data.tts).toEqual({ voice: 'gb_jane_neutral' });
  });

  test('rejects a TTS model on a provider without a TTS implementation', () => {
    const result = modelConfigSchema.safeParse({ ...ttsModel, provider: 'anthropic' });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['provider']);
  });

  test('accepts a voice per language', () => {
    const result = modelConfigSchema.safeParse({
      ...ttsModel,
      tts: {
        voice: 'en_paul_neutral',
        voices: { de: '01a0f7a6-649d-732a', fr: 'fr_marie_neutral' }
      }
    });
    expect(result.success).toBe(true);
  });

  test('rejects a language that is not a two-letter code, or an empty voice', () => {
    expect(
      modelConfigSchema.safeParse({ ...ttsModel, tts: { voices: { german: 'x' } } }).success
    ).toBe(false);
    expect(modelConfigSchema.safeParse({ ...ttsModel, tts: { voices: { de: '' } } }).success).toBe(
      false
    );
  });

  test('rejects tts settings on a chat model', () => {
    const result = modelConfigSchema.safeParse({ ...ttsModel, modelType: 'chat' });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['tts']);
  });

  test('the shipped default model validates', async () => {
    const { default: model } = await import('../defaults/models/voxtral-mini-tts.json', {
      with: { type: 'json' }
    });
    const result = modelConfigSchema.safeParse(model);
    expect(result.success).toBe(true);
    expect(result.data.enabled).toBe(false);
  });
});

describe('platformConfigSchema — speech.tts', () => {
  test('defaults to read aloud off with no model', () => {
    const { speech } = platformConfigSchema.parse({});
    expect(speech.tts).toEqual({ enabled: false, defaultModelId: '' });
  });

  test('keeps the configured model and character cap', () => {
    const { speech } = platformConfigSchema.parse({
      speech: { tts: { enabled: true, defaultModelId: 'voxtral-mini-tts', maxCharacters: 5000 } }
    });
    expect(speech.tts).toEqual({
      enabled: true,
      defaultModelId: 'voxtral-mini-tts',
      maxCharacters: 5000
    });
  });
});

describe('toSpeechText', () => {
  test('drops markup and keeps the words', () => {
    const text = toSpeechText(
      '## Summary\n\nText to **speech** lets users *listen* [1]. See [the docs](https://example.com/docs).'
    );
    expect(text).toBe('Summary.\n\nText to speech lets users listen. See the docs.');
  });

  test('drops code blocks, images, URLs, footnotes and inline reasoning', () => {
    const text = toSpeechText(
      [
        'Before.',
        '```js',
        "console.log('never read');",
        '```',
        '![chart](https://x/y.png) Visit https://example.com now[^1].',
        '<think>private reasoning</think>After.',
        '[^1]: A footnote.'
      ].join('\n')
    );
    expect(text).not.toMatch(/console|never read|https|chart|footnote|private reasoning/);
    expect(text).toContain('Before.');
    expect(text).toContain('Visit now.');
    expect(text).toContain('After.');
  });

  test('reads list items and table rows as sentences', () => {
    const text = toSpeechText(
      '- First point\n- Second point\n\n| Format | Latency |\n|---|---|\n| pcm | 0.7 s |'
    );
    expect(text).toBe('First point. Second point.\n\nFormat, Latency. pcm, 0.7 s.');
  });

  test('decodes entities and strips HTML tags', () => {
    expect(toSpeechText('<p>Fish &amp; chips</p><br><b>now</b>')).toBe('Fish & chips\n\nnow');
  });

  test('ends dropped elements at any close tag a browser accepts', () => {
    expect(toSpeechText('One <script>x()</script > two <STYLE>.a{}</style foo> three')).toBe(
      'One two three'
    );
    // `</thinking>` does not close a `<think>` block.
    expect(toSpeechText('A <think>secret</thinking> still secret</think> B')).toBe('A B');
  });

  test('leaves no angle bracket from split or stray tags', () => {
    const text = toSpeechText('Before <scr<b>ipt>alert(1)</script> after a < b > c');
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('Before');
    expect(text).toContain('after');
  });

  test('returns an empty string when nothing is speakable', () => {
    expect(toSpeechText('```\ncode only\n```')).toBe('');
    expect(toSpeechText('---')).toBe('');
    expect(toSpeechText(null)).toBe('');
  });

  test('drops every line of a fenced block, ``` and ~~~ alike', () => {
    const text = toSpeechText(
      [
        'Intro.',
        '```js',
        'line one;',
        'line two;',
        '',
        'line three;',
        '```',
        'Middle.',
        '~~~~',
        '```',
        'still code',
        '~~~~',
        'Outro.'
      ].join('\n')
    );
    expect(text).toBe('Intro.\n\nMiddle.\n\nOutro.');
  });

  test('an unterminated code fence drops the rest instead of reading code', () => {
    expect(toSpeechText('Intro.\n```python\nprint(1)')).toBe('Intro.');
  });
});

describe('toSpeechText on hostile input', () => {
  // The text comes from the user and may be 200,000 characters long: a
  // backtracking pattern that rescans the rest of the input from every
  // occurrence of a delimiter turns that into seconds of blocked event loop.
  const N = 200000;
  const repeat = unit => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  test.each([
    ['unclosed elements', repeat('<script>')],
    ['unclosed tags', repeat('<a')],
    ['image openers', repeat('![')],
    ['link targets', repeat('[a](')],
    ['autolinks', repeat('<http:')],
    ['a heading with a whitespace run', `# a${repeat(' ')}b`],
    ['a heading with a hash run', `# a${repeat('#')}b`],
    ['a punctuation run', `a${repeat('.')}a`],
    ['a whitespace run', `a${repeat(' ')}b`],
    ['table pipes', repeat('|')]
  ])('stays fast for %s', (_name, input) => {
    const started = Date.now();
    prepareSpeech(input, { maxCharacters: N });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('splitSpeechText', () => {
  test('keeps short text in one piece', () => {
    expect(splitSpeechText('One. Two.')).toEqual(['One. Two.']);
  });

  test('cuts at paragraph and sentence boundaries, never inside a number', () => {
    const chunks = splitSpeechText(
      'It costs 0.7 dollars. Second sentence here.\n\nNext paragraph.',
      {
        maxChars: 30
      }
    );
    expect(chunks).toEqual(['It costs 0.7 dollars.', 'Second sentence here.', 'Next paragraph.']);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30);
  });

  test('splits an over-long sentence at word boundaries', () => {
    const sentence = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const chunks = splitSpeechText(sentence, { maxChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(sentence);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(50);
  });
});

describe('prepareSpeech', () => {
  test('caps the text at maxCharacters and says so', () => {
    const message = 'This sentence repeats for a while. '.repeat(100);
    const { chunks, characters, truncated } = prepareSpeech(message, { maxCharacters: 200 });
    expect(truncated).toBe(true);
    expect(characters).toBeLessThanOrEqual(200);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('does not truncate a short message', () => {
    const { chunks, truncated } = prepareSpeech('Hello **world**.');
    expect(truncated).toBe(false);
    expect(chunks).toEqual(['Hello world.']);
  });
});

describe('TTS provider registry and model resolution', () => {
  const chatModel = {
    id: 'mistral-small',
    modelId: 'mistral-small-latest',
    name: { en: 'Mistral Small' },
    description: { en: 'd' },
    url: 'https://api.mistral.ai/v1/chat/completions',
    provider: 'mistral',
    enabled: true
  };
  const disabledTts = { ...ttsModel, id: 'tts-off', enabled: false };
  const platformOn = { speech: { tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' } } };
  const wildcard = { permissions: { models: new Set(['*']) } };

  beforeEach(() => {
    configCache.setCacheEntry('config/models.json', [ttsModel, chatModel, disabledTts]);
  });

  afterAll(() => {
    const timer = configCache.refreshTimers?.get('config/models.json');
    if (timer) clearTimeout(timer);
    configCache.refreshTimers?.delete('config/models.json');
  });

  test('registers the Mistral provider', () => {
    expect(getTtsProvider('mistral')).toBe(mistralTtsProvider);
    expect(getTtsProvider('openai')).toBeNull();
    expect(isTtsModel(ttsModel)).toBe(true);
    expect(isTtsModel(chatModel)).toBe(false);
  });

  test('uses the platform default while read aloud is on', () => {
    const result = resolveTtsModel({ user: wildcard, platform: platformOn });
    expect(result.ok).toBe(true);
    expect(result.model.id).toBe('voxtral-mini-tts');
    expect(result.provider).toBe(mistralTtsProvider);
  });

  test('without a model id, read aloud switched off is not configured', () => {
    const off = { speech: { tts: { enabled: false, defaultModelId: 'voxtral-mini-tts' } } };
    expect(resolveTtsModel({ user: wildcard, platform: off })).toMatchObject({
      ok: false,
      status: 503,
      code: 'not-configured'
    });
    expect(resolveTtsModel({ user: wildcard, platform: {} }).code).toBe('not-configured');
  });

  test('an explicit model id is any enabled TTS model the user may use', () => {
    const result = resolveTtsModel({ modelId: 'voxtral-mini-tts', user: wildcard, platform: {} });
    expect(result.ok).toBe(true);
  });

  test('denies a user whose groups do not permit the model', () => {
    const denied = { permissions: { models: new Set(['mistral-small']) } };
    expect(resolveTtsModel({ user: denied, platform: platformOn })).toMatchObject({
      ok: false,
      status: 403,
      code: 'not-permitted'
    });
  });

  test('fails closed when permissions were not computed', () => {
    expect(resolveTtsModel({ user: {}, platform: platformOn }).code).toBe('not-permitted');
  });

  test('rejects a chat model, an unknown model and a disabled model', () => {
    expect(resolveTtsModel({ modelId: 'mistral-small', user: wildcard }).code).toBe(
      'unknown-model'
    );
    expect(resolveTtsModel({ modelId: 'nope', user: wildcard }).code).toBe('unknown-model');
    expect(resolveTtsModel({ modelId: 'tts-off', user: wildcard }).code).toBe('model-disabled');
  });
});

describe('message language and voice', () => {
  const samples = {
    en: 'Text to speech lets users listen to an answer instead of reading it. This is useful when you are on the move.',
    de: 'Die Sprachausgabe liest Antworten vor. Das ist praktisch, wenn man unterwegs ist und nicht auf den Bildschirm schauen kann.',
    fr: "La synthèse vocale lit les réponses à voix haute. C'est pratique quand on est en déplacement et que l'on ne peut pas lire.",
    es: 'La síntesis de voz lee las respuestas en voz alta. Es útil cuando estás en movimiento y no puedes leer la pantalla.',
    it: 'La sintesi vocale legge le risposte ad alta voce. È utile quando sei in movimento e non puoi leggere lo schermo.',
    nl: 'De spraakuitvoer leest de antwoorden voor. Dat is handig als je onderweg bent en niet op het scherm kunt kijken.',
    pt: 'A síntese de voz lê as respostas em voz alta. É útil quando você está em movimento e não pode ler a tela.',
    ar: 'تقرأ ميزة تحويل النص إلى كلام الإجابات بصوت عالٍ.',
    hi: 'टेक्स्ट टू स्पीच उत्तरों को ज़ोर से पढ़ता है।'
  };

  test.each(Object.entries(samples))('tells %s from its text', (language, text) => {
    expect(detectSpeechLanguage(text)).toBe(language);
  });

  test('the text beats the UI language', () => {
    expect(detectSpeechLanguage(samples.de, { hint: 'en' })).toBe('de');
  });

  test('too little text falls back to the UI language, or to nothing', () => {
    expect(detectSpeechLanguage('Hallo.', { hint: 'de-DE' })).toBe('de');
    expect(detectSpeechLanguage('Hallo.')).toBeNull();
    expect(detectSpeechLanguage('npm install', { hint: 'ja' })).toBeNull();
  });

  test('normalizes UI languages to the ones a voice can be set for', () => {
    expect(normalizeLanguage('de-AT')).toBe('de');
    expect(normalizeLanguage('pt_BR')).toBe('pt');
    expect(normalizeLanguage('ja')).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });

  test('picks the language voice, else the model voice', () => {
    const tts = { voice: 'en_paul_neutral', voices: { de: 'german-voice' } };
    expect(selectVoice(tts, 'de')).toBe('german-voice');
    expect(selectVoice(tts, 'fr')).toBe('en_paul_neutral');
    expect(selectVoice(tts, null)).toBe('en_paul_neutral');
    expect(selectVoice(undefined, 'de')).toBeUndefined();
    expect(resolveUpstream({ provider: 'mistral', tts }, { language: 'de' }).voice).toBe(
      'german-voice'
    );
  });
});

describe('Mistral TTS provider', () => {
  test('converts float32 samples to 16-bit PCM across odd chunk boundaries', () => {
    const floats = Buffer.alloc(16);
    [0, 1, -1, 0.5].forEach((f, i) => floats.writeFloatLE(f, i * 4));
    const convert = createFloat32ToPcm16Converter();
    const a = convert(floats.subarray(0, 6)); // one sample and half of the next
    const b = convert(floats.subarray(6));
    const pcm = Buffer.concat([a, b]);
    expect(a.length).toBe(2);
    expect(pcm.length).toBe(8);
    expect([0, 1, 2, 3].map(i => pcm.readInt16LE(i * 2))).toEqual([0, 32767, -32768, 16384]);
  });

  test('resolveUpstream falls back to the Mistral defaults', () => {
    const cfg = resolveUpstream({ id: 'x', provider: 'mistral', apiKey: 'plain-key' });
    expect(cfg).toEqual({
      url: 'https://api.mistral.ai/v1/audio/speech',
      apiKey: 'plain-key',
      model: 'voxtral-mini-tts-latest',
      voice: 'en_paul_neutral'
    });
  });

  describe('against a stub speech endpoint', () => {
    let server;
    let url;
    let handler;
    const requests = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          requests.push({ headers: req.headers, body: JSON.parse(body || '{}') });
          handler(req, res);
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${server.address().port}/v1/audio/speech`;
    });

    afterAll(() => new Promise(resolve => server.close(resolve)));

    beforeEach(() => {
      requests.length = 0;
    });

    const floatAudio = values => {
      const buf = Buffer.alloc(values.length * 4);
      values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
      return buf.toString('base64');
    };
    const cfg = () => ({ url, apiKey: 'test-key', model: 'voxtral-mini-tts-latest', voice: 'v1' });

    test('streams the PCM of every delta and returns the usage', async () => {
      handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = values =>
          `event: speech.audio.delta\ndata: ${JSON.stringify({
            type: 'speech.audio.delta',
            audio_data: floatAudio(values)
          })}\n\n`;
        res.write(delta([0, 0.5]));
        res.write(delta([-0.5]));
        res.end(
          `event: speech.audio.done\ndata: ${JSON.stringify({
            type: 'speech.audio.done',
            usage: { total_tokens: 3 }
          })}\n\n`
        );
      };
      const chunks = [];
      const { usage } = await synthesize({
        cfg: cfg(),
        text: 'Hello',
        onAudio: pcm => chunks.push(pcm)
      });
      expect(usage).toEqual({ total_tokens: 3 });
      const pcm = Buffer.concat(chunks);
      expect(pcm.length).toBe(6);
      expect(pcm.readInt16LE(2)).toBe(16384);
      expect(requests[0].headers.authorization).toBe('Bearer test-key');
      expect(requests[0].body).toEqual({
        model: 'voxtral-mini-tts-latest',
        input: 'Hello',
        voice_id: 'v1',
        response_format: 'pcm',
        stream: true
      });
    });

    test('names a rejected key without echoing the upstream body', async () => {
      handler = (req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Unauthorized' }));
      };
      await expect(synthesize({ cfg: cfg(), text: 'Hi', onAudio: () => {} })).rejects.toMatchObject(
        { name: 'TtsUpstreamError', status: 401, message: expect.stringMatching(/API key/) }
      );
    });

    test('reports the upstream message on other errors', async () => {
      handler = (req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Voice not found' }));
      };
      await expect(synthesize({ cfg: cfg(), text: 'Hi', onAudio: () => {} })).rejects.toThrow(
        /HTTP 400.*Voice not found/
      );
    });

    test('an error event in the stream rejects', async () => {
      handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ type: 'error', error: { message: 'boom' } })}\n\n`);
      };
      await expect(synthesize({ cfg: cfg(), text: 'Hi', onAudio: () => {} })).rejects.toThrow(
        /boom/
      );
    });

    test('lists every page of voices', async () => {
      handler = (req, res) => {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                id: `v${page}`,
                slug: `s${page}`,
                name: `Voice ${page}`,
                languages: ['de'],
                type: page === 2 ? 'custom' : 'preset',
                extra: 'dropped'
              }
            ],
            total_pages: 2
          })
        );
      };
      const voices = await listVoices(cfg());
      expect(voices).toEqual([
        { id: 'v1', slug: 's1', name: 'Voice 1', languages: ['de'], gender: null, type: 'preset' },
        { id: 'v2', slug: 's2', name: 'Voice 2', languages: ['de'], gender: null, type: 'custom' }
      ]);
      expect(requests[0].headers.authorization).toBe('Bearer test-key');
    });

    test('creates a voice from a sample and deletes it again', async () => {
      handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          req.method === 'POST'
            ? JSON.stringify({ id: 'new-id', name: 'Anna', languages: ['de'], type: 'custom' })
            : JSON.stringify({ deleted: true })
        );
      };
      const voice = await createVoice(cfg(), {
        name: 'Anna',
        audio: Buffer.from('RIFF'),
        filename: 'anna.wav',
        languages: ['de'],
        gender: 'female'
      });
      expect(voice).toMatchObject({ id: 'new-id', name: 'Anna', type: 'custom' });
      expect(requests[0].body).toEqual({
        name: 'Anna',
        sample_audio: Buffer.from('RIFF').toString('base64'),
        sample_filename: 'anna.wav',
        languages: ['de'],
        gender: 'female'
      });
      await deleteVoice(cfg(), 'new-id');
      expect(requests).toHaveLength(2);
    });

    test('derives the voices endpoint from the speech URL', () => {
      expect(voicesUrl({ url: 'https://api.mistral.ai/v1/audio/speech' })).toBe(
        'https://api.mistral.ai/v1/audio/voices'
      );
      expect(voicesUrl({ url: 'https://proxy.example.com/mistral/tts' })).toBe(
        'https://proxy.example.com/v1/audio/voices'
      );
    });

    test('refuses to call out without an API key', async () => {
      await expect(
        synthesize({ cfg: { ...cfg(), apiKey: '' }, text: 'Hi', onAudio: () => {} })
      ).rejects.toThrow(/No Mistral API key/);
      expect(requests).toHaveLength(0);
    });
  });
});
