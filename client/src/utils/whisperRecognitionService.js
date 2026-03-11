/**
 * In-browser STT adapter using OpenAI Whisper via @huggingface/transformers.
 *
 * Implements the shared recognition callback interface used by all browser STT adapters:
 *   - onstart, onresult, onerror, onend, lang
 *   - async init(basePath, onProgress)
 *   - start()
 *   - stop()
 *
 * Flow:
 *   1. Call init() once to download and cache the ONNX model weights.
 *   2. Call start() to open the microphone and begin accumulating PCM.
 *   3. Call stop() to close the mic, run inference, and fire onresult / onend.
 *
 * The model is cached in sttModelLoader so repeated start/stop cycles within
 * the same page session do not re-download the weights.
 *
 * @module whisperRecognitionService
 */

import { createRecorder } from './audioUtils.js';
import { loadSTTModel } from './sttModelLoader.js';

/**
 * Whisper-based speech recognition adapter.
 *
 * Wraps the HuggingFace Transformers automatic-speech-recognition pipeline
 * so it conforms to the same callback interface as the Web Speech API shims
 * used throughout this application.
 *
 * @example
 * const recognizer = new WhisperRecognition();
 * recognizer.lang = 'de';
 * recognizer.onresult = (e) => console.log(e.results[0][0].transcript);
 * recognizer.onerror  = (e) => console.error(e.error);
 * recognizer.onend    = ()  => console.log('done');
 *
 * await recognizer.init('/api/stt-models', (pct) => console.log(pct + '%'));
 * recognizer.start();
 * // ... later ...
 * recognizer.stop();
 */
export default class WhisperRecognition {
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
     * BCP-47 language tag passed to the Whisper pipeline.
     * Use 'auto' to let the model detect the language automatically.
     * @type {string}
     */
    this.lang = 'en';

    /**
     * HuggingFace model identifier used when loading via sttModelLoader.
     * Corresponds to a locally-served model directory under basePath.
     * @type {string}
     */
    this.modelId = 'whisper-tiny';

    /** @type {any|null} Loaded HuggingFace pipeline instance. */
    this._pipeline = null;

    /** @type {{ start: function, stop: function }|null} Active recorder handle. */
    this._recorder = null;
  }

  /**
   * Downloads and initialises the Whisper ONNX model.
   *
   * Must be called before start(). Safe to call multiple times — the model is
   * cached after the first successful load so subsequent calls resolve immediately.
   *
   * @param {string}   basePath   - Base URL where model directories are served
   *                                (e.g. '/api/stt-models').
   * @param {function} onProgress - Optional callback receiving a 0-100 integer
   *                                as model files are downloaded.
   * @returns {Promise<void>}
   */
  async init(basePath, onProgress) {
    this._pipeline = await loadSTTModel('whisper', this.modelId, basePath, onProgress);
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
    if (!this._pipeline) {
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
   * Stops recording, runs Whisper inference on the captured audio, and fires
   * onresult followed by onend.
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

      // Only pass language when explicitly set; 'auto' lets the model decide.
      const options = {};
      if (this.lang && this.lang !== 'auto') {
        options.language = this.lang;
      }

      const result = await this._pipeline(pcm, options);
      const transcript = result?.text?.trim() || '';

      this.onresult?.({
        results: [[{ transcript, confidence: 1 }]],
      });
    } catch (err) {
      this.onerror?.({ error: err.message });
    } finally {
      this.onend?.();
    }
  }
}
