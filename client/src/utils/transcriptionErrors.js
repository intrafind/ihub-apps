/**
 * Map a transcription failure (from decodeAudioFileToBuffer / transcribeAudioBuffer)
 * to a clear, localized message. Used by the chat (assistant bubble) and the
 * admin voice-input test panel.
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
    case 'service':
      return err?.message
        ? t('transcription.errors.serviceDetail', 'Transcription failed: {{detail}}', {
            detail: err.message
          })
        : t('transcription.errors.service', 'Transcription failed.');
    default:
      return t('transcription.errors.generic', 'Transcription failed. Please try again.');
  }
};
