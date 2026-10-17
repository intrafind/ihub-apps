/**
 * Voice mode (issue #2868), microphone side: the pre-roll ring buffer that
 * keeps the first syllable of a turn, the PCM conversion and the throttled mic
 * level for the orb.
 */

import { createPreRollBuffer } from '../../../client/src/features/voice/utils/voiceSession/preRoll';
import {
  concatInt16,
  createLevelMeter,
  frameRms,
  pcmDurationMs,
  pcmToArrayBuffer,
  rmsToLevel,
  toPcm16At16k
} from '../../../client/src/features/voice/utils/voiceSession/audioUtils';
import {
  captureFrameSize,
  scriptBufferSize
} from '../../../client/src/features/voice/utils/voiceSession/capture';

// One sample per millisecond keeps the arithmetic readable.
const ring = (capacityMs = 10) => createPreRollBuffer({ sampleRate: 1000, capacityMs });
const seq = (from, count) => Int16Array.from({ length: count }, (_, i) => from + i);
const list = (from, count) => Array.from(seq(from, count));

describe('pre-roll buffer', () => {
  test('hands back what was pushed, oldest first, and empties itself', () => {
    const buffer = ring();
    buffer.push(seq(1, 4));
    buffer.push(seq(5, 3));
    expect(buffer.size()).toBe(7);
    expect(Array.from(buffer.take())).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(buffer.size()).toBe(0);
    expect(buffer.take().length).toBe(0);
  });

  test('forgets the oldest audio once it is full', () => {
    const buffer = ring(10);
    buffer.push(seq(1, 8));
    buffer.push(seq(9, 6)); // 14 samples into a 10 sample ring
    expect(buffer.size()).toBe(10);
    expect(Array.from(buffer.take())).toEqual(list(5, 10));
  });

  test('stays in order across many wrap-arounds', () => {
    const buffer = ring(10);
    let next = 1;
    for (let i = 0; i < 25; i++) {
      buffer.push(seq(next, 3));
      next += 3;
    }
    // 75 samples went in; the last ten are 66..75
    expect(Array.from(buffer.take())).toEqual(list(66, 10));
  });

  test('a chunk longer than the buffer keeps only its tail', () => {
    const buffer = ring(10);
    buffer.push(seq(1, 4));
    buffer.push(seq(100, 25));
    expect(Array.from(buffer.take())).toEqual(list(115, 10));
  });

  test('take(ms) returns the most recent part only', () => {
    const buffer = ring(10);
    buffer.push(seq(1, 9));
    expect(Array.from(buffer.take(4))).toEqual([6, 7, 8, 9]);
    // The rest is dropped with it: the audio goes to the adapter from now on.
    expect(buffer.size()).toBe(0);
  });

  test('take(ms) never returns more than is held', () => {
    const buffer = ring(10);
    buffer.push(seq(1, 3));
    expect(Array.from(buffer.take(500))).toEqual([1, 2, 3]);
  });

  test('take(ms) works across the wrap point', () => {
    const buffer = ring(10);
    buffer.push(seq(1, 8));
    buffer.push(seq(9, 4)); // wrapped: holds 3..12
    expect(Array.from(buffer.take(6))).toEqual([7, 8, 9, 10, 11, 12]);
  });

  test('clear forgets everything; durationMs reports what is held', () => {
    const buffer = createPreRollBuffer({ sampleRate: 16000, capacityMs: 1000 });
    buffer.push(new Int16Array(1600));
    expect(buffer.durationMs()).toBeCloseTo(100);
    buffer.clear();
    expect(buffer.size()).toBe(0);
    expect(buffer.take().length).toBe(0);
  });

  test('ignores empty pushes', () => {
    const buffer = ring();
    buffer.push(new Int16Array(0));
    buffer.push(undefined);
    expect(buffer.size()).toBe(0);
  });

  test('is reusable after take', () => {
    const buffer = ring(10);
    buffer.push(seq(1, 12));
    buffer.take();
    buffer.push(seq(50, 3));
    expect(Array.from(buffer.take())).toEqual([50, 51, 52]);
  });
});

