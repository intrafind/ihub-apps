import { buildWsUrl } from './runtimeBasePath';
import {
  TARGET_SAMPLE_RATE,
  WORKLET_SOURCE,
  downsample,
  floatTo16BitPCM
} from './realtimeTranscriptionCore';

/**
 * Realtime speech recognition that streams microphone audio to the iHub server
 * over a WebSocket. iHub proxies the audio to a vLLM realtime endpoint (Voxtral)
 * and streams transcription text back. The browser never talks to vLLM directly.
 *
 * Mirrors the duck-typed interface `useVoiceRecognition` expects: the caller sets
 * `continuous`, `interimResults`, `lang`, then assigns `onstart/onresult/onerror/
 * onend` and calls `start()` / `stop()`. Results are emitted as `{ text, isFinal }`
 * (same shape as the Azure service), so `usesTextEventShape` is set to true.
 *
 * Audio is captured as mono, downsampled to 16 kHz, and converted to PCM16 — the
 * format the vLLM realtime API expects. The PCM/worklet primitives are shared
 * with the buffer-transcription client via `realtimeTranscriptionCore.js`.
 */

// Automatic-mode voice-activity detection thresholds.
const SPEECH_RMS_THRESHOLD = 0.015; // above this = speech present
const SILENCE_RMS_THRESHOLD = 0.01; // below this = silence
const SILENCE_HANG_MS = 1200; // stop after this much trailing silence

class VllmRealtimeRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = true;
    this.lang = 'en-US';
    this.host = '';
    // Tell useVoiceRecognition to use the {text, isFinal} result branch.
    this.usesTextEventShape = true;

    this._ws = null;
    this._audioContext = null;
    this._mediaStream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._scriptNode = null;
    this._stopped = false;
    // `_committed` holds text from completed utterances (transcription.done),
    // `_partial` accumulates the current utterance's streaming deltas. We emit
    // these as interim results during the session and commit ONE final result
    // at the end, so useVoiceRecognition (which appends finals to the input)
    // never double-counts.
    this._committed = '';
    this._partial = '';
    this._finalEmitted = false;
    this._speechStarted = false;
    this._silenceTimer = null;
  }

  async start() {
    this._stopped = false;
    this._committed = '';
    this._partial = '';
    this._finalEmitted = false;
    this._speechStarted = false;

    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.#emitError('not-allowed');
      return;
    }

    try {
      await this.#openSocket();
    } catch {
      this.#emitError('network');
      this.#cleanup();
      return;
    }

    try {
      await this.#startCapture();
    } catch (err) {
      console.error('Realtime STT capture error:', err);
      this.#emitError('audio-capture');
      this.#cleanup();
      return;
    }

    if (typeof this.onstart === 'function') this.onstart();
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    // Tell the server we're done so it can flush the final transcription.
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ type: 'stop' }));
      } catch {
        /* ignore */
      }
    }
    this.#stopCaptureNodes();
    // Give the server a brief window to deliver the final result before we tear
    // the socket down; onend fires once the socket closes or the timeout hits.
    setTimeout(() => this.#cleanup(), 1500);
  }

  // --- WebSocket ---
  #openSocket() {
    return new Promise((resolve, reject) => {
      const url = buildWsUrl('/voice/realtime');
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      let opened = false;

      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'start', lang: this.lang }));
        resolve();
      };

      ws.onmessage = evt => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        this.#handleServerMessage(msg);
      };

      ws.onerror = () => {
        if (!opened) reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = () => {
        if (!opened) {
          reject(new Error('WebSocket closed before opening'));
          return;
        }
        this.#finish();
        this.#emitEnd();
      };
    });
  }

  #currentText() {
    return `${this._committed} ${this._partial}`.replace(/\s+/g, ' ').trim();
  }

  #emitInterim() {
    if (this.interimResults && typeof this.onresult === 'function') {
      this.onresult({ text: this.#currentText(), isFinal: false });
    }
  }

  #handleServerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        // Upstream connected; audio already flowing is fine.
        break;
      case 'delta':
        // Incremental token(s) for the current utterance.
        this._partial = `${this._partial}${msg.text || ''}`;
        this.#emitInterim();
        break;
      case 'final':
        // A completed utterance. Fold it into committed text; keep streaming.
        this._committed = `${this._committed} ${msg.text || this._partial}`.trim();
        this._partial = '';
        this.#emitInterim();
        // In automatic (single-utterance) mode, the first completed utterance
        // ends the session.
        if (!this.continuous) {
          this.stop();
        }
        break;
      case 'error':
        // Surface the backend's message and end the session so the UI leaves
        // its "listening" state instead of appearing to keep recording.
        this.#emitError('service', msg.message);
        this.#cleanup();
        break;
      default:
        break;
    }
  }

  // Commit the accumulated transcription as a single final result. Guarded so it
  // only fires once (on stop, session end, or socket close).
  #finish() {
    if (this._finalEmitted) return;
    this._finalEmitted = true;
    const text = this.#currentText();
    if (text && typeof this.onresult === 'function') {
      this.onresult({ text, isFinal: true });
    }
  }

  // --- Audio capture ---
  async #startCapture() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    // Request 16 kHz directly; browsers that honor it save us a resample step.
    this._audioContext = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    if (this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }
    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);

    const inputRate = this._audioContext.sampleRate;

    // Prefer AudioWorklet; fall back to ScriptProcessorNode if unavailable.
    let usedWorklet = false;
    if (this._audioContext.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const moduleUrl = URL.createObjectURL(blob);
        await this._audioContext.audioWorklet.addModule(moduleUrl);
        URL.revokeObjectURL(moduleUrl);
        this._workletNode = new AudioWorkletNode(this._audioContext, 'pcm-capture-processor');
        this._workletNode.port.onmessage = evt => this.#onAudioFrame(evt.data, inputRate);
        this._sourceNode.connect(this._workletNode);
        // Worklet needs a sink to keep the graph pulling audio.
        this._workletNode.connect(this._audioContext.destination);
        usedWorklet = true;
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
      }
    }

    if (!usedWorklet) {
      const node = this._audioContext.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = e => {
        const input = e.inputBuffer.getChannelData(0);
        this.#onAudioFrame(new Float32Array(input), inputRate);
      };
      this._sourceNode.connect(node);
      node.connect(this._audioContext.destination);
      this._scriptNode = node;
    }
  }

  #onAudioFrame(float32, inputRate) {
    if (this._stopped) return;

    // Voice-activity detection (used to auto-stop in automatic mode).
    const rms = computeRms(float32);
    this.#updateVad(rms);

    const downsampled = inputRate === TARGET_SAMPLE_RATE ? float32 : downsample(float32, inputRate);
    const pcm16 = floatTo16BitPCM(downsampled);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(pcm16.buffer);
    }
  }

  #updateVad(rms) {
    if (this.continuous) return; // manual mode: user controls stop

    if (rms >= SPEECH_RMS_THRESHOLD) {
      this._speechStarted = true;
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
    } else if (this._speechStarted && rms < SILENCE_RMS_THRESHOLD && !this._silenceTimer) {
      this._silenceTimer = setTimeout(() => {
        this.stop();
      }, SILENCE_HANG_MS);
    }
  }

  #stopCaptureNodes() {
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
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => track.stop());
    }
  }

  #cleanup() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    this.#stopCaptureNodes();
    if (this._audioContext && this._audioContext.state !== 'closed') {
      this._audioContext.close().catch(() => {});
    }
    this._audioContext = null;
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) {
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  #emitError(code, message) {
    if (typeof this.onerror === 'function') this.onerror({ error: code, message });
  }

  #emitEnd() {
    if (typeof this.onend === 'function') this.onend();
  }
}

// --- Audio helpers ---

function computeRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export default VllmRealtimeRecognition;
