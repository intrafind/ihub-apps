/**
 * Voice mode (issue #2868): the speech queue turns a streaming answer into
 * ordered, gap-free speech. Web Audio and `fetch` are replaced by fakes: the
 * audio context records what was scheduled and when, and every speech request
 * is answered by hand, so the tests decide which response arrives first.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));

const mockFetch = jest.fn();
jest.mock('../../../client/src/shared/utils/openSseStream', () => ({
  fetchWithAuthRetry: (...args) => mockFetch(...args)
}));

import { createSpeechQueue } from '../../../client/src/features/voice/utils/speechQueue';
import { createSpeakableChunker } from '../../../client/src/features/voice/utils/speakableChunker';

const RATE = 24000;
let contexts = [];

class FakeSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.onended = null;
  }
  connect() {}
  start(when) {
    this.startAt = when;
    this.ctx.started.push(this);
  }
  stop() {
    this.stopped = true;
  }
  finish() {
    this.ctx.currentTime = Math.max(this.ctx.currentTime, this.startAt + this.buffer.duration);
    this.onended?.();
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.started = [];
    this.resume = jest.fn(() => {
      this.state = 'running';
      return Promise.resolve();
    });
    contexts.push(this);
  }
  createBuffer(channels, length, sampleRate) {
    return { length, sampleRate, duration: length / sampleRate, copyToChannel: jest.fn() };
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** `seconds` of 16-bit PCM as one Uint8Array. */
const pcm = seconds => new Uint8Array(Math.round(seconds * RATE) * 2);

/** A response body the test feeds by hand: `push`, `end`, `fail`. */
function controlledBody() {
  const queue = [];
  let wake = null;
  let ended = false;
  let failure = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    body: {
      getReader: () => ({
        read: async () => {
          for (;;) {
            if (queue.length) return { done: false, value: queue.shift() };
            if (failure) throw failure;
            if (ended) return { done: true, value: undefined };
            await new Promise(resolve => {
              wake = resolve;
            });
          }
        }
      })
    },
    push(bytes) {
      queue.push(bytes);
      poke();
    },
    end() {
      ended = true;
      poke();
    },
    fail(error) {
      failure = error;
      poke();
    }
  };
}

/** Every speech request the queue made; the test answers each by hand. */
let requests = [];

mockFetch.mockImplementation(
  (url, init) =>
    new Promise((resolve, reject) => {
      const request = {
        url,
        init,
        body: JSON.parse(init.body),
        signal: init.signal,
        resolve,
        reject,
        stream: null,
        /** Headers arrive; the audio follows via `request.stream`. */
        respond({ language, rate = RATE } = {}) {
          request.stream = controlledBody();
          const headers = {
            'X-Audio-Sample-Rate': String(rate),
            ...(language ? { 'X-Speech-Language': language } : {})
          };
          resolve({
            ok: true,
            status: 200,
            headers: { get: name => headers[name] ?? null },
            body: request.stream.body
          });
          return request.stream;
        },
        /** Headers and the whole audio at once. */
        complete(seconds, opts) {
          const stream = request.respond(opts);
          stream.push(pcm(seconds));
          stream.end();
        },
        fail(status, error, code) {
          resolve({ ok: false, status, json: async () => ({ error, code }) });
        }
      };
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      );
      requests.push(request);
    })
);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Let every scheduled source finish, as the clock runs. */
function playToEnd(ctx) {
  for (let i = 0; i < 1000; i++) {
    const pending = ctx.started.find(s => !s.done);
    if (!pending) return;
    pending.done = true;
    pending.finish();
  }
}

const round = n => Math.round(n * 100) / 100;
const durations = ctx => ctx.started.map(s => round(s.buffer.duration));
const totalSeconds = ctx => ctx.started.reduce((n, s) => n + s.buffer.duration, 0);

function expectBackToBack(ctx) {
  for (let i = 1; i < ctx.started.length; i++) {
    const prev = ctx.started[i - 1];
    expect(ctx.started[i].startAt).toBeCloseTo(prev.startAt + prev.buffer.duration, 6);
  }
}

