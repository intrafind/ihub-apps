// Codes the server's `{type:'error'}` frame carries that have no text of their
// own below. Their messages are written for the browser (no internal hosts or
// keys — see diagnoseSocketError in server/websocket/realtimeTranscription.js)
// and say what went wrong, so they are shown as they are. Codes the browser
// raises itself ('stream', 'too-long', …) stay out: their message is not for
// the user.
const SERVER_DETAIL_CODES = new Set([
  'no-model',
  'unknown-model',
  'not-transcription-model',
  'model-disabled',
  'unsupported-provider',
  'no-endpoint',
  'resolve-failed',
  'resolve-rejected',
  'upstream-error',
  'upstream-closed',
  'upstream-unreachable',
  'upstream-rejected'
]);

/**
 * Map a transcription failure (from decodeAudioFileToBuffer / transcribeAudioBuffer /
 * startLiveTranscription) to a clear, localized message. Used by the chat and
 * the admin voice-input test panel.
 */
export const getTranscriptionErrorMessage = (err, t) => {
  const code = err?.code || err?.message;
  switch (code) {
    case 'audio-decode-error':
      return t(
        'transcription.errors.decode',
        'Could not decode this audio in your browser. The format or codec may be unsupported (e.g. OGG in Safari).'
      );
    case 'empty-audio':
      return t('transcription.errors.empty', 'No audio could be read from this file.');
    case 'not-ready':
      return t(
        'transcription.errors.notReady',
        'The transcription service did not become ready. Please check the model configuration and try again.'
      );
    case 'connect':
    case 'closed':
      return t(
        'transcription.errors.connection',
        'Could not reach the transcription service. Please try again later.'
      );
    case 'timeout':
      return t(
        'transcription.errors.timeout',
        'Transcription timed out. The file may be too long.'
      );
    case 'interrupted':
      return t(
        'transcription.errors.interrupted',
        'The transcription was interrupted before it finished.'
      );
    case 'aborted':
      return t('transcription.errors.aborted', 'Transcription was cancelled.');
    // Batch transcription models buffer the whole recording server-side, so
    // they can reject it for size (this recording) or capacity (all of them).
    case 'audio-too-long':
      return t(
        'transcription.errors.serverTooLong',
        'This recording is too long for the configured transcription model. Please split it into shorter parts.'
      );
    case 'server-busy':
      return t(
        'transcription.errors.serverBusy',
        'The transcription service is busy right now. Please try again in a moment.'
      );
    case 'not-permitted':
      return t(
        'transcription.errors.notPermitted',
        'You are not permitted to use this transcription model. Please contact your administrator.'
      );
    // The bridge caps how long one session may last, however long the audio.
    case 'session-limit':
      return t(
        'transcription.errors.sessionLimit',
        'The transcription session reached its maximum duration. Please split the recording into shorter parts.'
      );
    case 'service':
      return err?.message
        ? t('transcription.errors.serviceDetail', 'Transcription failed: {{detail}}', {
            detail: err.message
          })
        : t('transcription.errors.service', 'Transcription failed.');
    default:
      if (SERVER_DETAIL_CODES.has(code) && err?.message && err.message !== code) {
        return t('transcription.errors.serviceDetail', 'Transcription failed: {{detail}}', {
          detail: err.message
        });
      }
      return t('transcription.errors.generic', 'Transcription failed. Please try again.');
  }
};
