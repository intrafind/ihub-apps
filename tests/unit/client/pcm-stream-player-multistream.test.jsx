/**
 * Voice mode (issue #2868): `PcmStreamPlayer` in multi-stream mode plays
 * several fetched streams back to back on one audio context — the pieces of one
 * spoken answer. The single-stream mode (read aloud) is covered by
 * `read-aloud-player.test.jsx`.
 */

import PcmStreamPlayer, {
  SpeechRequestError,
  createAudioContext
} from '../../../client/src/features/voice/utils/pcmStreamPlayer';

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
    contexts.push(this);
  }
  createBuffer(channels, length, sampleRate) {
    return { length, sampleRate, duration: length / sampleRate, copyToChannel: jest.fn() };
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** `seconds` of 16-bit PCM as one Uint8Array. */
const pcm = seconds => new Uint8Array(Math.round(seconds * RATE) * 2);

/** A response whose body the test feeds by hand: `push`, `end`, `fail`. */
function controlled({ rate = RATE, headers = {} } = {}) {
  const queue = [];
  let wake = null;
  let ended = false;
  let failure = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const all = { 'X-Audio-Sample-Rate': String(rate), ...headers };
  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: name => all[name] ?? null },
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
      }
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

/** A finished stream of the given lengths in seconds. */
function finished(...seconds) {
  const stream = controlled();
  for (const s of seconds) stream.push(pcm(s));
  stream.end();
  return stream;
}

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

const durations = ctx => ctx.started.map(s => s.buffer.duration);
const totalSeconds = ctx => ctx.started.reduce((n, s) => n + s.buffer.duration, 0);

function expectBackToBack(ctx) {
  for (let i = 1; i < ctx.started.length; i++) {
    const prev = ctx.started[i - 1];
    expect(ctx.started[i].startAt).toBeCloseTo(prev.startAt + prev.buffer.duration, 6);
  }
}

/** A player on a shared context, as the speech queue creates one. */
function multiPlayer(onStateChange) {
  const context = new FakeAudioContext();
  const player = new PcmStreamPlayer({ context, multiStream: true, onStateChange });
  return { context, player };
}

beforeEach(() => {
  contexts = [];
  window.AudioContext = FakeAudioContext;
});

describe('createAudioContext', () => {
  test('creates a context from the window', () => {
    expect(createAudioContext()).toBeInstanceOf(FakeAudioContext);
  });

  test('throws where Web Audio is missing', () => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
    expect(() => createAudioContext()).toThrow(/not supported/);
  });
});

