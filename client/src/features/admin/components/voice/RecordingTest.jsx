// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import { AudioBufferRecorder } from '../../../../utils/audioRecorder';
import { transcribeAudioBuffer } from '../../../../utils/transcribeAudioBuffer';
import { getTranscriptionErrorMessage } from '../../../../utils/transcriptionErrors';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { getMicrophoneErrorMessage } from '../../../voice/utils/speechService';

// A test clip only needs a sentence or two.
const MAX_TEST_SECONDS = 60;

const selectClass =
  'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm disabled:opacity-60';

/** The raw code/message of a failure, for admins (e.g. "upstream-unreachable: …"). */
const errorDetail = err =>
  err?.code && err.message && err.message !== err.code ? `${err.code}: ${err.message}` : err?.code;

/** The button for the test's current step. */
function RecordingButton({ status, onStart, onStop, onCancel, startDisabled, t }) {
  if (status === 'recording') {
    return (
      <button
        type="button"
        onClick={onStop}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700"
      >
        <span className="w-2.5 h-2.5 bg-white rounded-sm" aria-hidden="true" />
        {t('admin.voiceInput.test.recording.stop', 'Stop and transcribe')}
      </button>
    );
  }
  if (status === 'transcribing') {
    return (
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex items-center px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        {t('common.cancel', 'Cancel')}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={startDisabled}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 text-sm font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50"
    >
      <span className="w-2.5 h-2.5 bg-red-600 rounded-full" aria-hidden="true" />
      {t('admin.voiceInput.test.recording.start', 'Start recording')}
    </button>
  );
}

/** The button for the test's current step, and what it is doing. */
function RecordingControls({ status, elapsed, t, ...buttonProps }) {
  return (
    <div className="flex items-center gap-3">
      <RecordingButton status={status} t={t} {...buttonProps} />
      <span className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
        {status === 'recording' &&
          t('admin.voiceInput.test.recording.recording', 'Recording… {{elapsed}} s', {
            elapsed: Math.floor(elapsed)
          })}
        {status === 'transcribing' &&
          t('admin.voiceInput.test.recording.transcribing', 'Transcribing…')}
      </span>
    </div>
  );
}

/** How the finished test went: how long it took, or that no text came back. */
function RecordingVerdict({ transcript, durationSeconds, processingMs, t }) {
  if (!transcript.trim()) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-1">
        <Icon name="exclamation-triangle" className="w-4 h-4 shrink-0" />
        {t(
          'admin.voiceInput.test.recording.noText',
          'The model returned no text. Use the microphone check to confirm the microphone picks up sound.'
        )}
      </p>
    );
  }
  return (
    <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-1">
      <Icon name="check-circle" className="w-4 h-4 shrink-0" />
      {t(
        'admin.voiceInput.test.recording.success',
        'Transcribed {{duration}} s of audio in {{ms}} ms.',
        { duration: (durationSeconds || 0).toFixed(1), ms: processingMs }
      )}
    </p>
  );
}

/** Why the test failed, with the raw code for admins. */
function RecordingError({ error }) {
  return (
    <div className="text-sm text-red-600 dark:text-red-400" role="alert">
      <p className="flex items-center gap-1">
        <Icon name="clearCircle" className="w-4 h-4 shrink-0" />
        {error.message}
      </p>
      {error.detail && (
        <p className="mt-1 ml-5 text-xs font-mono text-red-500 dark:text-red-400 break-all">
          {error.detail}
        </p>
      )}
    </div>
  );
}

/** The transcript, how long it took, or why it failed. */
function RecordingOutcome({ status, transcript, durationSeconds, processingMs, error, t }) {
  return (
    <>
      {transcript && (
        <div
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap"
          data-testid="recording-transcript"
        >
          {transcript}
        </div>
      )}
      {status === 'done' && (
        <RecordingVerdict
          transcript={transcript}
          durationSeconds={durationSeconds}
          processingMs={processingMs}
          t={t}
        />
      )}
      {error && <RecordingError error={error} />}
    </>
  );
}

/** The model to test with, and a hint when there is none. */
function ModelPicker({ models, modelId, disabled, onChange, language, t }) {
  return (
    <div className="max-w-md">
      <label
        className="block text-xs font-medium text-gray-700 dark:text-gray-300"
        htmlFor="voice-test-model"
      >
        {t('admin.voiceInput.test.recording.model', 'Transcription model')}
      </label>
      <select
        id="voice-test-model"
        value={modelId}
        disabled={disabled || !models?.length}
        onChange={e => onChange(e.target.value)}
        className={selectClass}
      >
        {models === null && <option value="">{t('common.loading', 'Loading...')}</option>}
        {(models || []).map(m => (
          <option key={m.id} value={m.id}>
            {getLocalizedContent(m.name, language) || m.id}
          </option>
        ))}
      </select>
      {models?.length === 0 && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          {t(
            'admin.apps.edit.noTranscriptionModels',
            'No transcription models configured. Add one under Admin → Models (model type "transcription").'
          )}
        </p>
      )}
    </div>
  );
}

