/**
 * Errors shared by the text-to-speech providers.
 *
 * @module tts/errors
 */

/** An upstream failure, with the HTTP status when the upstream answered. */
export class TtsUpstreamError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'TtsUpstreamError';
    this.status = status;
  }
}