/** A queue whose chunker cuts at every sentence, so "One. Two. " is two chunks. */
function makeQueue(opts = {}) {
  const events = [];
  const queue = createSpeechQueue({
    chunker: createSpeakableChunker({ firstMinChars: 1, laterMinChars: 1 }),
    onSpeakingStart: () => events.push('speaking'),
    onDrained: () => events.push('drained'),
    onError: error => events.push(`error:${error.message}`),
    onTiming: (stage, ms) => events.push(`timing:${stage}:${typeof ms}`),
    ...opts
  });
  return { queue, events, ctx: contexts[contexts.length - 1] };
}

beforeEach(() => {
  contexts = [];
  requests = [];
  window.AudioContext = FakeAudioContext;
  mockFetch.mockClear();
});

describe('the audio context', () => {
  test('is created and resumed synchronously, before anything is spoken', () => {
    createSpeechQueue({});
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('throws where Web Audio is missing', () => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
    expect(() => createSpeechQueue({})).toThrow(/not supported/);
  });

  test('serves every answer and survives draining and interrupts', async () => {
    const { queue, ctx, events } = makeQueue();
    queue.update('First answer. ', { final: true });
    await flush();
    requests[0].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events).toContain('drained');
    expect(ctx.state).toBe('running');

    queue.update('Second answer. ', { final: true });
    await flush();
    requests[1].complete(0.5);
    await flush();
    queue.interrupt();
    expect(ctx.state).toBe('running');

    queue.update('Third answer. ', { final: true });
    await flush();
    requests[2].complete(0.5);
    await flush();

    expect(contexts).toHaveLength(1);
    expect(ctx.started).toHaveLength(3);
  });

  test('resumes a suspended context when an answer starts', async () => {
    const { queue, ctx } = makeQueue();
    ctx.state = 'suspended';
    ctx.resume.mockClear();
    queue.update('Hello there. ');
    expect(ctx.resume).toHaveBeenCalled();
  });

  test('dispose closes it, and the queue ignores everything afterwards', async () => {
    const { queue, ctx, events } = makeQueue();
    queue.update('Hello there. ');
    await flush();
    queue.dispose();
    expect(ctx.state).toBe('closed');
    expect(requests[0].signal.aborted).toBe(true);

    queue.update('More text. ', { final: true });
    queue.say('Still here?');
    queue.interrupt();
    queue.dispose();
    await flush();
    expect(requests).toHaveLength(1);
    expect(events).not.toContain('drained');
  });
});

describe('requests', () => {
  test('a chunk is a POST to /voice/speech with the model, language and voice', async () => {
    const { queue } = makeQueue({ modelId: 'voxtral-tts', language: 'de', voice: 'anna' });
    queue.update('Hallo zusammen. Wie geht es dir? ');
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/voice/speech');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0].body).toEqual({
      text: 'Hallo zusammen.',
      modelId: 'voxtral-tts',
      language: 'de',
      voice: 'anna'
    });
  });

  test('omits what is not set', async () => {
    const { queue } = makeQueue({ modelId: '', voice: undefined });
    queue.update('Hello there. ');
    await flush();
    expect(requests[0].body).toEqual({ text: 'Hello there.' });
  });

  test('requests only chunks that are complete, as the text grows', async () => {
    const { queue } = makeQueue();
    queue.update('The first sentence is');
    await flush();
    expect(requests).toHaveLength(0);
    queue.update('The first sentence is here. And the sec');
    await flush();
    expect(requests.map(r => r.body.text)).toEqual(['The first sentence is here.']);
  });

  test('a chunk with markdown is sent raw: the server strips it', async () => {
    const { queue } = makeQueue();
    queue.update('**Bold** and [a link](https://x.org). ');
    await flush();
    expect(requests[0].body.text).toBe('**Bold** and [a link](https://x.org).');
  });
});

