import { buildWsUrl } from './runtimeBasePath';
import {
  TARGET_SAMPLE_RATE,
  createPcmCapturePipeline,
  createTranscriptAssembler,
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
 * Audio is captured as mono 16 kHz PCM16 via the shared capture pipeline
 * (`realtimeTranscriptionCore.js`), which is also used by the buffer recorder.
 */

// Automatic-mode voice-activity detection thresholds.
const SPEECH_RMS_THRESHOLD = 0.015; // above this = speech present
const SILENCE_RMS_THRESHOLD = 0.01; // below this = silence
const SILENCE_HANG_MS = 1200; // stop after this much trailing silence

// After `stop`, wait this long for the server's `{type:'done'}` completion
// frame before tearing down anyway. Must exceed the server's post-stop settle
// window (2.5 s), which is when `done` normally arrives.
const STOP_TEARDOWN_FALLBACK_MS = 3000;

class VllmRealtimeRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = true;
    this.lang = 'en-US';
    this.host = '';
    // Tell useVoiceRecognition to use the {text, isFinal} result branch.
    this.usesTextEventShape = true;

    this._ws = null;
    this._pipeline = null;
    this._mediaStream = null;
    this._stopped = false;
    // Shared committed/partial transcript accumulation. Interim results are
    // emitted during the session and ONE final result is committed at the end,
    // so useVoiceRecognition (which appends finals to the input) never
    // double-counts.
    this._transcript = createTranscriptAssembler();
    this._finalEmitted = false;
    this._speechStarted = false;
    this._silenceTimer = null;
    this._teardownTimer = null;
  }

  async start() {
    this._stopped = false;
    this._transcript = createTranscriptAssembler();
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
      this._pipeline = await createPcmCapturePipeline(this._mediaStream, (frame, rate) =>
        this.#onAudioFrame(frame, rate)
      );
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
    this.#stopCapture();
    // Completion normally arrives as the server's {type:'done'} frame (after
    // its post-stop settle); this timer is only the fallback when it doesn't.
    this._teardownTimer = setTimeout(() => this.#cleanup(), STOP_TEARDOWN_FALLBACK_MS);
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

  #emitInterim() {
    if (this.interimResults && typeof this.onresult === 'function') {
      this.onresult({ text: this._transcript.text(), isFinal: false });
    }
  }

  #handleServerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        // Upstream connected; audio already flowing is fine.
        break;
      case 'delta':
        // Incremental token(s) for the current utterance.
        this._transcript.applyDelta(msg.text);
        this.#emitInterim();
        break;
      case 'final':
        // A completed utterance. Fold it into committed text; keep streaming.
        this._transcript.applyFinal(msg.text);
        this.#emitInterim();
        // In automatic (single-utterance) mode, the first completed utterance
        // ends the session.
        if (!this.continuous) {
          this.stop();
        }
        break;
      case 'done':
        // The server delivered every post-stop segment — finish now instead of
        // waiting out the teardown fallback timer.
        this.#finish();
        this.#cleanup();
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
  // only fires once (on done, session end, or socket close).
  #finish() {
    if (this._finalEmitted) return;
    this._finalEmitted = true;
    const text = this._transcript.text();
    if (text && typeof this.onresult === 'function') {
      this.onresult({ text, isFinal: true });
    }
  }

  // --- Audio capture ---
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

  // Stop capturing immediately (mic indicator off) while the socket may live on
  // briefly to deliver the final transcription.
  #stopCapture() {
    if (this._pipeline) {
      this._pipeline.stop();
      this._pipeline = null;
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => track.stop());
      this._mediaStream = null;
    }
  }

  #cleanup() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    if (this._teardownTimer) {
      clearTimeout(this._teardownTimer);
      this._teardownTimer = null;
    }
    this.#stopCapture();
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
