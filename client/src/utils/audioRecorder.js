import { createPcmCapturePipeline } from './realtimeTranscriptionCore';

/**
 * Records microphone audio in the browser and accumulates it into a single
 * AudioBuffer for one-shot transcription (distinct from live dictation, which
 * streams frame-by-frame). Uses the shared PCM capture pipeline — no audio
 * codec / MediaRecorder container is involved; the accumulated Float32 samples
 * are handed straight to `transcribeAudioBuffer()`, which resamples them to
 * 16 kHz mono (a no-op when the pipeline already captured at 16 kHz).
 *
 * Usage:
 *   const rec = new AudioBufferRecorder({ maxDurationSeconds: 900, onTick, onMaxDuration });
 *   await rec.start();
 *   // ... user speaks ...
 *   const { audioBuffer, durationSeconds } = await rec.stop();
 */
export class AudioBufferRecorder {
  constructor({ maxDurationSeconds = 900, onTick, onMaxDuration } = {}) {
    this.maxDurationSeconds = maxDurationSeconds;
    this.onTick = onTick;
    this.onMaxDuration = onMaxDuration;

    this._pipeline = null;
    this._mediaStream = null;
    this._chunks = [];
    this._totalSamples = 0;
    this._sampleRate = 16000;
    this._tickTimer = null;
    this._startedAt = 0;
    this._recording = false;
    this._maxDurationFired = false;
  }

  get isRecording() {
    return this._recording;
  }

  async start() {
    this._chunks = [];
    this._totalSamples = 0;
    this._maxDurationFired = false;

    this._mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Everything after mic acquisition must release the mic on failure —
    // otherwise an AudioContext/worklet error leaves the recording indicator on.
    try {
      this._pipeline = await createPcmCapturePipeline(this._mediaStream, frame => {
        if (!this._recording) return;
        // Pipeline frames are owned by the receiver — no copy needed.
        this._chunks.push(frame);
        this._totalSamples += frame.length;
      });
      this._sampleRate = this._pipeline.sampleRate;
    } catch (err) {
      this._teardown();
      throw err;
    }

    this._recording = true;
    this._startedAt = performance.now();
    this._tickTimer = setInterval(() => {
      const elapsed = (performance.now() - this._startedAt) / 1000;
      if (typeof this.onTick === 'function') this.onTick(elapsed);
      if (
        this.maxDurationSeconds &&
        elapsed >= this.maxDurationSeconds &&
        !this._maxDurationFired
      ) {
        // Fire once — the tick keeps running until stop(), and re-invoking the
        // caller's stop-and-transcribe handler every 250 ms would race itself.
        this._maxDurationFired = true;
        if (typeof this.onMaxDuration === 'function') this.onMaxDuration();
      }
    }, 250);
  }

  /**
   * Stop recording and return the accumulated audio as a mono AudioBuffer.
   * @returns {Promise<{ audioBuffer: AudioBuffer, durationSeconds: number }>}
   */
  async stop() {
    if (!this._recording) {
      this._teardown();
      return { audioBuffer: null, durationSeconds: 0 };
    }
    this._recording = false;

    const merged = new Float32Array(this._totalSamples);
    let offset = 0;
    for (const chunk of this._chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    // Drop the chunk references immediately — `merged` is the single copy now,
    // and the recorder instance stays referenced through the whole transcription.
    this._chunks = [];
    this._totalSamples = 0;

    // The max-duration tick has ≥250 ms granularity (worse in throttled
    // background tabs), so the capture can overshoot the cap. Trim to the cap
    // here so downstream duration checks (which reject over-cap audio outright)
    // can never discard a recording the recorder itself auto-stopped.
    const maxSamples = this.maxDurationSeconds
      ? Math.floor(this.maxDurationSeconds * this._sampleRate)
      : merged.length;
    const samples = merged.length > maxSamples ? merged.subarray(0, maxSamples) : merged;
    const durationSeconds = samples.length / this._sampleRate;

    // Build the AudioBuffer with the still-open context (needs a live context).
    let audioBuffer = null;
    if (this._pipeline && samples.length > 0) {
      audioBuffer = this._pipeline.audioContext.createBuffer(1, samples.length, this._sampleRate);
      audioBuffer.copyToChannel(samples, 0);
    }

    this._teardown();
    return { audioBuffer, durationSeconds };
  }

  cancel() {
    this._recording = false;
    this._chunks = [];
    this._totalSamples = 0;
    this._teardown();
  }

  _teardown() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._pipeline) {
      this._pipeline.stop();
      this._pipeline = null;
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => track.stop());
      this._mediaStream = null;
    }
  }
}

export default AudioBufferRecorder;
