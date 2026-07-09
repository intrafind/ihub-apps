import { WORKLET_SOURCE } from './realtimeTranscriptionCore';

/**
 * Records microphone audio in the browser and accumulates it into a single
 * AudioBuffer for one-shot transcription (distinct from live dictation, which
 * streams frame-by-frame). Reuses the shared AudioWorklet PCM capture pipeline
 * so no audio codec / MediaRecorder container is involved — the accumulated
 * Float32 samples are handed straight to `transcribeAudioBuffer()`, which
 * resamples them to 16 kHz mono.
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

    this._audioContext = null;
    this._mediaStream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._scriptNode = null;
    this._chunks = [];
    this._totalSamples = 0;
    this._sampleRate = 16000;
    this._tickTimer = null;
    this._startedAt = 0;
    this._recording = false;
  }

  get isRecording() {
    return this._recording;
  }

  async start() {
    this._chunks = [];
    this._totalSamples = 0;

    this._mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this._audioContext = new AudioContextCtor();
    if (this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }
    this._sampleRate = this._audioContext.sampleRate;
    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);

    const onFrame = frame => {
      if (!this._recording) return;
      // Copy — worklet reuses its buffer between posts.
      this._chunks.push(new Float32Array(frame));
      this._totalSamples += frame.length;
    };

    let usedWorklet = false;
    if (this._audioContext.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const moduleUrl = URL.createObjectURL(blob);
        await this._audioContext.audioWorklet.addModule(moduleUrl);
        URL.revokeObjectURL(moduleUrl);
        this._workletNode = new AudioWorkletNode(this._audioContext, 'pcm-capture-processor');
        this._workletNode.port.onmessage = evt => onFrame(evt.data);
        this._sourceNode.connect(this._workletNode);
        this._workletNode.connect(this._audioContext.destination);
        usedWorklet = true;
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
      }
    }

    if (!usedWorklet) {
      const node = this._audioContext.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = e => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      this._sourceNode.connect(node);
      node.connect(this._audioContext.destination);
      this._scriptNode = node;
    }

    this._recording = true;
    this._startedAt = performance.now();
    this._tickTimer = setInterval(() => {
      const elapsed = (performance.now() - this._startedAt) / 1000;
      if (typeof this.onTick === 'function') this.onTick(elapsed);
      if (this.maxDurationSeconds && elapsed >= this.maxDurationSeconds) {
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
    const durationSeconds = (performance.now() - this._startedAt) / 1000;

    const merged = new Float32Array(this._totalSamples);
    let offset = 0;
    for (const chunk of this._chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Build the AudioBuffer with the still-open context (needs a live context).
    let audioBuffer = null;
    if (this._audioContext && merged.length > 0) {
      audioBuffer = this._audioContext.createBuffer(1, merged.length, this._sampleRate);
      audioBuffer.copyToChannel(merged, 0);
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
    try {
      if (this._workletNode) {
        this._workletNode.port.onmessage = null;
        this._workletNode.disconnect();
      }
      if (this._scriptNode) {
        this._scriptNode.onaudioprocess = null;
        this._scriptNode.disconnect();
      }
      if (this._sourceNode) this._sourceNode.disconnect();
    } catch {
      /* ignore */
    }
    this._workletNode = null;
    this._scriptNode = null;
    this._sourceNode = null;
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => track.stop());
      this._mediaStream = null;
    }
    if (this._audioContext && this._audioContext.state !== 'closed') {
      this._audioContext.close().catch(() => {});
    }
    this._audioContext = null;
  }
}

export default AudioBufferRecorder;
