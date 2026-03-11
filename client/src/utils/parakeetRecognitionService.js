/**
 * In-browser STT adapter using NVIDIA Parakeet TDT via parakeet.js.
 *
 * Implements the shared recognition callback interface used by all browser STT adapters:
 *   - onstart, onresult, onerror, onend, lang
 *   - async init(basePath, onProgress)
 *   - start()
 *   - stop()
 *
 * Parakeet is an English-only model so `lang` is fixed to 'en' and is not
 * forwarded to the underlying library.
 *
 * Flow:
 *   1. Call init() once to load the ONNX encoder + decoder weights via parakeet.js.
 *   2. Call start() to open the microphone and begin accumulating PCM.
 *   3. Call stop() to close the mic, run inference, and fire onresult / onend.
 *
 * @module parakeetRecognitionService
 */

import { createRecorder } from './audioUtils.js';
import { loadSTTModel } from './sttModelLoader.js';

/**
 * Parakeet TDT 0.6B speech recognition adapter.
 *
 * Wraps the parakeet.js ONNX runtime so it conforms to the same callback
 * interface as the Web Speech API shims used throughout this application.
 *
 * Parakeet is English-only — do not attempt to set lang to a non-English value
 * as the model will not produce meaningful output.
 *
 * @example
 * const recognizer = new ParakeetRecognition();
 * recognizer.onresult = (e) => console.log(e.results[0][0].transcript);
 * recognizer.onerror  = (e) => console.error(e.error);
 * recognizer.onend    = ()  => console.log('done');
 *
 * await recognizer.init('/api/stt-models', (pct) => console.log(pct + '%'));
 * recognizer.start();
 * // ... later ...
 * recognizer.stop();
 */
export default class ParakeetRecognition {
  constructor() {
    /** @type {function|null} Called with no arguments when recording starts. */
    this.onstart = null;

    /**
     * Called with a Web Speech API-shaped event when transcription completes.
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
     * Language tag — Parakeet is English-only so this is always 'en'.
     * Changing this value has no effect on the underlying model.
     * @type {string}
     */
    this.lang = 'en';

    /** @type {any|null} Loaded parakeet.js model instance. */
    this._model = null;

    /** @type {{ start: function, stop: function }|null} Active recorder handle. */
    this._recorder = null;
  }

  /**
   * Downloads and initialises the Parakeet ONNX encoder and decoder.
   *
   * Must be called before start(). Safe to call multiple times — the model is
   * cached after the first successful load so subsequent calls resolve immediately.
   *
   * @param {string}   basePath   - Base URL where model directories are served
   *                                (e.g. '/api/stt-models').
   * @param {function} onProgress - Optional callback receiving a 0-100 integer.
   *                                Parakeet does not expose granular progress so
   *                                this fires 0 at the start and 100 on completion.
   * @returns {Promise<void>}
   */
  async init(basePath, onProgress) {
    this._model = await loadSTTModel('parakeet', 'parakeet-tdt-0.6b', basePath, onProgress);
  }

  /**
   * Opens the microphone and starts accumulating raw PCM audio.
   *
   * Fires onstart on success, or onerror if mic access is denied or the
   * model has not been initialised yet.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!this._model) {
      this.onerror?.({ error: 'Model not initialized. Call init() first.' });
      return;
    }
    try {
      this._recorder = createRecorder();
      await this._recorder.start();
      this.onstart?.();
    } catch (err) {
      this.onerror?.({ error: err.message });
    }
  }

  /**
   * Stops recording, runs Parakeet inference on the captured 16kHz PCM, and
   * fires onresult followed by onend.
   *
   * The parakeet.js API expects `(float32Array, sampleRate)` and returns an
   * object with `utterance_text`. audioUtils.createRecorder already resamples
   * to 16kHz before returning, so 16000 is passed as the sample rate.
   *
   * If inference fails, onerror is fired before onend so callers can always
   * rely on onend being the final event regardless of success or failure.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._recorder) return;
    try {
      const pcm = await this._recorder.stop();
      this._recorder = null;

      const result = await this._model.transcribe(pcm, 16000);
      const transcript = result?.utterance_text?.trim() || '';

      this.onresult?.({
        results: [[{ transcript, confidence: 1 }]]
      });
    } catch (err) {
      this.onerror?.({ error: err.message });
    } finally {
      this.onend?.();
    }
  }
}
