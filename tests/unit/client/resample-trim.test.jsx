/**
 * `resampleTo16kMono` with a part of the audio asked for: the `offset` and
 * `duration` an MP4/MOV edit list gives (a trimmed recording, the delay of an AAC
 * encoder). Only that part is rendered: the render is told where to start and is
 * as long as the part. Callers that ask for no part get what they always got.
 *
 * The OfflineAudioContext is a fake that remembers how it was set up and what
 * its source was told to play.
 */

import { resampleTo16kMono } from '../../../client/src/utils/realtimeTranscriptionCore';
import { isAbortError } from '../../../client/src/utils/abortable';

let offlineContexts;
let sources;
// Whether the fake engine can suspend a render, and when it did
let canSuspend;

/** A buffer of `seconds` at `sampleRate`: channel 0 counts up from 0 (its index). */
const bufferOf = (sampleRate, channels, seconds) => {
  const length = Math.round(sampleRate * seconds);
  const data = Array.from({ length: channels }, () => Float32Array.from({ length }, (_, i) => i));
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    duration: length / sampleRate,
    getChannelData: index => data[index]
  };
};

class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.shape = { channels, length, sampleRate };
    this.destination = {};
    this.suspensions = [];
    offlineContexts.push(this);
    if (canSuspend) {
      this.suspend = time => new Promise(resolve => this.suspensions.push({ time, resolve }));
      this.resume = async () => this.resumeRender?.();
    }
  }

  createBufferSource() {
    const source = {
      connect: () => {},
      start: (...args) => {
        source.startArgs = args;
      },
      disconnect: jest.fn(),
      buffer: null
    };
    sources.push(source);
    return source;
  }

  async startRendering() {
    const { channels, length, sampleRate } = this.shape;
    const ordered = [...this.suspensions].sort((a, b) => a.time - b.time);
    for (const { resolve } of ordered) {
      await new Promise(resumed => {
        this.resumeRender = resumed;
        resolve();
      });
    }
    return bufferOf(sampleRate, channels, length / sampleRate);
  }
}

beforeEach(() => {
  offlineContexts = [];
  sources = [];
  canSuspend = false;
  window.OfflineAudioContext = FakeOfflineAudioContext;
});

afterEach(() => {
  delete window.OfflineAudioContext;
});

const lengthsRendered = () => offlineContexts.map(context => context.shape.length);

describe('resampleTo16kMono without a part asked for', () => {
  test('renders all of the buffer from its start, as it always did', async () => {
    const out = await resampleTo16kMono(bufferOf(48000, 2, 2));

    expect(lengthsRendered()).toEqual([32000]);
    expect(sources[0].startArgs).toEqual([0]);
    expect(out).toHaveLength(32000);
  });

  test('null and undefined are none, so is an offset of 0 or one that is not a time', async () => {
    for (const options of [
      { offset: undefined, duration: undefined },
      { offset: null, duration: null },
      { offset: 0, duration: null },
      { offset: -3, duration: NaN },
      { offset: NaN, duration: -1 },
      { offset: 'soon', duration: 'long' }
    ]) {
      offlineContexts = [];
      sources = [];

      await resampleTo16kMono(bufferOf(48000, 2, 2), options);

      expect(lengthsRendered()).toEqual([32000]);
      expect(sources[0].startArgs).toEqual([0]);
    }
  });

  test('mono at 16 kHz is copied as it is', async () => {
    const buffer = bufferOf(16000, 1, 1);

    const out = await resampleTo16kMono(buffer);

    expect(offlineContexts).toHaveLength(0);
    expect(out).toEqual(buffer.getChannelData(0));
    expect(out).not.toBe(buffer.getChannelData(0));
  });
});

