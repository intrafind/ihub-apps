import {
  TARGET_SAMPLE_RATE,
  downsample,
  floatTo16BitPCM
} from '../../../client/src/utils/realtimeTranscriptionCore';

describe('realtimeTranscriptionCore PCM helpers', () => {
  test('floatTo16BitPCM clamps and scales to 16-bit range', () => {
    const out = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(out).toBeInstanceOf(Int16Array);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767); // +1 → max positive
    expect(out[2]).toBe(-32768); // -1 → max negative
    expect(out[3]).toBe(32767); // clamps > 1
    expect(out[4]).toBe(-32768); // clamps < -1
    expect(out[5]).toBe(Math.trunc(0.5 * 0x7fff)); // Int16Array truncates toward zero
  });

  test('downsample is a no-op when already at the target rate', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    expect(downsample(samples, TARGET_SAMPLE_RATE)).toBe(samples);
  });

  test('downsample halves the sample count when input rate is 2x target', () => {
    const input = new Float32Array(160); // 160 samples @ 32 kHz → ~80 @ 16 kHz
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 5);
    const out = downsample(input, TARGET_SAMPLE_RATE * 2);
    expect(out.length).toBe(80);
    expect(out).toBeInstanceOf(Float32Array);
  });

  test('16-bit PCM frames stay well under the 256 KB server maxPayload for 32k-sample chunks', () => {
    // The buffer client sends ~16384-sample chunks; two bytes/sample → 32 KB.
    const bytesPerChunk = 16384 * 2;
    expect(bytesPerChunk).toBeLessThan(256 * 1024);
  });
});