describe('language', () => {
  test('the first response pins its language for the rest of the answer', async () => {
    const { queue } = makeQueue({ language: 'en' });
    queue.update('One sentence. Two sentences. Three sentences. ', { final: true });
    await flush();

    // Until the first response names the language, no second request goes out.
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ text: 'One sentence.', language: 'en' });

    requests[0].respond({ language: 'de' });
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toEqual({
      text: 'Two sentences.',
      language: 'de',
      languageFixed: true
    });

    requests[0].stream.end();
    await flush();
    expect(requests[2].body).toEqual({
      text: 'Three sentences.',
      language: 'de',
      languageFixed: true
    });
  });

  test('a response without the header leaves the UI hint in place', async () => {
    const { queue } = makeQueue({ language: 'en' });
    queue.update('One sentence. Two sentences. ', { final: true });
    await flush();
    requests[0].respond();
    await flush();
    expect(requests[1].body).toEqual({ text: 'Two sentences.', language: 'en' });
  });

  test('a failed first chunk does not pin anything: the next chunk probes', async () => {
    const { queue } = makeQueue({ language: 'en' });
    queue.update('One sentence. Two sentences. Three sentences. ', { final: true });
    await flush();
    requests[0].fail(500, 'Provider down');
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toEqual({ text: 'Two sentences.', language: 'en' });
    // Only one probe at a time.
    expect(requests).toHaveLength(2);
    requests[1].respond({ language: 'fr' });
    await flush();
    expect(requests[2].body).toMatchObject({ language: 'fr', languageFixed: true });
  });

  test('a new answer starts over with the UI language', async () => {
    const { queue, ctx } = makeQueue({ language: 'en' });
    queue.update('Answer one. ', { final: true });
    await flush();
    requests[0].complete(0.2, { language: 'de' });
    await flush();
    playToEnd(ctx);

    queue.update('Answer two. ', { final: true });
    await flush();
    expect(requests[1].body).toEqual({ text: 'Answer two.', language: 'en' });
  });
});

describe('in-flight cap', () => {
  const text = 'Alpha one. Beta two. Gamma three. Delta four. Epsilon five. ';

  test('at most two requests are in flight', async () => {
    const { queue } = makeQueue();
    queue.update(text, { final: true });
    await flush();
    expect(requests).toHaveLength(1);

    const first = requests[0].respond({ language: 'en' });
    await flush();
    expect(requests).toHaveLength(2);

    // Chunk 2 answered and received in full: still chunk 1 in flight, so no third.
    requests[1].complete(0.3);
    await flush();
    expect(requests).toHaveLength(3);

    first.push(pcm(0.3));
    first.end();
    await flush();
    expect(requests).toHaveLength(4);
  });

  test('a request is only freed once its audio is fully received', async () => {
    const { queue } = makeQueue();
    queue.update(text, { final: true });
    await flush();
    requests[0].respond({ language: 'en' });
    await flush();
    const second = requests[1].respond();
    second.push(pcm(0.3));
    await flush();
    // Both responses are open (headers in, bodies streaming).
    expect(requests).toHaveLength(2);
    second.end();
    await flush();
    expect(requests).toHaveLength(3);
  });

  test('maxInFlight is configurable', async () => {
    const { queue } = makeQueue({ maxInFlight: 3 });
    queue.update(text, { final: true });
    await flush();
    requests[0].respond({ language: 'en' });
    await flush();
    expect(requests).toHaveLength(3);
    requests[0].stream.end();
    await flush();
    expect(requests).toHaveLength(4);
  });

  test('a cap of one runs the chunks one after the other', async () => {
    const { queue } = makeQueue({ maxInFlight: 1 });
    queue.update(text, { final: true });
    await flush();
    requests[0].complete(0.3, { language: 'en' });
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].body.languageFixed).toBe(true);
  });
});

