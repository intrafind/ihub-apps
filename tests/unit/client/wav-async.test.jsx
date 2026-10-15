/**
 * The WAV encoder that does not hold the page (issue #2835): encoding the
 * audio of a long video in one go takes the better part of a second, so
 * `audioBufferToWavAsync` encodes in slices with the event loop in between,
 * reports its progress and stops when told to. Its file is the one
 * `audioBufferToWav` writes, byte for byte.
 */

import { audioBufferToWav, audioBufferToWavAsync } from '../../../client/src/utils/wav';
import {
  createAbortError,
  isAbortError,
  raceAbort,
  throwIfAborted,
  yieldToEventLoop
} from '../../../client/src/utils/abortable';

const readBytes = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });

// Samples across the whole range, including values beyond full scale.
const audioBuffer = (channels, length, sampleRate = 16000) => {
  const data = Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length }, (__, i) => {
      const wave = Math.sin((i + c) / 7) * 1.3;
      return i % 11 === 0 ? (i % 2 ? 1.5 : -1.5) : wave;
    })
  );
  return { numberOfChannels: channels, sampleRate, length, getChannelData: c => data[c] };
};

describe('audioBufferToWavAsync', () => {
  test.each([
    ['mono', 1, 1000],
    ['stereo', 2, 1000],
    ['a length that is a multiple of the slice', 1, 700],
    ['a single frame', 1, 1],
    ['no frames at all', 1, 0]
  ])('writes the same file as audioBufferToWav: %s', async (_name, channels, length) => {
    const buffer = audioBuffer(channels, length, 44100);

    const whole = await readBytes(audioBufferToWav(buffer));
    const sliced = await readBytes(await audioBufferToWavAsync(buffer, { chunkSamples: 100 }));

    expect(sliced.length).toBe(44 + length * channels * 2);
    expect(Array.from(sliced)).toEqual(Array.from(whole));
  });

  test('returns an audio/wav Blob', async () => {
    const blob = await audioBufferToWavAsync(audioBuffer(1, 10));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');
  });

  test('reports the percent encoded after each slice, ending at 100', async () => {
    const percents = [];

    await audioBufferToWavAsync(audioBuffer(1, 1000), {
      chunkSamples: 250,
      onProgress: percent => percents.push(percent)
    });

    expect(percents).toEqual([25, 50, 75, 100]);
  });

  test('reports 100 for empty audio', async () => {
    const percents = [];
    await audioBufferToWavAsync(audioBuffer(1, 0), { onProgress: p => percents.push(p) });
    expect(percents).toEqual([100]);
  });

  test('gives the event loop a turn between slices', async () => {
    let timerTurns = 0;
    const timer = setInterval(() => timerTurns++, 0);

    await audioBufferToWavAsync(audioBuffer(1, 5000), { chunkSamples: 100 });
    clearInterval(timer);

    // 50 slices: a timer queued alongside could not have been starved
    expect(timerTurns).toBeGreaterThan(0);
  });

  test('stops at the next slice when the signal aborts, rejecting with the abort error', async () => {
    const controller = new AbortController();
    const percents = [];

    const encoding = audioBufferToWavAsync(audioBuffer(1, 1000), {
      chunkSamples: 100,
      signal: controller.signal,
      onProgress: percent => {
        percents.push(percent);
        if (percent === 30) controller.abort();
      }
    });

    await expect(encoding).rejects.toMatchObject({ message: 'aborted', code: 'aborted' });
    // Nothing was encoded after the slice that saw the abort
    expect(percents).toEqual([10, 20, 30]);
  });

  test('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const buffer = audioBuffer(1, 100);
    const getChannelData = jest.spyOn(buffer, 'getChannelData');

    await expect(
      audioBufferToWavAsync(buffer, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(getChannelData).not.toHaveBeenCalled();
  });
});

describe('abortable helpers', () => {
  test('the abort error is an AbortError whose message and code are "aborted"', () => {
    const error = createAbortError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'AbortError', message: 'aborted', code: 'aborted' });
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error('aborted'))).toBe(false);
    expect(isAbortError(new Error('read-error'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  test('throwIfAborted throws only for a signal that has fired', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow('aborted');
  });

  test('raceAbort settles with the promise when nothing aborts', async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.resolve(42), controller.signal)).resolves.toBe(42);
    await expect(raceAbort(Promise.reject(new Error('boom')), controller.signal)).rejects.toThrow(
      'boom'
    );
    // Without a signal it is the promise itself
    await expect(raceAbort(Promise.resolve(1))).resolves.toBe(1);
    // A plain value is settled with too
    await expect(raceAbort('plain', controller.signal)).resolves.toBe('plain');
  });

  test('raceAbort rejects as soon as the signal fires, without waiting for the promise', async () => {
    const controller = new AbortController();
    const never = new Promise(() => {});
    const raced = raceAbort(never, controller.signal);

    controller.abort();

    await expect(raced).rejects.toMatchObject({ code: 'aborted' });
  });

  test('raceAbort drops the failure of work that outlives an abort', async () => {
    const controller = new AbortController();
    let fail;
    const work = new Promise((_, reject) => {
      fail = reject;
    });
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    const raced = raceAbort(work, controller.signal);
    controller.abort();
    await expect(raced).rejects.toMatchObject({ code: 'aborted' });
    fail(new Error('decode failed late'));
    await new Promise(resolve => setTimeout(resolve, 0));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  describe('yieldToEventLoop', () => {
    const original = global.MessageChannel;
    afterEach(() => {
      global.MessageChannel = original;
    });

    test('resolves without a MessageChannel (timer fallback)', async () => {
      global.MessageChannel = undefined;
      await expect(yieldToEventLoop()).resolves.toBeUndefined();
    });

    test('goes through a message port where there is one, not a timer', async () => {
      const posted = [];
      global.MessageChannel = class {
        constructor() {
          const port1 = { onmessage: null, close: jest.fn() };
          this.port1 = port1;
          this.port2 = {
            postMessage: message => {
              posted.push(message);
              setTimeout(() => port1.onmessage());
            }
          };
        }
      };
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const timersBefore = setTimeoutSpy.mock.calls.length;

      await yieldToEventLoop();

      expect(posted).toHaveLength(1);
      // Only the fake port's own delivery used a timer
      expect(setTimeoutSpy.mock.calls.length - timersBefore).toBe(1);
      setTimeoutSpy.mockRestore();
    });
  });
});