describe('PCM conversion', () => {
  test('16 kHz audio is converted without resampling', () => {
    const pcm = toPcm16At16k(Float32Array.from([0, 1, -1, 0.5]), 16000);
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16383]);
  });

  test('48 kHz audio is resampled to a third of the samples', () => {
    const pcm = toPcm16At16k(new Float32Array(1536).fill(0.25), 48000);
    expect(pcm.length).toBe(512);
    expect(pcm[10]).toBe(Math.trunc(0.25 * 0x7fff));
  });

  test('concatInt16 joins chunks and pcmDurationMs measures them', () => {
    const joined = concatInt16([seq(1, 2), seq(3, 3), new Int16Array(0)]);
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5]);
    expect(pcmDurationMs(1600)).toBeCloseTo(100);
  });

  test('pcmToArrayBuffer is exact for whole arrays and for views', () => {
    const whole = seq(1, 4);
    expect(pcmToArrayBuffer(whole)).toBe(whole.buffer);
    const view = whole.subarray(1, 3);
    const copy = pcmToArrayBuffer(view);
    expect(copy.byteLength).toBe(4);
    expect(Array.from(new Int16Array(copy))).toEqual([2, 3]);
  });
});

describe('capture frames', () => {
  test('a frame is about 32 ms and a multiple of the 128 sample render quantum', () => {
    expect(captureFrameSize(16000)).toBe(512);
    expect(captureFrameSize(48000)).toBe(1536);
    expect(captureFrameSize(44100) % 128).toBe(0);
  });

  test('the ScriptProcessor fallback uses a legal buffer size that holds a frame', () => {
    expect(scriptBufferSize(16000)).toBe(512);
    expect(scriptBufferSize(48000)).toBe(2048);
    for (const rate of [8000, 16000, 22050, 44100, 48000, 96000]) {
      expect([256, 512, 1024, 2048, 4096, 8192, 16384]).toContain(scriptBufferSize(rate));
    }
  });
});

describe('mic level', () => {
  test('rms of silence is 0 and of a constant signal is its amplitude', () => {
    expect(frameRms(new Float32Array(100))).toBe(0);
    expect(frameRms(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5);
    expect(frameRms(new Float32Array(0))).toBe(0);
  });

  test('the level stays within 0..1 and rises with the signal', () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(1)).toBe(1);
    expect(rmsToLevel(0.02)).toBeLessThan(rmsToLevel(0.1));
    expect(rmsToLevel(0.1)).toBeLessThan(1);
  });

  test('reports at most every interval and holds the loudest frame in between', () => {
    let clock = 1000;
    const onLevel = jest.fn();
    const meter = createLevelMeter({ onLevel, intervalMs: 60, now: () => clock });
    const loud = new Float32Array(512).fill(0.2);
    const quiet = new Float32Array(512).fill(0.01);

    meter.push(quiet); // first frame reports at once
    expect(onLevel).toHaveBeenCalledTimes(1);

    clock += 32;
    meter.push(loud); // too early: held
    expect(onLevel).toHaveBeenCalledTimes(1);

    clock += 32;
    meter.push(quiet); // 64 ms after the first report: reports the peak of the window
    expect(onLevel).toHaveBeenCalledTimes(2);
    expect(onLevel.mock.calls[1][0]).toBeCloseTo(rmsToLevel(0.2), 1);
  });

  test('about 15 reports a second for 32 ms frames', () => {
    let clock = 0;
    const onLevel = jest.fn();
    const meter = createLevelMeter({ onLevel, now: () => clock });
    const frame = new Float32Array(512).fill(0.05);
    for (let i = 0; i < 100; i++) {
      meter.push(frame);
      clock += 32;
    }
    // 3.2 s of audio
    const perSecond = onLevel.mock.calls.length / 3.2;
    expect(perSecond).toBeGreaterThan(12);
    expect(perSecond).toBeLessThanOrEqual(16);
  });

  test('silence() reports 0 immediately', () => {
    const onLevel = jest.fn();
    const meter = createLevelMeter({ onLevel, now: () => 0 });
    meter.silence();
    expect(onLevel).toHaveBeenCalledWith(0);
  });
});
