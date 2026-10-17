import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveVoiceModeSettings } from '../../../../../shared/voiceMode.js';
import useVoiceMode from '../hooks/useVoiceMode';
import {
  isVoiceModeBrowserSupported,
  isSpeechChoiceUsable
} from '../hooks/useVoiceModeAvailability';
import VoiceModeOverlay from './VoiceModeOverlay';
import { VoiceWaveIcon } from './VoiceModeButton';

/**
 * The speech service the form's default stands for. The admin form holds the
 * raw `speech` section, which has no `dictation.available` (the server adds it
 * for the public config), so `getPlatformDefaultService` cannot be used on it.
 */
function defaultChoiceOf(speech) {
  if (speech?.defaultService === 'model' && speech.dictation?.modelId) {
    return { service: 'model', modelId: speech.dictation.modelId };
  }
  if (speech?.defaultService === 'azure' && speech.azure?.enabled) {
    return { service: 'azure', modelId: '' };
  }
  return { service: 'browser', modelId: '' };
}

/**
 * Admin → Voice Input: try voice mode with the settings on the page, before
 * saving them. It runs a real session — microphone, the platform's default
 * speech service, turn detection, text-to-speech — but without a chat model:
 * the app repeats what it heard, so an admin hears the whole loop (and the
 * latency of it) without picking an app.
 *
 * @param {Object} props
 * @param {object} props.speech - The `speech` section as it is in the form (unsaved).
 */
export default function VoiceModeTryButton({ speech }) {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState([]);

  const availability = useMemo(() => {
    const settings = {
      ...resolveVoiceModeSettings({ platform: { speech }, app: null }),
      enabled: true
    };
    const choice = defaultChoiceOf(speech);
    const usable = isSpeechChoiceUsable(choice, speech) && isVoiceModeBrowserSupported();
    return {
      available: usable && Boolean(settings.ttsModelId),
      reason: null,
      settings,
      speech: choice,
      platformSpeech: speech,
      ttsModelId: settings.ttsModelId
    };
  }, [speech]);

  // No chat model behind it: the answer is the transcript, said back.
  const sendTurn = useCallback(
    async text => {
      const stamp = Date.now();
      setMessages(prev => [
        ...prev,
        { id: `try-user-${stamp}`, role: 'user', content: text },
        {
          id: `try-assistant-${stamp}`,
          role: 'assistant',
          loading: false,
          content: t('voiceMode.try.echo', {
            defaultValue: 'You said: {{text}}',
            text
          })
        }
      ]);
      return true;
    },
    [t]
  );

  const voiceMode = useVoiceMode({
    availability,
    language: i18n.language,
    messages,
    processing: false,
    clarificationPending: false,
    sendTurn,
    answerClarification: () => {},
    cancelGeneration: () => {}
  });

  return (
    <>
      <button
        type="button"
        onClick={voiceMode.toggle}
        disabled={!availability.available}
        title={
          availability.available
            ? t('voiceMode.try.title', 'Talk to the app with the settings on this page')
            : t(
                'voiceMode.try.unavailable',
                'Needs a text-to-speech model, a working speech service and a browser with microphone support'
              )
        }
        className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <VoiceWaveIcon className="h-4 w-4" />
        {t('voiceMode.try.button', 'Try it')}
      </button>
      {voiceMode.active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="relative h-[32rem] w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900">
            <VoiceModeOverlay
              voiceMode={voiceMode}
              appName={t('voiceMode.try.heading', 'Voice mode test')}
            />
          </div>
        </div>
      )}
    </>
  );
}
