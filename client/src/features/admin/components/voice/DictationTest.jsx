import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import {
  RECOGNITION_LOCALES,
  SPEECH_SERVICES,
  createSpeechRecognizer,
  getPlatformDefaultService,
  getRecognitionErrorMessage,
  getSpeechServiceLabel,
  isBrowserSpeechSupported,
  isSpeechServiceEnabled,
  parseRecognitionResult,
  toRecognitionLang
} from '../../../voice/utils/speechService';

const selectClass =
  'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-gray-700 dark:text-gray-300';

const BUSY = ['starting', 'listening', 'stopping'];

/**
 * Live (realtime) dictation test: runs the same recognizer the chat's
 * microphone button uses, against the saved platform configuration, and shows
 * the interim and final transcript as they arrive.
 *
 * @param {object} props
 * @param {object} props.speech Saved speech config in the public client shape.
 * @param {Function} props.t
 * @param {string} props.language UI language, preselects the recognition locale.
 */
function DictationTest({ speech, t, language }) {
  const [service, setService] = useState(() => getPlatformDefaultService(speech));
  const [lang, setLang] = useState(() => toRecognitionLang(language));
  const [mode, setMode] = useState('manual');
  const [status, setStatus] = useState('idle');
  const [interim, setInterim] = useState('');
  const [finalText, setFinalText] = useState('');
  const [error, setError] = useState('');
  const [firstResultMs, setFirstResultMs] = useState(null);
  const recognitionRef = useRef(null);

  const release = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  // Stop the recognizer (and free the mic / socket) when the page is left.
  useEffect(() => release, [release]);

  const fail = message => {
    setError(message);
    setStatus('error');
  };

  const start = async () => {
    setError('');
    setInterim('');
    setFinalText('');
    setFirstResultMs(null);
    setStatus('starting');

    if (service === 'browser' && !isBrowserSpeechSupported()) {
      fail(t('voiceInput.error.notSupported', 'Speech recognition not supported in this browser'));
      return;
    }

    let recognition;
    try {
      recognition = createSpeechRecognizer(service, { speech });
    } catch (err) {
      fail(err.message);
      return;
    }
    recognition.continuous = mode === 'manual';
    recognition.interimResults = true;
    recognition.lang = lang;
    const usesTextEventShape = recognition.usesTextEventShape === true;

    if (typeof recognition.initRecognizer === 'function') {
      try {
        await recognition.initRecognizer();
      } catch (err) {
        fail(
          err.message ||
            t('voiceInput.error.service', 'Transcription service unavailable. Please try again.')
        );
        return;
      }
    }

    // Events of a recognizer the user already replaced (restart right after a
    // stop) must not touch the current run.
    const isCurrent = () => recognitionRef.current === recognition;
    const startedAt = performance.now();
    let committed = '';

    recognition.onstart = () => {
      if (isCurrent()) setStatus('listening');
    };
    recognition.onresult = event => {
      if (!isCurrent()) return;
      const { interim: interimText, final } = parseRecognitionResult(event, usesTextEventShape);
      if (interimText || final) {
        setFirstResultMs(previous => previous ?? Math.round(performance.now() - startedAt));
      }
      if (final) {
        committed = `${committed} ${final}`.trim();
        setFinalText(committed);
        setInterim('');
      } else {
        setInterim(interimText);
      }
    };
    recognition.onerror = event => {
      if (isCurrent()) fail(getRecognitionErrorMessage(event, t));
    };
    recognition.onend = () => {
      if (!isCurrent()) return;
      recognitionRef.current = null;
      setStatus(previous => (previous === 'error' ? previous : 'done'));
    };

    recognitionRef.current = recognition;
    try {
      await recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      fail(
        err?.message ||
          t('voiceInput.error.startError', 'Error starting voice input. Please try again.')
      );
    }
  };

  const stop = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    setStatus('stopping');
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  };

  const busy = BUSY.includes(status);
  const serviceDisabled = !isSpeechServiceEnabled(service, speech);
  const noSpeech = status === 'done' && !finalText && !interim;

  const statusText = {
    starting: t('admin.voiceInput.test.dictation.starting', 'Connecting…'),
    listening: t('admin.voiceInput.test.dictation.listening', 'Listening: speak now.'),
    stopping: t('admin.voiceInput.test.dictation.stopping', 'Finishing…'),
    done: t('admin.voiceInput.test.dictation.done', 'Finished.')
  }[status];

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.voiceInput.test.dictation.title', 'Live dictation (realtime)')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.voiceInput.test.dictation.description',
            'Speak into the microphone and watch the transcript arrive, exactly as the microphone button in a chat does.'
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={labelClass} htmlFor="voice-test-service">
            {t('admin.voiceInput.test.dictation.service', 'Service')}
          </label>
          <select
            id="voice-test-service"
            value={service}
            disabled={busy}
            onChange={e => setService(e.target.value)}
            className={selectClass}
          >
            {SPEECH_SERVICES.map(value => (
              <option key={value} value={value}>
                {getSpeechServiceLabel(value, t)}
                {!isSpeechServiceEnabled(value, speech)
                  ? ` (${t('admin.voiceInput.notEnabled', 'not enabled')})`
                  : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="voice-test-lang">
            {t('admin.voiceInput.test.dictation.language', 'Language')}
          </label>
          <select
            id="voice-test-lang"
            value={lang}
            disabled={busy}
            onChange={e => setLang(e.target.value)}
            className={selectClass}
          >
            {(RECOGNITION_LOCALES.includes(lang) ? [] : [lang])
              .concat(RECOGNITION_LOCALES)
              .map(locale => (
                <option key={locale} value={locale}>
                  {locale}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="voice-test-mode">
            {t('admin.voiceInput.test.dictation.mode', 'Mode')}
          </label>
          <select
            id="voice-test-mode"
            value={mode}
            disabled={busy}
            onChange={e => setMode(e.target.value)}
            className={selectClass}
          >
            <option value="manual">
              {t('admin.apps.edit.manualMode', 'Manual (Click to Record)')}
            </option>
            <option value="automatic">
              {t('admin.apps.edit.automaticMode', 'Automatic (Voice Activation)')}
            </option>
          </select>
        </div>
      </div>

      {serviceDisabled && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t(
            'admin.voiceInput.test.dictation.serviceDisabled',
            'This backend is not enabled in the saved configuration, so the test is expected to fail.'
          )}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={busy ? stop : start}
          disabled={status === 'stopping' || status === 'starting'}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 text-sm font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50"
        >
          <Icon name="microphone" className="w-4 h-4" />
          {busy
            ? t('admin.voiceInput.test.dictation.stop', 'Stop')
            : t('admin.voiceInput.test.dictation.start', 'Start dictation test')}
        </button>
        {statusText && (
          <span className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
            {statusText}
          </span>
        )}
        {firstResultMs !== null && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.voiceInput.test.dictation.firstResult', 'First text after {{ms}} ms', {
              ms: firstResultMs
            })}
          </span>
        )}
      </div>

      {(finalText || interim) && (
        <div
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap"
          data-testid="dictation-transcript"
        >
          {finalText}
          {interim && (
            <span className="text-gray-500 dark:text-gray-400">
              {finalText ? ' ' : ''}
              {interim}
            </span>
          )}
        </div>
      )}

      {status === 'done' && finalText && (
        <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
          <Icon name="check-circle" className="w-4 h-4 shrink-0" />
          {t('admin.voiceInput.test.dictation.success', 'Dictation works.')}
        </p>
      )}
      {noSpeech && (
        <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <Icon name="exclamation-triangle" className="w-4 h-4 shrink-0" />
          {t(
            'admin.voiceInput.test.dictation.noText',
            'No text was recognized. Use the microphone check to confirm the microphone picks up sound.'
          )}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1" role="alert">
          <Icon name="clearCircle" className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export default DictationTest;