describe('playback order', () => {
  test('chunks play in order and gap-free, even when a later one is received first', async () => {
    const { queue, ctx } = makeQueue({ maxInFlight: 3 });
    queue.update('One. Two. Three. ', { final: true });
    await flush();
    const first = requests[0].respond({ language: 'en' });
    await flush();
    expect(requests).toHaveLength(3);

    // Chunks 3 and 2 arrive in full before chunk 1 has delivered a single byte.
    requests[2].complete(1.5);
    await flush();
    requests[1].complete(1);
    await flush();
    expect(ctx.started).toHaveLength(0);

    first.push(pcm(0.5));
    first.end();
    await flush();
    expect(durations(ctx)).toEqual([0.5, 1, 1.5]);
    expectBackToBack(ctx);
  });

  test('with the default cap: chunk 2 received while chunk 1 is still streaming', async () => {
    const { queue, ctx } = makeQueue();
    queue.update('One. Two. ', { final: true });
    await flush();
    const first = requests[0].respond({ language: 'en' });
    first.push(pcm(0.5));
    await flush();
    requests[1].complete(0.5);
    await flush();
    // Chunk 1's first half plays; chunk 2 waits for chunk 1 to finish.
    expect(totalSeconds(ctx)).toBeCloseTo(0.5, 3);
    first.push(pcm(0.5));
    first.end();
    await flush();
    expect(totalSeconds(ctx)).toBeCloseTo(1.5, 3);
    expectBackToBack(ctx);
  });

  test('a skipped chunk in the middle leaves no gap', async () => {
    const { queue, ctx } = makeQueue({ maxInFlight: 3 });
    queue.update('One. Two. Three. ', { final: true });
    await flush();
    requests[0].respond({ language: 'en' });
    await flush();
    requests[1].fail(500, 'boom');
    requests[2].complete(1);
    requests[0].stream.push(pcm(0.5));
    requests[0].stream.end();
    await flush();
    expect(durations(ctx)).toEqual([0.5, 1]);
    expectBackToBack(ctx);
  });
});

