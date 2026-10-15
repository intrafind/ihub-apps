/**
 * `getTranscriptionErrorMessage`: what the user reads when a transcription
 * fails (issue #2836).
 *
 * The server names a failure with a `code` and words it in a `message` that is
 * safe for the browser. Codes without a text of their own used to collapse into
 * "Transcription failed. Please try again.", hiding what the server said.
 */

import { getTranscriptionErrorMessage } from '../../../client/src/utils/transcriptionErrors';

// Like i18next with a default value: interpolates {{name}}.
const t = (key, defaultValue, options = {}) =>
  defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options[name] ?? ''));

const failure = (code, message) => Object.assign(new Error(message ?? code), { code });
const GENERIC = 'Transcription failed. Please try again.';

describe('server errors without a text of their own show the server message', () => {
  test.each([
    ['upstream-error', 'Transcription error: model overloaded'],
    ['upstream-closed', 'The transcription service closed the connection (code 1011)'],
    ['upstream-unreachable', 'Failed to reach transcription service'],
    ['upstream-rejected', 'The transcription service rejected the connection (HTTP 401)'],
    ['resolve-failed', 'Failed to resolve transcription model'],
    ['resolve-rejected', 'Transcription model is not available'],
    ['no-model', 'No transcription model selected'],
    ['unknown-model', 'Unknown transcription model: voxtral'],
    ['not-transcription-model', 'Model "gpt-5" is not a transcription model'],
    ['model-disabled', 'Transcription model "voxtral" is disabled'],
    ['unsupported-provider', 'Unsupported transcription provider: acme'],
    ['no-endpoint', 'Transcription model "voxtral" has no endpoint URL']
  ])('%s', (code, message) => {
    expect(getTranscriptionErrorMessage(failure(code, message), t)).toBe(
      `Transcription failed: ${message}`
    );
  });

  test('a server error without a message falls back to the generic text', () => {
    // transcribeAudioBuffer builds `new Error(message || code)`.
    expect(getTranscriptionErrorMessage(failure('upstream-error'), t)).toBe(GENERIC);
  });

  test('a code-less server error keeps its detail', () => {
    // The code the client falls back to when the server sent none.
    expect(getTranscriptionErrorMessage(failure('service', 'Boom'), t)).toBe(
      'Transcription failed: Boom'
    );
  });
});

describe('dedicated messages', () => {
  test('not-permitted names the problem and the way out', () => {
    expect(getTranscriptionErrorMessage(failure('not-permitted', 'Not permitted'), t)).toBe(
      'You are not permitted to use this transcription model. Please contact your administrator.'
    );
  });

  test('session-limit asks for shorter recordings', () => {
    expect(
      getTranscriptionErrorMessage(failure('session-limit', 'exceeded the maximum (3600s)'), t)
    ).toBe(
      'The transcription session reached its maximum duration. Please split the recording into shorter parts.'
    );
  });

  test.each([
    ['audio-decode-error', /Could not decode this audio/],
    ['empty-audio', /No audio could be read/],
    ['not-ready', /did not become ready/],
    ['connect', /Could not reach the transcription service/],
    ['closed', /Could not reach the transcription service/],
    ['timeout', /timed out/],
    ['interrupted', /interrupted/],
    ['aborted', /cancelled/],
    ['audio-too-long', /too long for the configured transcription model/],
    ['server-busy', /busy right now/]
  ])('%s keeps its own text', (code, text) => {
    expect(getTranscriptionErrorMessage(failure(code, 'raw detail that must not show'), t)).toMatch(
      text
    );
  });
});

describe('browser-side failures never leak their raw message', () => {
  test('an unknown local code is generic', () => {
    expect(getTranscriptionErrorMessage(failure('stream', "Failed to execute 'send'"), t)).toBe(
      GENERIC
    );
  });

  test('an error without a code is generic', () => {
    expect(getTranscriptionErrorMessage(new Error('Something odd'), t)).toBe(GENERIC);
    expect(getTranscriptionErrorMessage(undefined, t)).toBe(GENERIC);
  });
});
