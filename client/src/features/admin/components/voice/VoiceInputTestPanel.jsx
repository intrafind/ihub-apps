import Icon from '../../../../shared/components/Icon';
import MicrophoneCheck from './MicrophoneCheck';
import DictationTest from './DictationTest';
import RecordingTest from './RecordingTest';

/**
 * Admin → Voice Input → "Test voice input": end-to-end checks that run in the
 * admin's own browser, on the same code path end users hit, against the SAVED
 * configuration (the WebSocket proxy and the Azure token route read the saved
 * platform config, not the form).
 *
 * @param {object} props
 * @param {object} props.speech Saved speech config in the public client shape.
 * @param {Array|null} props.models Enabled transcription models (null while loading).
 * @param {boolean} props.dirty The form has unsaved changes.
 * @param {Function} props.t
 * @param {string} props.language
 */
function VoiceInputTestPanel({ speech, models, dirty, t, language }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.voiceInput.test.title', 'Test voice input')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t(
            'admin.voiceInput.test.description',
            'Runs in this browser with your microphone, on the same path users take in a chat, against the saved configuration.'
          )}
        </p>
      </div>

      {dirty && (
        <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-md p-3 flex items-start gap-2">
          <Icon name="exclamation-triangle" className="w-4 h-4 mt-0.5 shrink-0" />
          {t(
            'admin.voiceInput.test.unsaved',
            'You have unsaved changes. These tests use the saved configuration, so save first to test your changes.'
          )}
        </p>
      )}

      <MicrophoneCheck t={t} />
      <hr className="border-gray-100 dark:border-gray-700" />
      {/* Remount on a new saved default so the preselected service follows it. */}
      <DictationTest key={speech.defaultService} speech={speech} t={t} language={language} />
      <hr className="border-gray-100 dark:border-gray-700" />
      <RecordingTest speech={speech} models={models} t={t} language={language} />
    </div>
  );
}

export default VoiceInputTestPanel;