describe('callbacks', () => {
  test('onSpeakingStart fires once, when the first audio is scheduled', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('One. Two. ', { final: true });
    await flush();
    expect(events).not.toContain('speaking');

    const first = requests[0].respond({ language: 'en' });
    await flush();
    // Headers are not audio.
    expect(events).not.toContain('speaking');

    first.push(pcm(0.5));
    first.end();
    await flush();
    expect(events.filter(e => e === 'speaking')).toHaveLength(1);
    expect(ctx.started.length).toBeGreaterThan(0);

    requests[1].complete(0.5);
    await flush();
    expect(events.filter(e => e === 'speaking')).toHaveLength(1);
  });

  test('onDrained fires after the final text was seen and everything has played', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('One. Two. ', { final: true });
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    requests[1].complete(0.5);
    await flush();
    expect(events).not.toContain('drained');
    expect(queue.isSpeaking()).toBe(true);

    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
    expect(events.indexOf('speaking')).toBeLessThan(events.indexOf('drained'));
    expect(queue.isSpeaking()).toBe(false);
  });

  test('nothing drains before the final text, however much has played', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('One. Two. ');
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    playToEnd(ctx);
    expect(events).not.toContain('drained');

    // The rest of the answer arrives later and is spoken after the pause.
    queue.update('One. Two. Three. ', { final: true });
    await flush();
    requests[1].complete(0.5);
    await flush();
    requests[2].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
    expect(totalSeconds(ctx)).toBeCloseTo(1.5, 3);
  });

  test('the final flush of unfinished text is spoken', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('Done. And the rest without a full stop');
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    queue.update('Done. And the rest without a full stop', { final: true });
    await flush();
    expect(requests[1].body.text).toBe('And the rest without a full stop');
    requests[1].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events).toContain('drained');
  });

  test('a repeated final does not speak anything twice', async () => {
    const { queue, ctx } = makeQueue();
    queue.update('Once. ', { final: true });
    queue.update('Once. ', { final: true });
    await flush();
    expect(requests).toHaveLength(1);
    requests[0].complete(0.5);
    await flush();
    queue.update('Once. ', { final: true });
    await flush();
    expect(requests).toHaveLength(1);
    playToEnd(ctx);
  });

  test('onTiming reports the first chunk and the first audio, in milliseconds since the start', async () => {
    let clock = 1000;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const timings = [];
      const { queue } = makeQueue({ onTiming: (stage, ms) => timings.push([stage, ms]) });
      queue.update('Not yet');
      clock = 1100;
      queue.update('Not yet done. More', {});
      await flush();
      clock = 1450;
      const stream = requests[0].respond({ language: 'en' });
      stream.push(pcm(0.5));
      await flush();
      expect(timings).toEqual([
        ['firstChunk', 100],
        ['firstAudio', 450]
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a callback that throws does not stall the audio', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { queue, ctx } = makeQueue({
        onSpeakingStart: () => {
          throw new Error('listener bug');
        },
        onTiming: () => {
          throw new Error('timing bug');
        }
      });
      queue.update('One. Two. ', { final: true });
      await flush();
      requests[0].complete(0.5, { language: 'en' });
      await flush();
      requests[1].complete(0.5);
      await flush();
      expect(totalSeconds(ctx)).toBeCloseTo(1, 3);
    } finally {
      spy.mockRestore();
    }
  });

  test('a final with nothing to read drains at once', () => {
    const { queue, events } = makeQueue();
    queue.update('', { final: true });
    expect(events).toContain('drained');
    expect(events).not.toContain('speaking');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  test('a failed chunk is reported and skipped, and the queue goes on', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('One. Two. Three. ', { final: true });
    await flush();
    requests[0].respond({ language: 'en' });
    requests[0].stream.push(pcm(0.5));
    requests[0].stream.end();
    await flush();
    requests[1].fail(502, 'Provider unavailable', 'no-audio');
    await flush();
    requests[2].complete(0.5);
    await flush();

    expect(events.filter(e => e.startsWith('error:'))).toEqual(['error:Provider unavailable']);
    expect(durations(ctx)).toEqual([0.5, 0.5]);
    playToEnd(ctx);
    expect(events).toContain('drained');
  });

  test('onError gets the HTTP status and code of the failure', async () => {
    const errors = [];
    const { queue } = makeQueue({ onError: error => errors.push(error) });
    queue.update('One. ', { final: true });
    await flush();
    requests[0].fail(429, 'Too many requests', 'rate-limited');
    await flush();
    expect(errors[0]).toMatchObject({
      message: 'Too many requests',
      status: 429,
      code: 'rate-limited'
    });
  });

  test('a network failure is reported', async () => {
    const { queue, events } = makeQueue();
    queue.update('One. Two. ', { final: true });
    await flush();
    requests[0].reject(new TypeError('Failed to fetch'));
    await flush();
    expect(events).toContain('error:Failed to fetch');
    // The queue carries on with the next chunk.
    expect(requests).toHaveLength(2);
  });

  test('a stream cut off midway plays what arrived and is reported', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('One. Two. ', { final: true });
    await flush();
    const first = requests[0].respond({ language: 'en' });
    first.push(pcm(0.5));
    first.fail(new TypeError('connection reset'));
    await flush();
    requests[1].complete(0.5);
    await flush();
    expect(events).toContain('error:connection reset');
    expect(durations(ctx)).toEqual([0.5, 0.5]);
  });

  test('a chunk with nothing to read (422 no-speakable-text) is skipped silently', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('| a | b |\n|---|---|\n| 1 | 2 |\n\nThen words. ', { final: true });
    await flush();
    expect(requests[0].body.text).toContain('| a | b |');
    requests[0].fail(422, 'Nothing to read aloud', 'no-speakable-text');
    await flush();
    requests[1].complete(0.5, { language: 'en' });
    await flush();

    expect(events.filter(e => e.startsWith('error:'))).toEqual([]);
    expect(durations(ctx)).toEqual([0.5]);
    playToEnd(ctx);
    expect(events).toContain('drained');
  });

  test('when every chunk fails the answer still drains, without ever speaking', async () => {
    const { queue, events } = makeQueue();
    queue.update('One. Two. ', { final: true });
    await flush();
    requests[0].fail(500, 'down');
    await flush();
    requests[1].fail(500, 'down');
    await flush();
    expect(events.filter(e => e.startsWith('error:'))).toHaveLength(2);
    expect(events).not.toContain('speaking');
    expect(events).toContain('drained');
    expect(queue.isSpeaking()).toBe(false);
  });
});