describe('resampleTo16kMono with an offset and a duration', () => {
  test('renders from the offset, for as long as the duration', async () => {
    const out = await resampleTo16kMono(bufferOf(48000, 2, 4), { offset: 0.5, duration: 1.25 });

    // The context is exactly as long as the part: 1.25 s at 16 kHz
    expect(lengthsRendered()).toEqual([20000]);
    expect(offlineContexts[0].shape).toEqual({ channels: 1, length: 20000, sampleRate: 16000 });
    expect(sources[0].startArgs).toEqual([0, 0.5, 1.25]);
    expect(out).toHaveLength(20000);
  });

  test('an offset alone goes to the end of the buffer', async () => {
    const out = await resampleTo16kMono(bufferOf(44100, 2, 2), { offset: 0.5 });

    expect(lengthsRendered()).toEqual([24000]);
    expect(sources[0].startArgs).toEqual([0, 0.5]);
    expect(out).toHaveLength(24000);
  });

  test('a duration alone starts at the start of the buffer', async () => {
    await resampleTo16kMono(bufferOf(44100, 2, 2), { duration: 0.75 });

    expect(lengthsRendered()).toEqual([12000]);
    expect(sources[0].startArgs).toEqual([0, 0, 0.75]);
  });

  test('a null duration is no limit', async () => {
    await resampleTo16kMono(bufferOf(44100, 2, 2), { offset: 1, duration: null });

    expect(lengthsRendered()).toEqual([16000]);
    expect(sources[0].startArgs).toEqual([0, 1]);
  });

  test('a duration beyond the end of the buffer is cut at its end', async () => {
    await resampleTo16kMono(bufferOf(48000, 2, 2), { offset: 1.5, duration: 10 });

    expect(lengthsRendered()).toEqual([8000]);
    expect(sources[0].startArgs).toEqual([0, 1.5]);
  });

  test('the length is rounded up to a whole frame, and is never 0 while there is something', async () => {
    await resampleTo16kMono(bufferOf(48000, 2, 2), { offset: 0, duration: 0.00001 });
    await resampleTo16kMono(bufferOf(48000, 2, 2), { duration: 1.00003 });

    expect(lengthsRendered()).toEqual([1, 16001]);
  });

  test('an offset at or past the end renders nothing and does not even set up a render', async () => {
    expect(await resampleTo16kMono(bufferOf(48000, 2, 2), { offset: 2 })).toHaveLength(0);
    expect(await resampleTo16kMono(bufferOf(48000, 2, 2), { offset: 9, duration: 1 })).toHaveLength(
      0
    );

    expect(offlineContexts).toHaveLength(0);
  });

  test('a duration of 0 renders nothing', async () => {
    const out = await resampleTo16kMono(bufferOf(48000, 2, 2), { offset: 0.5, duration: 0 });

    expect(out).toHaveLength(0);
    expect(offlineContexts).toHaveLength(0);
  });

  test('an empty buffer is still empty', async () => {
    expect(await resampleTo16kMono(bufferOf(48000, 2, 0), { offset: 1, duration: 1 })).toHaveLength(
      0
    );
  });

  test('mono at 16 kHz is cut where it is, with no render', async () => {
    const buffer = bufferOf(16000, 1, 2);

    const out = await resampleTo16kMono(buffer, { offset: 0.5, duration: 0.25 });

    expect(offlineContexts).toHaveLength(0);
    expect(out).toHaveLength(4000);
    // The samples count up from their index: these are the ones from 0.5 s on
    expect(out[0]).toBe(8000);
    expect(out[3999]).toBe(11999);
    // A copy, not a view of the buffer that is let go of afterwards
    expect(out.buffer).not.toBe(buffer.getChannelData(0).buffer);
    expect(out.buffer.byteLength).toBe(4000 * 4);
  });

  test('mono at 16 kHz with an offset alone, and with a duration beyond the end', async () => {
    const buffer = bufferOf(16000, 1, 2);

    const rest = await resampleTo16kMono(buffer, { offset: 1.5 });
    const cut = await resampleTo16kMono(buffer, { offset: 1.5, duration: 5 });

    expect(rest).toHaveLength(8000);
    expect(rest[0]).toBe(24000);
    expect(cut).toEqual(rest);
  });

  test('without an OfflineAudioContext the part is cut and resampled by hand', async () => {
    delete window.OfflineAudioContext;
    const buffer = bufferOf(32000, 1, 1);

    const out = await resampleTo16kMono(buffer, { offset: 0.25, duration: 0.5 });

    // 16000 samples of the 32000 are 8000 at 16 kHz, starting where sample 8000 is
    expect(out).toHaveLength(8000);
    expect(out[0]).toBe(8000);
    expect(out[1]).toBeCloseTo(8002, 5);
  });
});

describe('resampleTo16kMono: progress and stopping with a part', () => {
  test('progress is that of the part: the checkpoints lie inside it', async () => {
    canSuspend = true;
    const percents = [];

    // Of 120 s, 60 s from 30 s on
    await resampleTo16kMono(bufferOf(48000, 2, 120), {
      offset: 30,
      duration: 60,
      onProgress: percent => percents.push(percent)
    });

    expect(lengthsRendered()).toEqual([960000]);
    // The render is suspended on its own timeline (60 s long), never beyond it
    const times = offlineContexts[0].suspensions.map(suspension => suspension.time);
    expect(times.length).toBeGreaterThan(10);
    expect(Math.max(...times)).toBeLessThan(60);
    // ... and reaches almost the end of it, which a render of the whole 120 s would not
    expect(Math.max(...times)).toBeGreaterThan(55);
    expect(percents.length).toBe(times.length);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(Math.max(...percents)).toBeLessThan(100);
  });

  test('stopping before it starts rejects with the abort error and renders nothing', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await resampleTo16kMono(bufferOf(48000, 2, 4), {
      signal: controller.signal,
      offset: 1,
      duration: 1
    }).catch(e => e);

    expect(isAbortError(error)).toBe(true);
    expect(offlineContexts).toHaveLength(0);
  });

  test('stopping while it renders lets go of the source, as without a part', async () => {
    canSuspend = true;
    const controller = new AbortController();

    const rendering = resampleTo16kMono(bufferOf(48000, 2, 120), {
      signal: controller.signal,
      offset: 10,
      duration: 60,
      onProgress: percent => {
        if (percent >= 20) controller.abort();
      }
    });

    await expect(rendering).rejects.toMatchObject({ code: 'aborted' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sources[0].disconnect).toHaveBeenCalled();
  });
});
