/**
 * Read aloud (issue #2642): the streaming PCM player and the shared playback
 * store behind every message's play button.
 *
 * Web Audio is replaced by a fake context that records what was scheduled
 * when, so the tests can check that streamed audio plays gap-free, is only
 * decoded a bounded distance ahead, pauses and resumes, ends, and replays a
 * finished message from memory without a second request.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));

const mockFetch = jest.fn();
jest.mock('../../../client/src/shared/utils/openSseStream', () => ({
  fetchWithAuthRetry: (...args) => mockFetch(...args)
}));

import PcmStreamPlayer, {
  pcm16ToFloat32
} from '../../../client/src/features/voice/utils/pcmStreamPlayer';
import * as readAloud from '../../../client/src/features/voice/utils/readAloud';

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
  /** Simulate the browser finishing this buffer. */
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
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
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

/** A fetch Response whose body yields `chunks`, then ends (or throws `error`). */
function streamResponse(chunks, { error } = {}) {
  const queue = [...chunks];
  return {
    ok: true,
    status: 200,
    headers: { get: name => (name === 'X-Audio-Sample-Rate' ? String(RATE) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (queue.length) return { done: false, value: queue.shift() };
          if (error) throw error;
          return { done: true, value: undefined };
        }
      })
    }
  };
}

/** Let every scheduled source finish, as the clock runs. */
function playToEnd(ctx) {
  for (let i = 0; i < 1000; i++) {
    const pending = ctx.started.find(s => !s.done);
    if (!pending) return;
    pending.done = true;
    pending.finish();
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  contexts = [];
  window.AudioContext = FakeAudioContext;
  mockFetch.mockReset();
  readAloud.stop();
});

describe('pcm16ToFloat32', () => {
  test('maps little-endian int16 to [-1, 1)', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40, 0x01]);
    expect(Array.from(pcm16ToFloat32(bytes))).toEqual([0, 32767 / 32768, -1, 0.5]);
  });
});

describe('PcmStreamPlayer', () => {
  test('schedules streamed audio back to back and ends after the last buffer', async () => {
    const states = [];
    const player = new PcmStreamPlayer({ onStateChange: s => states.push(s) });
    await player.start(async () => streamResponse([pcm(0.4), pcm(0.4), pcm(1)]));
    const ctx = contexts[0];

    expect(ctx.started.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ctx.started.length; i++) {
      const prev = ctx.started[i - 1];
      expect(ctx.started[i].startAt).toBeCloseTo(prev.startAt + prev.buffer.duration, 6);
    }
    const total = ctx.started.reduce((n, s) => n + s.buffer.duration, 0);
    expect(total).toBeCloseTo(1.8, 3);
    expect(states).toEqual(['loading', 'playing']);

    playToEnd(ctx);
    expect(states).toEqual(['loading', 'playing', 'ended']);
    expect(ctx.state).toBe('closed');
    expect(player.getRecording().bytes).toBe(pcm(1.8).byteLength);
  });

  test('keeps bytes whose sample is split across network chunks', async () => {
    const player = new PcmStreamPlayer();
    const whole = pcm(0.5);
    await player.start(async () => streamResponse([whole.subarray(0, 4801), whole.subarray(4801)]));
    const total = contexts[0].started.reduce((n, s) => n + s.buffer.length, 0);
    expect(total).toBe(whole.byteLength / 2);
  });

  test('decodes only a bounded distance ahead of the playhead', async () => {
    const player = new PcmStreamPlayer();
    await player.start(async () => streamResponse([pcm(60)]));
    const ctx = contexts[0];
    const ahead = () => ctx.started.reduce((n, s) => n + s.buffer.duration, 0) - ctx.currentTime;
    expect(ahead()).toBeLessThanOrEqual(17);

    // As buffers finish, more is scheduled, until all 60 s have played.
    playToEnd(ctx);
    expect(ctx.started.reduce((n, s) => n + s.buffer.duration, 0)).toBeCloseTo(60, 3);
    expect(player.state).toBe('ended');
  });

  test('pauses and resumes by suspending the context', async () => {
    const states = [];
    const player = new PcmStreamPlayer({ onStateChange: s => states.push(s) });
    await player.start(async () => streamResponse([pcm(1)]));
    player.pause();
    expect(contexts[0].state).toBe('suspended');
    player.resume();
    expect(contexts[0].state).toBe('running');
    expect(states).toEqual(['loading', 'playing', 'paused', 'playing']);
  });

  test('stop aborts the request and silences what was scheduled', async () => {
    let signal;
    const player = new PcmStreamPlayer();
    await player.start(async s => {
      signal = s;
      return streamResponse([pcm(1)]);
    });
    player.stop();
    expect(signal.aborted).toBe(true);
    expect(player.state).toBe('stopped');
    expect(contexts[0].started.every(s => s.stopped)).toBe(true);
  });

  test('reports the server message of a failed request', async () => {
    const errors = [];
    const player = new PcmStreamPlayer({
      onStateChange: (s, info) => s === 'error' && errors.push(info.error)
    });
    await player.start(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Not permitted', code: 'not-permitted' })
    }));
    expect(errors[0]).toMatchObject({
      message: 'Not permitted',
      status: 403,
      code: 'not-permitted'
    });
  });

  test('an interrupted stream plays what arrived, then reports the error', async () => {
    const player = new PcmStreamPlayer();
    await player.start(async () => streamResponse([pcm(0.5)], { error: new TypeError('network') }));
    expect(player.state).toBe('playing');
    playToEnd(contexts[0]);
    expect(player.state).toBe('error');
    expect(player.getRecording()).toBeNull();
  });
});

