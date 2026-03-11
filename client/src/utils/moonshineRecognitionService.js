/**
 * In-browser STT adapter using Useful Sensors Moonshine via @moonshine-ai/moonshine-js.
 *
 * Implements the shared recognition callback interface used by all browser STT adapters:
 *   - onstart, onresult, onerror, onend, lang
 *   - async init(basePath, onProgress)
 *   - start()
 *   - stop()
 *
 * Unlike the Whisper and Parakeet adapters, Moonshine uses its own built-in
 * MicrophoneTranscriber that manages microphone access internally.  This adapter
 * does NOT use audioUtils.createRecorder; instead it hooks into the transcriber's
 * onTranscript callback to bridge results into the shared interface.
 *
 * Flow:
 *   1. Call init() once to instantiate MicrophoneTranscriber (model path resolved
 *      by sttModelLoader).
 *   2. Call start() to activate the internal mic and register the transcript hook.
 *   3. Call stop() to deactivate the mic and fire onend.
 *
 * @module moonshineRecognitionService
 */

import { loadSTTModel } from './sttModelLoader.js';

/**
 * Moonshine speech recognition adapter.
 *
 * Wraps @moonshine-ai/moonshine-js MicrophoneTranscriber so it conforms to the
 * same callback interface as the Web Speech API shims used throughout this
 * application.
 *
 * Moonshine is English-only. The lang property is present for interface
 * consistency but is not forwarded to the underlying model.
 *
 * @example
 * const recognizer = new MoonshineRecognition();
 * recognizer.onresult = (e) => console.log(e.results[0][0].transcript);
 * recognizer.onerror  = (e) => console.error(e.error);
 * recognizer.onend    = ()  => console.log('done');
 *
 * await recognizer.init('/api/stt-models', (pct) => console.log(pct + '%'));
 * recognizer.start();
 * // ... later ...
 * recognizer.stop();
 */
export default class MoonshineRecognition {
  constructor() {
    /** @type {function|null} Called with no arguments when recording starts. */
    this.onstart = null;

    /**
     * Called with a Web Speech API-shaped event for each transcribed segment.
     * Moonshine may fire this multiple times per session as it transcribes
     * audio in real-time chunks.
     * @type {function({ results: [[{ transcript: string, confidence: number }]] })|null}
     */
    this.onresult = null;

    /**
     * Called with an error descriptor when something goes wrong.
     * @type {function({ error: string })|null}
     */
    this.onerror = null;

    /** @type {function|null} Called when the recognition session has fully ended. */
    this.onend = null;

    /**
     * Language tag — Moonshine is English-only so this is always 'en'.
     * Changing this value has no effect on the underlying model.
     * @type {string}
     */
    this.lang = 'en';

    /**
     * HuggingFace model identifier used when loading via sttModelLoader.
     * @type {string}
     */
    this.modelId = 'moonshine-tiny';

    /** @type {any|null} MicrophoneTranscriber instance from @moonshine-ai/moonshine-js. */
    this._transcriber = null;

    /**
     * Guards against calling start() while already recording, and ensures
     * stop() is a no-op when the session is not active.
     * @type {boolean}
     */
    this._isRecording = false;
  }

  /**
   * Instantiates the Moonshine MicrophoneTranscriber pointed at locally-served
   * model weights.
   *
   * Must be called before start(). Safe to call multiple times — sttModelLoader
   * caches the instance after the first successful call.
   *
   * @param {string}   basePath   - Base URL where model directories are served
   *                                (e.g. '/api/stt-models').
   * @param {function} onProgress - Optional callback receiving a 0-100 integer.
   *                                Moonshine does not expose download progress so
   *                                this fires 0 at the start and 100 on completion.
   * @returns {Promise<void>}
   */
  async init(basePath, onProgress) {
    this._transcriber = await loadSTTModel('moonshine', this.modelId, basePath, onProgress);
  }

  /**
   * Activates the internal microphone managed by MicrophoneTranscriber and
   * registers the transcript hook that forwards results into the shared interface.
   *
   * Fires onstart on success, or onerror if the transcriber has not been
   * initialised or if the underlying library throws during start.
   *
   * Re-entrant calls while already recording are silently ignored.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!this._transcriber) {
      this.onerror?.({ error: 'Model not initialized. Call init() first.' });
      return;
    }
    if (this._isRecording) return;

    try {
      this._isRecording = true;
      this.onstart?.();

      // Bridge MicrophoneTranscriber's callback into the shared onresult shape.
      this._transcriber.onTranscript = (text) => {
        if (text?.trim()) {
          this.onresult?.({
            results: [[{ transcript: text.trim(), confidence: 1 }]],
          });
        }
      };

      await this._transcriber.start();
    } catch (err) {
      this._isRecording = false;
      this.onerror?.({ error: err.message });
      this.onend?.();
    }
  }

  /**
   * Deactivates the internal microphone and fires onend.
   *
   * If the transcriber throws during stop, onerror is fired before onend so
   * callers can always rely on onend being the final event.
   *
   * No-op when not currently recording.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._transcriber || !this._isRecording) return;
    try {
      await this._transcriber.stop();
    } catch (err) {
      this.onerror?.({ error: err.message });
    } finally {
      this._isRecording = false;
      this.onend?.();
    }
  }
}