/** The model picked, or until the admin picks one, the first. */
const pickModelId = (models, selectedId) => {
  const list = models || [];
  return list.find(m => m.id === selectedId)?.id || list[0]?.id || '';
};

/** Whether the test is between Start and its result. */
const isBusy = status => ['starting', 'recording', 'transcribing'].includes(status);

/**
 * Record → transcribe test: records a short clip and sends it to a
 * transcription model over `/api/voice/realtime`, the endpoint and model check
 * a chat's transcription goes through. The clip is sent after recording (not
 * streamed live like the chat's record button) so the processing time can be
 * measured on its own.
 *
 * @param {object} props
 * @param {Array|null} props.models Enabled transcription models (null while loading).
 * @param {Function} props.t
 * @param {string} props.language UI language, for localized model names.
 */
function RecordingTest({ models, t, language }) {
  const [selectedModelId, setSelectedModelId] = useState('');
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);
  const [durationSeconds, setDurationSeconds] = useState(null);
  const [processingMs, setProcessingMs] = useState(null);
  const recorderRef = useRef(null);
  const abortRef = useRef(null);
  // Set on unmount, so a permission prompt answered after leaving the page
  // releases the microphone instead of recording on.
  const disposedRef = useRef(false);

  const modelId = pickModelId(models, selectedModelId);

  // Release the microphone and abort a running transcription on unmount.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const stopAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;

    let recording;
    try {
      recording = await recorder.stop();
    } catch (err) {
      setError({ message: getMicrophoneErrorMessage(err, t) });
      setStatus('error');
      return;
    }
    setDurationSeconds(recording.durationSeconds);
    if (!recording.audioBuffer?.length) {
      setError({
        message: t('admin.voiceInput.test.recording.empty', 'Nothing was recorded.')
      });
      setStatus('error');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('transcribing');
    const startedAt = performance.now();
    try {
      const text = await transcribeAudioBuffer(recording.audioBuffer, {
        modelId,
        onDelta: setTranscript,
        signal: controller.signal
      });
      setTranscript(text);
      setProcessingMs(Math.round(performance.now() - startedAt));
      setStatus('done');
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus('idle');
        return;
      }
      // The localized message for users, plus the raw code/message for admins
      // (e.g. "model-disabled", "upstream-unreachable: …").
      setError({ message: getTranscriptionErrorMessage(err, t), detail: errorDetail(err) });
      setStatus('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [modelId, t]);

  const start = async () => {
    setError(null);
    setTranscript('');
    setDurationSeconds(null);
    setProcessingMs(null);
    setElapsed(0);
    const recorder = new AudioBufferRecorder({
      maxDurationSeconds: MAX_TEST_SECONDS,
      onTick: setElapsed,
      onMaxDuration: () => stopAndTranscribe()
    });
    setStatus('starting');
    try {
      await recorder.start();
    } catch (err) {
      setError({ message: getMicrophoneErrorMessage(err, t) });
      setStatus('error');
      return;
    }
    if (disposedRef.current) {
      recorder.cancel();
      return;
    }
    recorderRef.current = recorder;
    setStatus('recording');
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const busy = isBusy(status);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.voiceInput.test.recording.title', 'Recording (record → transcribe)')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.voiceInput.test.recording.description',
            'Record a short clip (up to {{seconds}} seconds) and transcribe it with a transcription model over the same connection a chat uses, then see how long the transcript took.',
            { seconds: MAX_TEST_SECONDS }
          )}
        </p>
      </div>

      <ModelPicker
        models={models}
        modelId={modelId}
        disabled={busy}
        onChange={setSelectedModelId}
        language={language}
        t={t}
      />

      <RecordingControls
        status={status}
        elapsed={elapsed}
        onStart={start}
        onStop={stopAndTranscribe}
        onCancel={cancel}
        startDisabled={busy || !modelId}
        t={t}
      />

      <RecordingOutcome
        status={status}
        transcript={transcript}
        durationSeconds={durationSeconds}
        processingMs={processingMs}
        error={error}
        t={t}
      />
    </div>
  );
}

export default RecordingTest;