describe('readAloud store', () => {
  test('toggle plays, pauses and resumes one message', async () => {
    mockFetch.mockResolvedValue(streamResponse([pcm(1)]));
    readAloud.toggle('m1', { text: 'Hello' });
    expect(readAloud.getPlaybackFor('m1').state).toBe('loading');
    await flush();
    expect(readAloud.getPlaybackFor('m1').state).toBe('playing');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/voice/speech',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Hello' }) })
    );

    readAloud.toggle('m1', { text: 'Hello' });
    expect(readAloud.getPlaybackFor('m1').state).toBe('paused');
    readAloud.toggle('m1', { text: 'Hello' });
    expect(readAloud.getPlaybackFor('m1').state).toBe('playing');
    expect(readAloud.getPlaybackFor('other')).toEqual({ id: null, state: 'idle', error: null });
  });

  test('playing another message stops the first', async () => {
    mockFetch.mockImplementation(async () => streamResponse([pcm(1)]));
    readAloud.play('m1', { text: 'One' });
    await flush();
    readAloud.play('m2', { text: 'Two' });
    await flush();
    expect(readAloud.getPlaybackFor('m1').state).toBe('idle');
    expect(readAloud.getPlaybackFor('m2').state).toBe('playing');
    expect(contexts[0].state).toBe('closed');
  });

  test('a finished message replays from memory without a request', async () => {
    mockFetch.mockImplementation(async () => streamResponse([pcm(0.5)]));
    readAloud.play('m1', { text: 'Replay me' });
    await flush();
    playToEnd(contexts[0]);
    expect(readAloud.getPlaybackFor('m1').state).toBe('idle');

    readAloud.play('m1', { text: 'Replay me' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(readAloud.getPlaybackFor('m1').state).toBe('playing');
  });

  test('stop(id) only stops that message', async () => {
    mockFetch.mockImplementation(async () => streamResponse([pcm(1)]));
    readAloud.play('m1', { text: 'Keep playing' });
    await flush();
    readAloud.stop('m2');
    expect(readAloud.getPlaybackFor('m1').state).toBe('playing');
    readAloud.stop('m1');
    expect(readAloud.getPlaybackFor('m1').state).toBe('idle');
  });
});
