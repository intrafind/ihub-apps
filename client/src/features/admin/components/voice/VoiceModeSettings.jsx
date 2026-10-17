import Icon from '../../../../shared/components/Icon';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import VoiceModeTryButton from '../../../voice/components/VoiceModeTryButton';
import {
  BUILT_IN_VOICE_PROMPTS,
  DEFAULT_VOICE_MODE,
  END_OF_TURN_SILENCE_RANGE,
  MAX_SESSION_MINUTES_RANGE,
  VOICE_INSTRUCTION_MAX_CHARS,
  VOICE_LISTENING_STYLES,
  VOICE_PROMPT_LANGUAGES,
  VOICE_THINKING_LEVELS,
  clampNumber
} from '../../utils/voiceMode';

const inputClass =
  'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';
const checkboxClass = 'rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500';

const LANGUAGE_NAMES = { en: 'English', de: 'Deutsch' };
const THINKING_LABELS = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High' };

/**
 * Admin → Voice Input → "Voice mode": the platform settings of the spoken
 * conversation with an app (`platform.speech.voiceMode`). Speech-to-text is not
 * set here: voice mode uses the speech service of the app's voice input.
 *
 * @param {object} props
 * @param {object} props.voiceMode Form-shaped `speech.voiceMode`.
 * @param {(patch: object) => void} props.onChange Merges `patch` into `voiceMode`.
 * @param {Array|null} props.ttsModels Every text-to-speech model (null while loading).
 * @param {string} props.defaultTtsModelId `speech.tts.defaultModelId` of the form.
 * @param {boolean} props.flagEnabled The `voiceMode` preview feature flag is on.
 * @param {object} props.speech The `speech` section as the form holds it, unsaved: what "Try it"
 *   runs with.
 * @param {boolean} [props.savedEnabled] Voice mode is switched on in the saved config.
 * @param {Function} props.t
 * @param {string} props.language UI language.
 */
