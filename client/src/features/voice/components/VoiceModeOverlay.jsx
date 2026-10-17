import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getTranscriptionErrorMessage } from '../../../utils/transcriptionErrors';
import { VOICE_STATUS } from '../utils/voiceModeReducer';
import './VoiceMode.css';

const INTERACTIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']);

/** Typing into something, or on a control Space would activate: Space is not push-to-talk there. */
function isSpaceReserved(target) {
  if (!target || typeof target !== 'object') return false;
  return Boolean(target.isContentEditable) || INTERACTIVE_TAGS.has(target.tagName);
}

/** Keeps the orb moving with the mic level without re-rendering anything. */
function useOrbLevel(orbRef, levelRef) {
  useEffect(() => {
    let frame = 0;
    let shown = 0;
    const tick = () => {
      // Ease towards the level so the orb does not flicker on single frames.
      shown += (levelRef.current - shown) * 0.35;
      orbRef.current?.style.setProperty('--voice-level', shown.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [orbRef, levelRef]);
}

/**
 * The error shown for a code from the session, in the user's language. The
 * message the session carries is never shown: it comes from the browser, an
 * adapter or the server, in English, and is meant for the debug log.
 */
function errorMessage(error, t) {
  switch (error?.code) {
    case 'mic-denied':
      return t(
        'voiceMode.errors.micDenied',
        'Microphone access was blocked. Allow it in your browser settings and try again.'
      );
    case 'mic-missing':
      return t('voiceMode.errors.micMissing', 'No microphone was found.');
    case 'mic-busy':
      return t(
        'voiceInput.error.microphoneBusy',
        'The microphone could not be started. It may be in use by another application.'
      );
    case 'mic-lost':
      return t('voiceMode.errors.micLost', 'The microphone stopped working.');
    case 'unsupported':
    case 'audio-unsupported':
      return t('voiceMode.errors.unsupported', 'Voice mode is not supported in this browser.');
    case 'vad-unavailable':
      return t(
        'voiceMode.errors.voiceDetection',
        'Voice detection could not be loaded. Reload the page and try again.'
      );
    case 'feature-disabled':
    case 'voice-mode-disabled':
      return t('voiceMode.errors.disabled', 'Voice mode is switched off.');
    case 'closed':
    case 'connection':
      return t('voiceMode.errors.connection', 'The connection to speech recognition was lost.');
    case 'not-permitted':
    case 'server-busy':
    case 'session-limit':
      return getTranscriptionErrorMessage(error, t);
    case 'service':
    case 'no-model':
    case 'unknown-model':
    case 'model-disabled':
    case 'no-endpoint':
      return t(
        'voiceMode.errors.service',
        'The speech service is not available. Please try again.'
      );
    default:
      return t('voiceMode.errors.generic', 'Voice mode stopped because of an error.');
  }
}

function SettingsPopover({ voiceMode, onClose, labelledBy }) {
  const { t } = useTranslation();
  const { prefs } = voiceMode;
  const ref = useRef(null);

  useEffect(() => {
    const onPointerDown = event => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onClose]);

  const radio = (value, label) => (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
      <input
        type="radio"
        name="voice-listening-style"
        value={value}
        checked={prefs.listeningStyle === value}
        onChange={() => voiceMode.setListeningStyle(value)}
        className="h-4 w-4 text-indigo-600"
      />
      {label}
    </label>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={labelledBy}
      className="absolute right-3 top-12 z-10 w-72 rounded-xl border border-gray-200 bg-white p-4 text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
    >
      <h3 id={labelledBy} className="mb-2 text-sm font-semibold">
        {t('voiceMode.settings.title', 'Voice settings')}
      </h3>

      <fieldset className="mb-3">
        <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('voiceMode.settings.listeningStyle', 'Listening')}
        </legend>
        {radio(
          'hands-free',
          t('voiceMode.settings.handsFree', 'Hands-free: I answer when you pause')
        )}
        {radio(
          'push-to-talk',
          t('voiceMode.settings.pushToTalk', 'Push to talk: hold Space or the button')
        )}
      </fieldset>

      <label className="flex cursor-pointer items-start gap-2 py-1 text-sm">
        <input
          type="checkbox"
          checked={prefs.bargeIn}
          onChange={event => voiceMode.setBargeIn(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded text-indigo-600"
        />
        <span>
          {t('voiceMode.settings.bargeIn', 'Let me interrupt by speaking')}
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t(
              'voiceMode.settings.bargeInHint',
              'Turn this off on laptop speakers if the answer cuts itself off. Headphones work best.'
            )}
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
        <input
          type="checkbox"
          checked={prefs.captions}
          onChange={event => voiceMode.setCaptions(event.target.checked)}
          className="h-4 w-4 rounded text-indigo-600"
        />
        {t('voiceMode.settings.captions', 'Show captions')}
      </label>
    </div>
  );
}

/**
 * The voice view: it covers the message area (the header stays visible) while
 * voice mode is open. An orb that follows the microphone and the app's speech,
 * the state in words, live captions, and the controls — Mute, Hold to talk
 * (push-to-talk), End — plus the settings.
 *
 * The chat's messages stay mounted behind it and every turn lands in them as
 * text, so ending voice mode returns to a normal chat with the whole
 * conversation in it.
 *
 * @param {Object} props
 * @param {ReturnType<import('../hooks/useVoiceMode').useVoiceMode>} props.voiceMode
 * @param {string} [props.appName]
 */
export default function VoiceModeOverlay({ voiceMode, appName = '' }) {
  const { t } = useTranslation();
  const { state, prefs, levelRef } = voiceMode;
  const { status } = state;
  const rootRef = useRef(null);
  const orbRef = useRef(null);
  const captionRef = useRef(null);
  const settingsTitleId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [talkDown, setTalkDown] = useState(false);
  const pushToTalk = prefs.listeningStyle === 'push-to-talk';
  // A key or button still down when push-to-talk is switched off is not "held".
  const talkHeld = talkDown && pushToTalk;
  const ready = status !== VOICE_STATUS.CONNECTING && status !== VOICE_STATUS.ERROR;

  useOrbLevel(orbRef, levelRef);

  // Take focus on open, give it back on close.
  useEffect(() => {
    const previous = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
        previous.focus();
      }
    };
  }, []);

  const talkStart = voiceMode.pushToTalkStart;
  const talkEnd = voiceMode.pushToTalkEnd;
  const closeSettings = () => setSettingsOpen(false);

  // Esc ends voice mode (or closes the settings first); Space is push-to-talk.
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (settingsOpen) closeSettings();
        else voiceMode.end('user');
        return;
      }
      if (
        event.key === ' ' &&
        pushToTalk &&
        ready &&
        !settingsOpen &&
        !isSpaceReserved(event.target)
      ) {
        event.preventDefault();
        if (!event.repeat) {
          setTalkDown(true);
          talkStart();
        }
      }
    };
    const onKeyUp = event => {
      if (event.key === ' ' && pushToTalk) {
        setTalkDown(false);
        talkEnd();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [pushToTalk, ready, settingsOpen, talkStart, talkEnd, voiceMode]);

  // Keep the newest words of the answer in view.
  useEffect(() => {
    const element = captionRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.assistantCaption]);

  const label = (() => {
    switch (status) {
      case VOICE_STATUS.CONNECTING:
        return t('voiceMode.status.connecting', 'Connecting…');
      case VOICE_STATUS.LISTENING:
        return pushToTalk
          ? t('voiceMode.status.holdToTalk', 'Hold Space or the button to talk')
          : t('voiceMode.status.listening', 'Listening…');
      case VOICE_STATUS.USER_SPEAKING:
        return t('voiceMode.status.userSpeaking', 'Listening…');
      case VOICE_STATUS.THINKING:
        return state.toolStatus?.label || t('voiceMode.status.thinking', 'Thinking…');
      case VOICE_STATUS.SPEAKING:
        return t('voiceMode.status.speaking', 'Speaking…');
      case VOICE_STATUS.PAUSED:
        return t('voiceMode.status.paused', 'Microphone is muted');
      case VOICE_STATUS.ERROR:
        return errorMessage(state.error, t);
      default:
        return '';
    }
  })();

  const orbClickable = status === VOICE_STATUS.SPEAKING || status === VOICE_STATUS.THINKING;
  const canMute = status !== VOICE_STATUS.CONNECTING && status !== VOICE_STATUS.ERROR;
  const muted = status === VOICE_STATUS.PAUSED;
  const showCaptions = prefs.captions && (state.userCaption.text || state.assistantCaption);

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-label={t('voiceMode.overlay.label', 'Voice mode')}
      data-testid="voice-mode-overlay"
      className="absolute inset-0 z-30 flex flex-col rounded-lg bg-white/95 text-gray-900 outline-hidden backdrop-blur dark:bg-gray-900/95 dark:text-gray-100"
    >
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <span className="truncate text-sm font-medium text-gray-600 dark:text-gray-300">
          {appName}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSettingsOpen(open => !open)}
            aria-expanded={settingsOpen}
            aria-label={t('voiceMode.settings.open', 'Voice settings')}
            title={t('voiceMode.settings.open', 'Voice settings')}
            className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Icon name="cog" size="md" />
          </button>
          <button
            type="button"
            onClick={() => voiceMode.end('user')}
            aria-label={t('voiceMode.controls.end', 'End')}
            title={t('voiceMode.controls.endTitle', 'End voice mode (Esc)')}
            className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Icon name="close" size="md" />
          </button>
        </div>
      </header>
      {settingsOpen && (
        <SettingsPopover
          voiceMode={voiceMode}
          onClose={closeSettings}
          labelledBy={settingsTitleId}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
        <button
          ref={orbRef}
          type="button"
          className="voice-orb"
          data-status={status}
          data-clickable={orbClickable}
          disabled={!orbClickable}
          onClick={voiceMode.interrupt}
          aria-label={
            orbClickable
              ? t('voiceMode.controls.stopAnswer', 'Stop the answer and talk')
              : t('voiceMode.overlay.orb', 'Voice activity')
          }
        />

        <p
          role={status === VOICE_STATUS.ERROR ? 'alert' : 'status'}
          aria-live="polite"
          data-testid="voice-mode-status"
          className="max-w-md text-center text-lg font-medium"
        >
          {label}
        </p>
        {status === VOICE_STATUS.ERROR && (
          <button
            type="button"
            onClick={voiceMode.retry}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {t('voiceMode.controls.retry', 'Tap to retry')}
          </button>
        )}

        {showCaptions && (
          <div
            ref={captionRef}
            data-testid="voice-mode-captions"
            className="max-h-40 w-full max-w-xl overflow-y-auto text-center text-base leading-relaxed"
          >
            {state.userCaption.text && (
              <p
                className={
                  state.userCaption.final
                    ? 'text-gray-900 dark:text-gray-100'
                    : 'text-gray-500 dark:text-gray-400'
                }
              >
                {state.userCaption.text}
              </p>
            )}
            {state.assistantCaption && (
              <p className="mt-2 text-indigo-700 dark:text-indigo-300">{state.assistantCaption}</p>
            )}
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-3 px-4 pb-6 pt-3">
        <button
          type="button"
          onClick={() => voiceMode.setMuted(!muted)}
          disabled={!canMute}
          aria-pressed={muted}
          className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            muted
              ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200'
              : 'bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <Icon name="microphone" size="sm" solid={muted} />
          {muted ? t('voiceMode.controls.unmute', 'Unmute') : t('voiceMode.controls.mute', 'Mute')}
        </button>

        {pushToTalk && (
          <button
            type="button"
            disabled={!ready || muted}
            aria-pressed={talkHeld}
            onPointerDown={event => {
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setTalkDown(true);
              talkStart();
            }}
            onPointerUp={() => {
              setTalkDown(false);
              talkEnd();
            }}
            onPointerCancel={() => {
              setTalkDown(false);
              talkEnd();
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!event.repeat) {
                  setTalkDown(true);
                  talkStart();
                }
              }
            }}
            onKeyUp={event => {
              if (event.key === 'Enter') {
                setTalkDown(false);
                talkEnd();
              }
            }}
            className={`touch-none select-none rounded-full px-6 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
              talkHeld ? 'bg-indigo-700 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-700'
            }`}
          >
            {talkHeld
              ? t('voiceMode.controls.release', 'Release to send')
              : t('voiceMode.controls.holdToTalk', 'Hold to talk')}
          </button>
        )}

        <button
          type="button"
          onClick={() => voiceMode.end('user')}
          className="flex items-center gap-2 rounded-full bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700"
        >
          <Icon name="close" size="sm" />
          {t('voiceMode.controls.end', 'End')}
        </button>
      </footer>
    </section>
  );
}
