import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveVoiceModeSettings } from '../../../../../shared/voiceMode.js';
import useVoiceMode from '../hooks/useVoiceMode';
import {
  isVoiceModeBrowserSupported,
  isSpeechChoiceUsable
} from '../hooks/useVoiceModeAvailability';
import VoiceModeDock from './VoiceModeDock';
import { VoiceWaveIcon } from './VoiceModeButton';

/** What Tab can reach inside the dialog. The voice view's own root (tabindex -1) is left out on purpose. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

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
 * The speech section the way the speech adapters read it. The form holds the
 * Azure subscription key itself (redacted after a save, typed before one);
 * the adapter wants to know whether the server holds one (`keyConfigured`),
 * because it then fetches its tokens from the server, which uses the SAVED key.
 * The key is never passed on.
 */
function toPublicSpeech(speech) {
  const azure = speech?.azure || {};
  return {
    ...speech,
    azure: {
      enabled: Boolean(azure.enabled),
      host: azure.host || '',
      region: azure.region || '',
      keyConfigured: Boolean(azure.keyConfigured ?? azure.subscriptionKey)
    }
  };
}

/**
 * Admin → Voice Input: try voice mode with the settings on the page, before
 * saving them. It runs a real session — microphone, the platform's default
 * speech service, turn detection, text-to-speech — but without a chat model:
 * the app repeats what it heard, so an admin hears the whole loop (and the
 * latency of it) without picking an app.
 *
 * Everything runs with the form's settings except two things: the conversation
 * socket of a transcription model checks the SAVED switch (`speech.voiceMode.
 * enabled`) like it does for every user, so that service needs it saved once;
 * and Azure Speech signs in with the SAVED subscription key, so a key that was
 * just typed has to be saved before it is tried.
 *
 * @param {Object} props
 * @param {object} props.speech - The `speech` section as it is in the form (unsaved).
 * @param {boolean} [props.savedEnabled] - `speech.voiceMode.enabled` is saved as true.
 */
export default function VoiceModeTryButton({ speech, savedEnabled = true }) {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const cardRef = useRef(null);

  const availability = useMemo(() => {
    const settings = {
      ...resolveVoiceModeSettings({ platform: { speech }, app: null }),
      enabled: true
    };
    const choice = defaultChoiceOf(speech);
    const usable = isSpeechChoiceUsable(choice, speech) && isVoiceModeBrowserSupported();
    const needsSave = choice.service === 'model' && !savedEnabled;
    return {
      available: usable && Boolean(settings.ttsModelId) && !needsSave,
      reason: needsSave ? 'save-first' : null,
      settings,
      speech: choice,
      platformSpeech: toPublicSpeech(speech),
      ttsModelId: settings.ttsModelId
    };
  }, [speech, savedEnabled]);

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

  let tryTitle = t('voiceMode.try.title', 'Talk to the app with the settings on this page');
  if (availability.reason === 'save-first') {
    tryTitle = t(
      'voiceMode.try.saveFirst',
      'Save the page with "Enable voice mode" ticked first: a transcription model checks the saved setting'
    );
  } else if (!availability.available) {
    tryTitle = t(
      'voiceMode.try.unavailable',
      'Needs a text-to-speech model, a working speech service and a browser with microphone support'
    );
  }

  // The page behind the dialog is out of reach: Tab and Shift+Tab wrap inside
  // the card. Focus starts on the voice view's root, which is not in the list,
  // so Shift+Tab from there lands on the last control. A listener on the node,
  // like `useFocusTrap`'s: a key handler on a dialog element is not a control.
  useEffect(() => {
    const card = cardRef.current;
    if (!voiceMode.active || !card) return undefined;
    const keepTabInside = event => {
      if (event.key !== 'Tab') return;
      const items = Array.from(card.querySelectorAll(FOCUSABLE_SELECTOR));
      if (items.length === 0) return;
      const current = document.activeElement;
      if (event.shiftKey && (current === items[0] || !items.includes(current))) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (
        !event.shiftKey &&
        (current === items[items.length - 1] || !items.includes(current))
      ) {
        event.preventDefault();
        items[0].focus();
      }
    };
    card.addEventListener('keydown', keepTabInside);
    return () => card.removeEventListener('keydown', keepTabInside);
  }, [voiceMode.active]);

  return (
    <>
      <button
        type="button"
        onClick={voiceMode.toggle}
        disabled={!availability.available}
        title={tryTitle}
        className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <VoiceWaveIcon className="h-4 w-4" />
        {t('voiceMode.try.button', 'Try it')}
      </button>
      {voiceMode.active && (
        // The backdrop is a click target only for the mouse: the keyboard closes
        // the dialog with Esc, which the voice view handles.
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={event => {
            if (event.target === event.currentTarget) voiceMode.end('user');
          }}
        >
          {/* `min(32rem, 100%)`: on a phone in landscape a fixed 32rem card is
              taller than the screen and its controls fall off the bottom. A
              small chat with the dock under it, like voice mode in an app;
              `data-voice-scope` lets the dock mark the echo as it is read out. */}
          <div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('voiceMode.try.heading', 'Voice mode test')}
            data-voice-scope
            className="relative flex h-[min(32rem,100%)] w-full max-w-lg flex-col rounded-2xl bg-white px-4 pt-4 shadow-xl dark:bg-gray-900"
          >
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('voiceMode.try.heading', 'Voice mode test')}
            </h2>
            <div
              role="log"
              aria-label={t('chat.messageList', 'Chat messages')}
              className="my-3 min-h-0 flex-1 space-y-3 overflow-y-auto"
            >
              {messages.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('voiceMode.try.intro', 'Say something. The app repeats what it heard.')}
                </p>
              ) : (
                messages.map(message => (
                  <div
                    key={message.id}
                    data-message-role={message.role}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                        message.role === 'user'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                      }`}
                    >
                      <div className="markdown-content">{message.content}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <VoiceModeDock voiceMode={voiceMode} value={draft} onChange={setDraft} />
          </div>
        </div>
      )}
    </>
  );
}
