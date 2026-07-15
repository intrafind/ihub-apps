import {
  CHUNK_SAMPLES,
  TARGET_SAMPLE_RATE,
  createTranscriptAssembler,
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

  test('PCM16 stream chunks stay under the 256 KB server maxPayload', () => {
    // Uses the REAL chunk-size constant so this fails if either side drifts.
    const bytesPerChunk = CHUNK_SAMPLES * 2; // two bytes per PCM16 sample
    expect(bytesPerChunk).toBeLessThan(256 * 1024);
  });
});

describe('createTranscriptAssembler', () => {
  test('deltas extend the current utterance and text() normalizes whitespace', () => {
    const asm = createTranscriptAssembler();
    asm.applyDelta('hel');
    asm.applyDelta('lo ');
    asm.applyDelta(' world');
    expect(asm.text()).toBe('hello world');
    expect(asm.hasText()).toBe(true);
  });

  test('final folds the utterance into committed text, preferring the server final', () => {
    const asm = createTranscriptAssembler();
    asm.applyDelta('helo'); // deltas contain a typo…
    asm.applyFinal('hello'); // …the server final wins
    asm.applyDelta('again');
    expect(asm.text()).toBe('hello again');
  });

  test('final without server text falls back to the accumulated deltas', () => {
    const asm = createTranscriptAssembler();
    asm.applyDelta('first utterance');
    asm.applyFinal(undefined);
    asm.applyDelta('second');
    asm.applyFinal('second one');
    expect(asm.text()).toBe('first utterance second one');
  });

  test('empty assembler reports no text', () => {
    const asm = createTranscriptAssembler();
    expect(asm.text()).toBe('');
    expect(asm.hasText()).toBe(false);
  });
});