describe('interrupt', () => {
  test('aborts every request in flight, stops the audio and drops what is queued', async () => {
    const { queue, events, ctx } = makeQueue({ maxInFlight: 2 });
    queue.update('One. Two. Three. Four. ', { final: true });
    await flush();
    const first = requests[0].respond({ language: 'en' });
    first.push(pcm(1));
    await flush();
    // Chunk 2 is requested and still waiting for its response; 3 and 4 are queued.
    expect(requests).toHaveLength(2);
    expect(ctx.started.length).toBeGreaterThan(0);
    expect(queue.isSpeaking()).toBe(true);

    queue.interrupt();
    expect(requests.every(r => r.signal.aborted)).toBe(true);
    expect(ctx.started.every(s => s.stopped)).toBe(true);
    expect(ctx.state).toBe('running');
    expect(queue.isSpeaking()).toBe(false);

    await flush();
    // The queued chunks were never requested; nothing was reported or drained.
    expect(requests).toHaveLength(2);
    expect(events.filter(e => e.startsWith('error:'))).toEqual([]);
    expect(events).not.toContain('drained');
  });

  test('a request still waiting for its response is aborted without an error', async () => {
    const { queue, events } = makeQueue();
    queue.update('One. ', { final: true });
    await flush();
    expect(requests[0].signal.aborted).toBe(false);
    queue.interrupt();
    await flush();
    expect(requests[0].signal.aborted).toBe(true);
    expect(events.filter(e => e.startsWith('error:'))).toEqual([]);
  });

  test('stops the audio at once, not when the buffers end', async () => {
    const { queue, ctx } = makeQueue();
    queue.update('One. ', { final: true });
    await flush();
    requests[0].complete(5, { language: 'en' });
    await flush();
    const sources = [...ctx.started];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some(s => s.stopped)).toBe(false);

    queue.interrupt();
    expect(sources.every(s => s.stopped)).toBe(true);
    // A late `ended` event of a stopped source does nothing.
    sources.forEach(s => s.onended?.());
    expect(queue.isSpeaking()).toBe(false);
  });

  test('late data of an aborted response is ignored', async () => {
    const { queue, ctx } = makeQueue();
    queue.update('One. ', { final: true });
    await flush();
    const stream = requests[0].respond({ language: 'en' });
    await flush();
    queue.interrupt();
    stream.push(pcm(1));
    stream.end();
    await flush();
    expect(ctx.started).toHaveLength(0);
  });

  test('the next answer after an interrupt starts clean on the same context', async () => {
    const { queue, events, ctx } = makeQueue({ language: 'en' });
    queue.update('Old one. Old two. ', { final: true });
    await flush();
    requests[0].respond({ language: 'de' });
    await flush();
    queue.interrupt();

    queue.update('New one. New two. ', { final: true });
    await flush();
    // No pinned language from the interrupted answer.
    expect(requests[2].body).toEqual({ text: 'New one.', language: 'en' });
    requests[2].complete(0.5, { language: 'fr' });
    await flush();
    requests[3].complete(0.5);
    await flush();
    expect(requests[3].body).toMatchObject({
      text: 'New two.',
      language: 'fr',
      languageFixed: true
    });
    expect(durations(ctx)).toEqual([0.5, 0.5]);
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
    expect(contexts).toHaveLength(1);
  });

  test('the chunker starts over: the first chunk of the new answer is short again', async () => {
    const queue = createSpeechQueue({
      chunker: createSpeakableChunker({ firstMinChars: 10, laterMinChars: 100 })
    });
    queue.update('A sentence that is long enough. Another one follows. ');
    await flush();
    expect(requests[0].body.text).toBe('A sentence that is long enough.');
    queue.interrupt();
    queue.update('Fresh text for you. ');
    await flush();
    expect(requests[1].body.text).toBe('Fresh text for you.');
  });

  test('interrupt while idle does nothing', () => {
    const { queue, events } = makeQueue();
    expect(() => queue.interrupt()).not.toThrow();
    expect(events).toEqual([]);
  });

  test('the audible stop needs no round trip: it is synchronous', async () => {
    const { queue, ctx } = makeQueue();
    queue.update('One. ', { final: true });
    await flush();
    requests[0].complete(3, { language: 'en' });
    await flush();
    const before = Date.now();
    queue.interrupt();
    expect(ctx.started.every(s => s.stopped)).toBe(true);
    expect(Date.now() - before).toBeLessThan(100);
  });
});