function VoiceModeSettings({
  voiceMode,
  onChange,
  ttsModels,
  defaultTtsModelId,
  flagEnabled,
  speech,
  savedEnabled = true,
  t,
  language
}) {
  const modelName = model => getLocalizedContent(model.name, language) || model.id;
  const models = ttsModels || [];
  const ttsModelId = voiceMode.ttsModelId;
  const chosenModel = models.find(m => m.id === ttsModelId);
  const defaultModel = models.find(m => m.id === defaultTtsModelId);
  const chosenMissing = !!ttsModelId && Array.isArray(ttsModels) && !chosenModel;
  const chosenDisabled = !!chosenModel && chosenModel.enabled === false;
  const noTtsModel = !ttsModelId && !defaultTtsModelId;
  const defaultOptionLabel = defaultTtsModelId
    ? t(
        'admin.voiceInput.voiceMode.ttsModelDefaultNamed',
        'Default text-to-speech model ({{model}})',
        { model: defaultModel ? modelName(defaultModel) : defaultTtsModelId }
      )
    : t('admin.voiceInput.voiceMode.ttsModelDefault', 'Default text-to-speech model');

  // The one thing to tell the admin about the model, the most pressing first.
  const ttsHint = (() => {
    if (chosenMissing) {
      return {
        warn: true,
        text: t(
          'admin.voiceInput.voiceMode.ttsModelMissing',
          'This model no longer exists, so voice mode is not offered.'
        )
      };
    }
    if (chosenDisabled) {
      return {
        warn: true,
        text: t(
          'admin.voiceInput.voiceMode.ttsModelDisabledHint',
          'This model is disabled, so voice mode is not offered. Enable it under Admin → Models and make sure it has an API key.'
        )
      };
    }
    if (noTtsModel) {
      return {
        warn: true,
        text: t(
          'admin.voiceInput.voiceMode.ttsModelNone',
          'No text-to-speech model is set here or under "Read aloud" above, so voice mode is not offered.'
        )
      };
    }
    return {
      warn: false,
      text: t(
        'admin.voiceInput.voiceMode.ttsModelHint',
        'Leave on the default to use the read-aloud model. Apps can pick their own, for example a German voice model. Users need access to the model through their groups.'
      )
    };
  })();

  const numberProps = (field, range) => ({
    value: voiceMode[field],
    min: range.min,
    max: range.max,
    step: range.step,
    onChange: e => onChange({ [field]: e.target.value === '' ? '' : Number(e.target.value) }),
    // Out-of-range input is only corrected once the admin leaves the field.
    onBlur: () =>
      onChange({ [field]: clampNumber(voiceMode[field], range, DEFAULT_VOICE_MODE[field]) })
  });

  const setPrompt = (code, text) => {
    const next = { ...voiceMode.systemPrompt };
    if (text) next[code] = text;
    else delete next[code];
    onChange({ systemPrompt: next });
  };

  return (
    <div
      data-testid="voice-mode-section"
      className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4"
    >
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          {t('admin.voiceInput.voiceMode.title', 'Voice mode')}
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300">
            {t('admin.voiceInput.voiceMode.preview', 'Preview')}
          </span>
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t(
            'admin.voiceInput.voiceMode.description',
            'A spoken conversation with an app: users talk, the app answers out loud, and they can interrupt. Speech-to-text is whatever the app uses for voice input (see above); the answer is spoken by the text-to-speech model below. Audio is never stored.'
          )}
        </p>
      </div>

      {!flagEnabled && (
        <p
          data-testid="voice-mode-flag-note"
          className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-md p-3 flex items-start gap-2"
        >
          <Icon name="exclamation-triangle" className="w-4 h-4 mt-0.5 shrink-0" />
          {t(
            'admin.voiceInput.voiceMode.flagOff',
            'Voice mode is a preview feature and is switched off. Enable the "Voice Mode" preview feature under Admin → Features first. You can already prepare the settings here, but nothing takes effect until then.'
          )}
        </p>
      )}

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            id="voice-mode-enabled"
            type="checkbox"
            checked={!!voiceMode.enabled}
            onChange={e => onChange({ enabled: e.target.checked })}
            className={checkboxClass}
          />
          {t('admin.voiceInput.voiceMode.enabled', 'Enable voice mode')}
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            id="voice-mode-app-default"
            type="checkbox"
            checked={!!voiceMode.appDefault}
            onChange={e => onChange({ appDefault: e.target.checked })}
            className={checkboxClass}
          />
          {t(
            'admin.voiceInput.voiceMode.appDefault',
            'Turn voice mode on for apps that do not decide themselves'
          )}
        </label>
        <p className={hintClass}>
          {t(
            'admin.voiceInput.voiceMode.appDefaultHint',
            'Off: voice mode is opt-in, each app turns it on in the app editor. On: every app that allows voice input has it, unless the app turns it off.'
          )}
        </p>
      </div>

      <div>
        <label className={labelClass} htmlFor="voice-mode-tts-model">
          {t('admin.voiceInput.voiceMode.ttsModel', 'Text-to-speech model')}
        </label>
        <select
          id="voice-mode-tts-model"
          value={ttsModelId}
          onChange={e => onChange({ ttsModelId: e.target.value })}
          className={inputClass}
        >
          <option value="">{defaultOptionLabel}</option>
          {chosenMissing && <option value={ttsModelId}>{ttsModelId}</option>}
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {modelName(m)}
              {m.enabled === false
                ? ` (${t('admin.voiceInput.tts.modelDisabled', 'disabled')})`
                : ''}
            </option>
          ))}
        </select>
        <p
          className={`mt-1 text-xs ${
            ttsHint.warn ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {ttsHint.text}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="voice-mode-listening-style">
            {t('admin.voiceInput.voiceMode.listeningStyle', 'Listening style')}
          </label>
          <select
            id="voice-mode-listening-style"
            value={voiceMode.listeningStyle}
            onChange={e => onChange({ listeningStyle: e.target.value })}
            className={inputClass}
          >
            {VOICE_LISTENING_STYLES.map(style => (
              <option key={style} value={style}>
                {style === 'hands-free'
                  ? t('admin.voiceInput.voiceMode.handsFree', 'Hands-free')
                  : t('admin.voiceInput.voiceMode.pushToTalk', 'Push-to-talk')}
              </option>
            ))}
          </select>
          <p className={hintClass}>
            {t(
              'admin.voiceInput.voiceMode.listeningStyleHint',
              'Hands-free listens all the time and ends a turn after a pause. Push-to-talk records while the button or the Space bar is held.'
            )}
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="voice-mode-thinking-level">
            {t('admin.voiceInput.voiceMode.thinkingLevel', 'Reasoning effort')}
          </label>
          <select
            id="voice-mode-thinking-level"
            value={voiceMode.thinkingLevel}
            onChange={e => onChange({ thinkingLevel: e.target.value })}
            className={inputClass}
          >
            {VOICE_THINKING_LEVELS.map(level => (
              <option key={level} value={level}>
                {t(`admin.voiceInput.voiceMode.thinking.${level}`, THINKING_LABELS[level])}
              </option>
            ))}
          </select>
          <p className={hintClass}>
            {t(
              'admin.voiceInput.voiceMode.thinkingLevelHint',
              'Reasoning models add seconds of silence before the answer. A low level keeps replies quick; an app that asks for more keeps its own level.'
            )}
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="voice-mode-silence">
            {t('admin.voiceInput.voiceMode.endOfTurnSilenceMs', 'End of turn after silence (ms)')}
          </label>
          <input
            id="voice-mode-silence"
            type="number"
            {...numberProps('endOfTurnSilenceMs', END_OF_TURN_SILENCE_RANGE)}
            className={inputClass}
          />
          <p className={hintClass}>
            {t(
              'admin.voiceInput.voiceMode.endOfTurnSilenceMsHint',
              'Hands-free only: how long the user must pause before the app answers. {{min}} to {{max}}, default {{default}}.',
              {
                min: END_OF_TURN_SILENCE_RANGE.min,
                max: END_OF_TURN_SILENCE_RANGE.max,
                default: DEFAULT_VOICE_MODE.endOfTurnSilenceMs
              }
            )}
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="voice-mode-max-minutes">
            {t('admin.voiceInput.voiceMode.maxSessionMinutes', 'Longest session (minutes)')}
          </label>
          <input
            id="voice-mode-max-minutes"
            type="number"
            {...numberProps('maxSessionMinutes', MAX_SESSION_MINUTES_RANGE)}
            className={inputClass}
          />
          <p className={hintClass}>
            {t(
              'admin.voiceInput.voiceMode.maxSessionMinutesHint',
              'A voice session ends after this time. {{min}} to {{max}}, default {{default}}.',
              {
                min: MAX_SESSION_MINUTES_RANGE.min,
                max: MAX_SESSION_MINUTES_RANGE.max,
                default: DEFAULT_VOICE_MODE.maxSessionMinutes
              }
            )}
          </p>
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            id="voice-mode-barge-in"
            type="checkbox"
            checked={!!voiceMode.bargeIn}
            onChange={e => onChange({ bargeIn: e.target.checked })}
            className={checkboxClass}
          />
          {t('admin.voiceInput.voiceMode.bargeIn', 'Let users interrupt the answer by speaking')}
        </label>
        <p className={hintClass}>
          {t(
            'admin.voiceInput.voiceMode.bargeInHint',
            'Turn this off for laptop speakers without headphones, where the app could hear itself. Users can still stop an answer with a tap.'
          )}
        </p>
      </div>

      <div className="space-y-3 pt-2 border-t border-gray-100 dark:border-gray-700">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.voiceInput.voiceMode.systemPrompt.title', 'Voice style instruction')}
          </h3>
          <p className={hintClass}>
            {t(
              'admin.voiceInput.voiceMode.systemPrompt.description',
              "Added after the app's system prompt in voice mode so answers suit being heard. Leave a language empty to use the built-in text, shown below each field."
            )}
          </p>
        </div>
        {VOICE_PROMPT_LANGUAGES.map(code => {
          const text = voiceMode.systemPrompt?.[code] || '';
          return (
            <div key={code}>
              <div className="flex items-center justify-between gap-3">
                <label className={labelClass} htmlFor={`voice-mode-prompt-${code}`}>
                  {t(
                    'admin.voiceInput.voiceMode.systemPrompt.language',
                    'Instruction ({{language}})',
                    {
                      language: LANGUAGE_NAMES[code]
                    }
                  )}
                </label>
                <button
                  type="button"
                  onClick={() => setPrompt(code, '')}
                  disabled={!text}
                  className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline"
                >
                  {t('admin.voiceInput.voiceMode.systemPrompt.reset', 'Reset to built-in')}
                </button>
              </div>
              <textarea
                id={`voice-mode-prompt-${code}`}
                rows={4}
                maxLength={VOICE_INSTRUCTION_MAX_CHARS}
                value={text}
                onChange={e => setPrompt(code, e.target.value)}
                placeholder={BUILT_IN_VOICE_PROMPTS[code]}
                className={inputClass}
              />
              <p className={hintClass} data-testid={`voice-mode-builtin-${code}`}>
                <span className="font-medium">
                  {t('admin.voiceInput.voiceMode.systemPrompt.builtIn', 'Built-in:')}
                </span>{' '}
                {BUILT_IN_VOICE_PROMPTS[code]}
              </p>
            </div>
          );
        })}
      </div>

      <div className="pt-2 border-t border-gray-100 dark:border-gray-700 space-y-2">
        <div className="flex items-center gap-3">
          {flagEnabled ? (
            <VoiceModeTryButton speech={speech} savedEnabled={savedEnabled} />
          ) : (
            <button
              type="button"
              disabled
              title={t(
                'admin.voiceInput.voiceMode.tryFlagOff',
                'Enable the "Voice Mode" preview feature first'
              )}
              className="inline-flex items-center px-3 py-2 rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 text-sm font-medium opacity-50 cursor-not-allowed"
            >
              {t('admin.voiceInput.voiceMode.tryIt', 'Try it')}
            </button>
          )}
        </div>
        <p className={hintClass}>
          {t(
            'admin.voiceInput.voiceMode.tryItHint',
            'Starts a voice session in this browser with the speech service chosen under "Voice input" above, the text-to-speech model and the settings in this form, without saving them. With a transcription model, "Enable voice mode" must have been saved once; it needs the microphone and a text-to-speech model that is enabled.'
          )}
        </p>
      </div>
    </div>
  );
}

export default VoiceModeSettings;