describe('PcmStreamPlayer multi-stream mode', () => {
  test('plays streams back to back, gap-free, in the order they were enqueued', async () => {
    const states = [];
    const { context, player } = multiPlayer(s => states.push(s));
    const a = finished(0.5, 0.5);
    const b = finished(1);
    const c = finished(0.3);
    const results = await Promise.all([
      player.enqueueStream(async () => a.response),
      player.enqueueStream(async () => b.response),
      player.enqueueStream(async () => c.response)
    ]);
    expect(results).toEqual([{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }]);

    expectBackToBack(context);
    expect(totalSeconds(context)).toBeCloseTo(2.3, 3);
    expect(states).toEqual(['loading', 'playing']);
  });

  test('a stream that arrives early waits for the ones before it', async () => {
    const { context, player } = multiPlayer();
    const first = controlled();
    const second = finished(2);
    const third = finished(3);
    const p1 = player.enqueueStream(async () => first.response);
    const p2 = player.enqueueStream(async () => second.response);
    const p3 = player.enqueueStream(async () => third.response);
    await Promise.all([p2, p3]);
    await flush();
    // Streams 2 and 3 are complete, but nothing plays before stream 1 delivers.
    expect(context.started).toHaveLength(0);

    first.push(pcm(1));
    first.end();
    await p1;
    // 1 s, 2 s and 3 s (a buffer holds at most 2 s, so the last one is 2 + 1).
    expect(durations(context).map(d => Math.round(d * 10) / 10)).toEqual([1, 2, 2, 1]);
    expect(totalSeconds(context)).toBeCloseTo(6, 3);
    expectBackToBack(context);
  });

  test('audio of the stream playing is scheduled while it is still arriving', async () => {
    const { context, player } = multiPlayer();
    const first = controlled();
    const second = controlled();
    const p1 = player.enqueueStream(async () => first.response);
    const p2 = player.enqueueStream(async () => second.response);
    first.push(pcm(0.5));
    await flush();
    expect(totalSeconds(context)).toBeCloseTo(0.5, 3);
    // Stream 2's bytes are held back until stream 1 is complete.
    second.push(pcm(0.5));
    await flush();
    expect(totalSeconds(context)).toBeCloseTo(0.5, 3);
    first.end();
    await p1;
    expect(totalSeconds(context)).toBeCloseTo(1, 3);
    second.end();
    await p2;
    expectBackToBack(context);
  });

  test('the tail of a complete stream plays at once, without waiting for the next stream', async () => {
    const { context, player } = multiPlayer();
    // 0.1 s is below the smallest buffer scheduled while a stream is still arriving.
    await player.enqueueStream(async () => finished(0.1).response);
    expect(totalSeconds(context)).toBeCloseTo(0.1, 3);
  });

  test('the next stream starts right after the previous one, even if it comes late', async () => {
    const { context, player } = multiPlayer();
    await player.enqueueStream(async () => finished(0.5).response);
    const gapStart = context.started[0].startAt + 0.5;
    context.currentTime = 0.2;
    await player.enqueueStream(async () => finished(0.5).response);
    expect(context.started[1].startAt).toBeCloseTo(gapStart, 6);
  });

  test('onResponse gets the headers before the body is read', async () => {
    const { player } = multiPlayer();
    const stream = controlled({ headers: { 'X-Speech-Language': 'de' } });
    const seen = [];
    const done = player.enqueueStream(async () => stream.response, {
      onResponse: response => seen.push(response.headers.get('X-Speech-Language'))
    });
    await flush();
    expect(seen).toEqual(['de']);
    stream.end();
    await done;
  });

  test('a throwing onResponse does not stop the audio', async () => {
    const { context, player } = multiPlayer();
    const result = await player.enqueueStream(async () => finished(0.5).response, {
      onResponse: () => {
        throw new Error('boom');
      }
    });
    expect(result).toEqual({ status: 'ok' });
    expect(totalSeconds(context)).toBeCloseTo(0.5, 3);
  });

  test('a failed stream is skipped and the next one plays', async () => {
    const states = [];
    const { context, player } = multiPlayer(s => states.push(s));
    const results = await Promise.all([
      player.enqueueStream(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Provider down', code: 'upstream' })
      })),
      player.enqueueStream(async () => finished(0.5).response)
    ]);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toBeInstanceOf(SpeechRequestError);
    expect(results[0].error).toMatchObject({
      message: 'Provider down',
      status: 500,
      code: 'upstream'
    });
    expect(results[1]).toEqual({ status: 'ok' });
    expect(totalSeconds(context)).toBeCloseTo(0.5, 3);
    // A failed stream is no player error.
    expect(states).not.toContain('error');
  });

  test('a request that throws is an error result, not a rejection', async () => {
    const { player } = multiPlayer();
    const result = await player.enqueueStream(async () => {
      throw new TypeError('network down');
    });
    expect(result.status).toBe('error');
    expect(result.error.message).toBe('network down');
  });

  test('a failed first stream does not hold back the second', async () => {
    const { context, player } = multiPlayer();
    const second = finished(0.5);
    const p1 = player.enqueueStream(async () => {
      throw new Error('first failed');
    });
    const p2 = player.enqueueStream(async () => second.response);
    await Promise.all([p1, p2]);
    expect(totalSeconds(context)).toBeCloseTo(0.5, 3);
  });

  test('a stream interrupted midway plays what arrived and reports the error', async () => {
    const { context, player } = multiPlayer();
    const broken = controlled();
    broken.push(pcm(0.5));
    broken.fail(new TypeError('connection reset'));
    const next = finished(0.25);
    const results = await Promise.all([
      player.enqueueStream(async () => broken.response),
      player.enqueueStream(async () => next.response)
    ]);
    expect(results[0].status).toBe('error');
    expect(results[0].error.message).toBe('connection reset');
    expect(results[1].status).toBe('ok');
    expect(totalSeconds(context)).toBeCloseTo(0.75, 3);
    expectBackToBack(context);
  });

  test('an odd byte at the end of a stream does not shift the next one', async () => {
    const { context, player } = multiPlayer();
    const first = controlled();
    first.push(new Uint8Array(RATE * 2 + 1));
    first.end();
    const second = finished(1);
    await Promise.all([
      player.enqueueStream(async () => first.response),
      player.enqueueStream(async () => second.response)
    ]);
    const samples = context.started.reduce((n, s) => n + s.buffer.length, 0);
    expect(samples).toBe(RATE * 2);
  });

  test('a sample split across network chunks is kept', async () => {
    const { context, player } = multiPlayer();
    const whole = pcm(0.5);
    const stream = controlled();
    stream.push(whole.subarray(0, 4801));
    stream.push(whole.subarray(4801));
    stream.end();
    await player.enqueueStream(async () => stream.response);
    expect(context.started.reduce((n, s) => n + s.buffer.length, 0)).toBe(whole.byteLength / 2);
  });

  test('a stream with a different sample rate is rejected', async () => {
    const { context, player } = multiPlayer();
    const odd = controlled({ rate: 16000 });
    odd.push(new Uint8Array(32000));
    odd.end();
    const results = await Promise.all([
      player.enqueueStream(async () => finished(0.5).response),
      player.enqueueStream(async () => odd.response)
    ]);
    expect(results[1].status).toBe('error');
    expect(results[1].error.message).toMatch(/sample rate/);
    expect(totalSeconds(context)).toBeCloseTo(0.5, 3);
  });

  test('finish() ends the player once everything has played, and leaves a given context open', async () => {
    const states = [];
    const { context, player } = multiPlayer(s => states.push(s));
    await player.enqueueStream(async () => finished(0.5).response);
    await player.enqueueStream(async () => finished(0.5).response);
    player.finish();
    expect(states).toEqual(['loading', 'playing']);

    playToEnd(context);
    expect(states).toEqual(['loading', 'playing', 'ended']);
    expect(context.state).toBe('running');
  });

  test('without finish() the player stays alive between answers', async () => {
    const states = [];
    const { context, player } = multiPlayer(s => states.push(s));
    await player.enqueueStream(async () => finished(0.5).response);
    playToEnd(context);
    expect(states).toEqual(['loading', 'playing']);
    // More text arrived: another stream plays after the pause.
    await player.enqueueStream(async () => finished(0.5).response);
    expect(context.started).toHaveLength(2);
  });

  test('finish() waits for streams still being received', async () => {
    const states = [];
    const { context, player } = multiPlayer(s => states.push(s));
    const slow = controlled();
    const done = player.enqueueStream(async () => slow.response);
    slow.push(pcm(0.5));
    await flush();
    player.finish();
    playToEnd(context);
    expect(states).not.toContain('ended');
    slow.push(pcm(0.5));
    slow.end();
    await done;
    playToEnd(context);
    expect(states).toEqual(['loading', 'playing', 'ended']);
  });

  test('finish() with every stream failed ends silently', async () => {
    const states = [];
    const { player } = multiPlayer(s => states.push(s));
    await player.enqueueStream(async () => {
      throw new Error('nope');
    });
    player.finish();
    expect(states).toEqual(['loading', 'ended']);
  });

  test('finish() with no stream at all ends at once', () => {
    const states = [];
    const { player } = multiPlayer(s => states.push(s));
    player.finish();
    expect(states).toEqual(['ended']);
  });

  test('a stream enqueued after finish() reopens the player until it has ended', async () => {
    const states = [];
    const { context, player } = multiPlayer(s => states.push(s));
    await player.enqueueStream(async () => finished(0.5).response);
    player.finish();
    await player.enqueueStream(async () => finished(0.5).response);
    playToEnd(context);
    expect(states).toEqual(['loading', 'playing']);
    player.finish();
    expect(states).toEqual(['loading', 'playing', 'ended']);
  });

  test('a stream enqueued after the player ended is not played', async () => {
    const { context, player } = multiPlayer();
    await player.enqueueStream(async () => finished(0.5).response);
    player.finish();
    playToEnd(context);
    const request = jest.fn();
    expect(await player.enqueueStream(request)).toEqual({ status: 'aborted' });
    expect(request).not.toHaveBeenCalled();
  });

  test('stop() aborts every request in flight and stops the audio, but not a given context', async () => {
    const { context, player } = multiPlayer();
    const signals = [];
    const playing = controlled();
    playing.push(pcm(1));
    const results = [
      player.enqueueStream(async signal => {
        signals.push(signal);
        // A real response body fails its pending read when the request is aborted.
        signal.addEventListener('abort', () =>
          playing.fail(new DOMException('Aborted', 'AbortError'))
        );
        return playing.response;
      }),
      player.enqueueStream(
        signal =>
          new Promise((resolve, reject) => {
            signals.push(signal);
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    ];
    await flush();
    expect(context.started.length).toBeGreaterThan(0);

    player.stop();
    expect(signals.every(s => s.aborted)).toBe(true);
    expect(context.started.every(s => s.stopped)).toBe(true);
    expect(context.state).toBe('running');
    expect(player.state).toBe('stopped');
    const settled = await Promise.all(results);
    expect(settled.map(r => r.status)).toEqual(['aborted', 'aborted']);
  });

  test('stop() on a player with its own context closes it', async () => {
    const player = new PcmStreamPlayer({ multiStream: true });
    await player.enqueueStream(async () => finished(0.5).response);
    player.stop();
    expect(contexts[0].state).toBe('closed');
  });

  test('a player with its own context closes it when it ends', async () => {
    const player = new PcmStreamPlayer({ multiStream: true });
    await player.enqueueStream(async () => finished(0.5).response);
    player.finish();
    playToEnd(contexts[0]);
    expect(player.state).toBe('ended');
    expect(contexts[0].state).toBe('closed');
  });

  test('a given context is not resumed or closed by the player', () => {
    const context = new FakeAudioContext();
    context.state = 'suspended';
    const player = new PcmStreamPlayer({ context, multiStream: true });
    expect(context.state).toBe('suspended');
    player.stop();
    expect(context.state).toBe('suspended');
  });

  test('hasAudio() tells whether audio is scheduled', async () => {
    const { context, player } = multiPlayer();
    expect(player.hasAudio()).toBe(false);
    await player.enqueueStream(async () => finished(0.5).response);
    expect(player.hasAudio()).toBe(true);
    playToEnd(context);
    expect(player.hasAudio()).toBe(false);
  });

  test('keeps no recording: a multi-stream player plays and forgets', async () => {
    const { context, player } = multiPlayer();
    await player.enqueueStream(async () => finished(0.5).response);
    player.finish();
    playToEnd(context);
    expect(player.getRecording()).toBeNull();
  });

  test('enqueueStream needs a multi-stream player', async () => {
    const player = new PcmStreamPlayer({ context: new FakeAudioContext() });
    await expect(player.enqueueStream(async () => finished(0.5).response)).rejects.toThrow(
      /multi-stream/
    );
  });

  test('the single-stream mode is unchanged: it still ends and closes its context', async () => {
    const states = [];
    const player = new PcmStreamPlayer({ onStateChange: s => states.push(s) });
    await player.start(async () => finished(0.5).response);
    playToEnd(contexts[0]);
    expect(states).toEqual(['loading', 'playing', 'ended']);
    expect(contexts[0].state).toBe('closed');
    expect(player.getRecording().bytes).toBe(pcm(0.5).byteLength);
  });
});