describe('say()', () => {
  test('alone it is a whole answer: spoken, then drained', async () => {
    const { queue, events, ctx } = makeQueue({ language: 'de' });
    queue.say('  Das hat leider nicht geklappt.  ');
    await flush();
    expect(requests[0].body).toEqual({ text: 'Das hat leider nicht geklappt.', language: 'de' });
    requests[0].complete(0.5, { language: 'de' });
    await flush();
    expect(events).toContain('speaking');
    expect(events).not.toContain('drained');
    playToEnd(ctx);
    expect(events).toContain('drained');
  });

  test('inside a streamed answer it is spoken in order and does not end the answer', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('First sentence. Second sentence');
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();

    queue.say('Which file do you mean?');
    await flush();
    expect(requests[1].body).toEqual({
      text: 'Which file do you mean?',
      language: 'en',
      languageFixed: true
    });
    requests[1].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events).not.toContain('drained');

    queue.update('First sentence. Second sentence done. ', { final: true });
    await flush();
    requests[2].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
    expect(durations(ctx)).toEqual([0.5, 0.5, 0.5]);
  });

  test('a streamed answer may follow a say() that opened it', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.say('One moment please.');
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    queue.update('Here is the answer. ', { final: true });
    await flush();
    requests[1].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
    expect(requests.map(r => r.body.text)).toEqual(['One moment please.', 'Here is the answer.']);
  });

  test('say(…, { final: true }) ends an answer that has no final text (a chat error)', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('Half an ans');
    queue.update('Half an answer. And then it broke', {});
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    queue.say('Sorry, something went wrong.', { final: true });
    await flush();
    requests[1].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
  });

  test('a say() after the final text, while the audio still plays, joins the answer', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('Main answer. ', { final: true });
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    expect(ctx.started.length).toBeGreaterThan(0);

    queue.say('And one more thing.');
    await flush();
    requests[1].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);
    expect(durations(ctx)).toEqual([0.5, 0.5]);
    expectBackToBack(ctx);
  });

  test('a say() after everything has played is a new answer', async () => {
    const { queue, events, ctx } = makeQueue();
    queue.update('Main answer. ', { final: true });
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(1);

    queue.say('A new message.');
    await flush();
    requests[1].complete(0.5);
    await flush();
    playToEnd(ctx);
    expect(events.filter(e => e === 'drained')).toHaveLength(2);
    expect(events.filter(e => e === 'speaking')).toHaveLength(2);
  });

  test('empty text is ignored', async () => {
    const { queue, events } = makeQueue();
    queue.say('   ');
    queue.say('');
    queue.say(undefined);
    await flush();
    expect(requests).toHaveLength(0);
    expect(events).toEqual([]);
  });

  test('a say() is cut by an interrupt like everything else', async () => {
    const { queue, ctx } = makeQueue();
    queue.say('Please wait.');
    await flush();
    requests[0].complete(2, { language: 'en' });
    await flush();
    queue.interrupt();
    expect(ctx.started.every(s => s.stopped)).toBe(true);
  });
});

describe('isSpeaking', () => {
  test('is false when idle, true while chunks are pending or audio plays', async () => {
    const { queue, ctx } = makeQueue();
    expect(queue.isSpeaking()).toBe(false);
    queue.update('One. ', { final: true });
    expect(queue.isSpeaking()).toBe(true);
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    expect(queue.isSpeaking()).toBe(true);
    playToEnd(ctx);
    expect(queue.isSpeaking()).toBe(false);
  });

  test('is false while the text streams and nothing has been cut yet', () => {
    const { queue } = makeQueue();
    queue.update('The first sentence is still comi');
    expect(queue.isSpeaking()).toBe(false);
  });

  test('is false between chunks once the audio so far has played, and the text is not final', async () => {
    const { queue, ctx } = makeQueue();
    queue.update('One. Two');
    await flush();
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    playToEnd(ctx);
    expect(queue.isSpeaking()).toBe(false);
  });
});

describe('the default chunker', () => {
  test('the first chunk is short, so audio starts early', async () => {
    const queue = createSpeechQueue({});
    const first = 'This is the first sentence of the answer.';
    const words = ['apples', 'bananas', 'cherries', 'dates', 'elderberries', 'figs', 'grapes'];
    const rest = words.flatMap(word => [
      `Another sentence about ${word} follows here.`,
      `And a second one about ${word} too.`
    ]);
    queue.update(`${first} ${rest.join(' ')} `);
    await flush();
    expect(requests[0].body.text).toBe(first);
    requests[0].complete(0.5, { language: 'en' });
    await flush();
    // The second chunk collects sentences up to its minimum length.
    expect(requests[1].body.text.length).toBeGreaterThanOrEqual(250);
    expect(requests[1].body.text.startsWith('Another sentence about apples')).toBe(true);
  });
});
