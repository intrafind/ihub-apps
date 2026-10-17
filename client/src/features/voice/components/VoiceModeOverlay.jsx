import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getTranscriptionErrorMessage } from '../../../utils/transcriptionErrors';
import { VOICE_STATUS } from '../utils/voiceModeReducer';
import './VoiceMode.css';

const INTERACTIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']);

/**
 * Typing into something, or on a control Space would activate: Space is not
 * push-to-talk there. The Hold button is the one control where Space means
 * "talk", so it is not reserved: it is the keyboard route to push-to-talk.
 */
function isSpaceReserved(target, holdButton) {
  if (!target || typeof target !== 'object') return false;
  if (target === holdButton) return false;
  return Boolean(target.isContentEditable) || INTERACTIVE_TAGS.has(target.tagName);
}

/** A touch screen has no Space key, so the status line must not tell people to press it. */
function hasCoarsePointer() {
  return (
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)')?.matches)
  );
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
    case 'no-speech':
      return t(
        'voiceMode.errors.noSpeech',
        'Voice mode ended because nothing was said for a while.'
      );
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

/**
 * The gear's popover. The gear toggles it itself, so a press on the gear must
 * not count as "outside": the outside-closer would close it on mousedown and
 * the gear's click would open it again.
 *
 * @param {Object} props
 * @param {ReturnType<import('../hooks/useVoiceMode').useVoiceMode>} props.voiceMode
 * @param {() => void} props.onClose
 * @param {string} props.id - DOM id the gear points at with `aria-controls`.
 * @param {string} props.labelledBy - DOM id of the popover's heading.
 * @param {React.RefObject<HTMLElement>} props.triggerRef - The gear button.
 */
function SettingsPopover({ voiceMode, onClose, id, labelledBy, triggerRef }) {
  const { t } = useTranslation();
  const { prefs } = voiceMode;
  const ref = useRef(null);

  useEffect(() => {
    const onPointerDown = event => {
      if (ref.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onClose, triggerRef]);

  // `shrink-0`: in a flex row the label's text takes the width first and the
  // box shrinks to a sliver (13x16 px on a phone).
  const radio = (value, label) => (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
      <input
        type="radio"
        name="voice-listening-style"
        value={value}
        checked={prefs.listeningStyle === value}
        onChange={() => voiceMode.setListeningStyle(value)}
        className="h-4 w-4 shrink-0 text-indigo-600"
      />
      {label}
    </label>
  );

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-labelledby={labelledBy}
      // Never taller than the overlay (a phone in landscape is ~320 px high):
      // the rest scrolls instead of being clipped.
      className="absolute right-3 top-12 z-10 max-h-[calc(100%-4rem)] w-72 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
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
          className="mt-0.5 h-4 w-4 shrink-0 rounded text-indigo-600"
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
          className="h-4 w-4 shrink-0 rounded text-indigo-600"
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
 * conversation in it. The host makes what is behind the overlay `inert`: this
 * view is the only thing keyboard and screen reader users can reach.
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
  const settingsButtonRef = useRef(null);
  const holdButtonRef = useRef(null);
  const retryRef = useRef(null);
  // Who is holding push-to-talk right now: 'key' (Space, Enter), 'pointer'
  // (mouse, touch, pen) or 'latch' (a click without a press, see below).
  const holdSourceRef = useRef(null);
  const settingsTitleId = useId();
  const settingsPanelId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [talkDown, setTalkDown] = useState(false);
  const pushToTalk = prefs.listeningStyle === 'push-to-talk';
  // A key or button still down when push-to-talk is switched off is not "held".
  const talkHeld = talkDown && pushToTalk;
  const ready = status !== VOICE_STATUS.CONNECTING && status !== VOICE_STATUS.ERROR;
  const muted = status === VOICE_STATUS.PAUSED;
  const canMute = ready;
  const holdDisabled = !ready || muted;

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

  // The error comes with its way out: put the keyboard on "Try again".
  useEffect(() => {
    if (status === VOICE_STATUS.ERROR) retryRef.current?.focus();
  }, [status]);

  const talkStart = voiceMode.pushToTalkStart;
  const talkEnd = voiceMode.pushToTalkEnd;
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // One hold at a time, ended by whoever began it. A press while a latch is
  // on releases the latch instead (tap again to send).
  const beginHold = useCallback(
    source => {
      if (holdSourceRef.current === 'latch') {
        holdSourceRef.current = null;
        setTalkDown(false);
        talkEnd();
        return;
      }
      if (holdSourceRef.current) return;
      holdSourceRef.current = source;
      setTalkDown(true);
      talkStart();
    },
    [talkStart, talkEnd]
  );
  const endHold = useCallback(
    source => {
      if (!holdSourceRef.current || (source && holdSourceRef.current !== source)) return;
      holdSourceRef.current = null;
      setTalkDown(false);
      talkEnd();
    },
    [talkEnd]
  );

  // A hold cannot outlive its button: muted (also when the tab was hidden) or
  // failed while it is down means the microphone is not wanted any more.
  useEffect(() => {
    if (holdDisabled) endHold();
  }, [holdDisabled, endHold]);

  // Esc ends voice mode (or closes the settings first); Space is push-to-talk.
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (settingsOpen) {
          closeSettings();
          // The popover (and the focus inside it) is gone: back to its trigger.
          settingsButtonRef.current?.focus();
        } else {
          voiceMode.end('user');
        }
        return;
      }
      if (
        event.key === ' ' &&
        pushToTalk &&
        ready &&
        !settingsOpen &&
        !isSpaceReserved(event.target, holdButtonRef.current)
      ) {
        event.preventDefault();
        if (!event.repeat) beginHold('key');
      }
    };
    const onKeyUp = event => {
      if (event.key === ' ' && holdSourceRef.current === 'key') {
        // On the Hold button the browser would turn this release into a click.
        event.preventDefault();
        endHold('key');
      }
    };
    // A keyup or pointerup that never arrives (Alt+Tab, a system dialog, a
    // dragged-away tab) would leave the microphone open.
    const onBlur = () => endHold();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [pushToTalk, ready, settingsOpen, beginHold, endHold, closeSettings, voiceMode]);

  // Keep the newest words of the answer in view.
  useEffect(() => {
    const element = captionRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.assistantCaption]);

  // A button clicked with the mouse keeps the focus, and then Space would press
  // it again instead of talking. Keyboard users (detail 0) stay where they are.
  const releaseFocusAfterPointer = event => {
    if (event.detail > 0) rootRef.current?.focus();
  };

  // The error text has its own alert node below, so the status node stays one
  // stable live region.
  const statusLabel = (() => {
    switch (status) {
      case VOICE_STATUS.CONNECTING:
        return t('voiceMode.status.connecting', 'Connecting…');
      case VOICE_STATUS.LISTENING:
        if (!pushToTalk) return t('voiceMode.status.listening', 'Listening…');
        return hasCoarsePointer()
          ? t('voiceMode.status.holdToTalkTouch', 'Hold the button to talk')
          : t('voiceMode.status.holdToTalk', 'Hold Space or the button to talk');
      case VOICE_STATUS.USER_SPEAKING:
        return t('voiceMode.status.userSpeaking', 'Listening…');
      case VOICE_STATUS.THINKING:
        return state.toolStatus?.label || t('voiceMode.status.thinking', 'Thinking…');
      case VOICE_STATUS.SPEAKING:
        return t('voiceMode.status.speaking', 'Speaking…');
      case VOICE_STATUS.PAUSED:
        return t('voiceMode.status.paused', 'Microphone is muted');
      default:
        return '';
    }
  })();
  const notice =
    state.notice === 'tts-failed'
      ? t('voiceMode.notice.ttsFailed', 'I could not speak this answer. It is in the chat.')
      : '';

  const orbClickable = status === VOICE_STATUS.SPEAKING || status === VOICE_STATUS.THINKING;
  const showCaptions = prefs.captions && (state.userCaption.text || state.assistantCaption);
  const orbProps = {
    ref: orbRef,
    className: 'voice-orb',
    'data-status': status,
    'data-clickable': orbClickable
  };

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-label={t('voiceMode.overlay.label', 'Voice mode')}
      data-testid="voice-mode-overlay"
      className="absolute inset-0 z-30 flex flex-col rounded-lg bg-white/95 text-gray-900 outline-hidden backdrop-blur dark:bg-gray-900/95 dark:text-gray-100"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
        <span className="truncate text-sm font-medium text-gray-600 dark:text-gray-300">
          {appName}
        </span>
        <div className="flex items-center gap-1">
          <button
            ref={settingsButtonRef}
            type="button"
            onClick={event => {
              setSettingsOpen(open => !open);
              releaseFocusAfterPointer(event);
            }}
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-controls={settingsOpen ? settingsPanelId : undefined}
            aria-label={t('voiceMode.settings.open', 'Voice settings')}
            title={t('voiceMode.settings.open', 'Voice settings')}
            className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Icon name="cog" size="md" />
          </button>
          {/* Named differently from the footer's "End", so the two are not
              announced as the same button twice. */}
          <button
            type="button"
            onClick={() => voiceMode.end('user')}
            aria-label={t('voiceMode.controls.endTitle', 'End voice mode (Esc)')}
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
          id={settingsPanelId}
          labelledBy={settingsTitleId}
          triggerRef={settingsButtonRef}
        />
      )}

      {/* Scrolls on its own when the screen is too short for orb, status and
          captions (a phone in landscape): header and controls stay put. The
          inner `my-auto` centres the content when there is room and, unlike
          `justify-center`, never pushes the top out of reach when there is not. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
        <div className="my-auto flex flex-col items-center gap-6 py-2">
          {orbClickable ? (
            <button
              {...orbProps}
              type="button"
              onClick={event => {
                // Never hand the click event on: the hook reads its argument.
                voiceMode.interrupt();
                releaseFocusAfterPointer(event);
              }}
              aria-label={t('voiceMode.controls.stopAnswer', 'Stop the answer and talk')}
            />
          ) : (
            <div
              {...orbProps}
              role="img"
              aria-label={t('voiceMode.overlay.orb', 'Voice activity')}
            />
          )}

          <p
            role="status"
            data-testid="voice-mode-status"
            className={statusLabel ? 'max-w-md text-center text-lg font-medium' : 'sr-only'}
          >
            {statusLabel}
          </p>
          {status === VOICE_STATUS.ERROR && (
            <>
              <p
                role="alert"
                data-testid="voice-mode-error"
                className="max-w-md text-center text-lg font-medium"
              >
                {errorMessage(state.error, t)}
              </p>
              <button
                ref={retryRef}
                type="button"
                onClick={() => {
                  voiceMode.retry();
                  // This button goes away with the error: keep the keyboard here.
                  rootRef.current?.focus();
                }}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                {t('voiceMode.controls.retry', 'Try again')}
              </button>
            </>
          )}
          {/* Always in the page, so a screen reader is already watching it when
              the notice appears; without one it takes no room. */}
          <p
            role="status"
            data-testid="voice-mode-notice"
            className={
              notice ? 'max-w-md text-center text-sm text-gray-700 dark:text-gray-300' : 'sr-only'
            }
          >
            {notice}
          </p>

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
                <p className="mt-2 text-indigo-700 dark:text-indigo-300">
                  {state.assistantCaption}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-3 px-4 pb-6 pt-3">
        {/* No aria-pressed on Mute and Hold: their names already change with the
            state ("Mute" / "Unmute"), and a pressed state on top reads as
            "Unmute, toggle button, pressed". */}
        <button
          type="button"
          onClick={event => {
            voiceMode.setMuted(!muted);
            releaseFocusAfterPointer(event);
          }}
          disabled={!canMute}
          className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            muted
              ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60'
              : 'bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <Icon name="microphone" size="sm" solid={muted} />
          {muted ? t('voiceMode.controls.unmute', 'Unmute') : t('voiceMode.controls.mute', 'Mute')}
        </button>

        {pushToTalk && (
          <button
            ref={holdButtonRef}
            type="button"
            disabled={holdDisabled}
            onPointerDown={event => {
              // A disabled button still gets pointer events in some browsers;
              // only the primary button talks (a right click opens a menu).
              if (event.button !== 0 || holdDisabled) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              beginHold('pointer');
            }}
            // Any release ends it, whichever button was let go last.
            onPointerUp={() => endHold('pointer')}
            onPointerCancel={() => endHold('pointer')}
            onContextMenu={event => event.preventDefault()}
            onClick={event => {
              if (event.detail > 0) {
                // A real click: its press and release already did the work.
                releaseFocusAfterPointer(event);
                return;
              }
              // A click without a press: a screen reader, VoiceOver or TalkBack
              // activating the button cannot hold it down, so it latches. Click
              // to start talking, click again to send.
              if (holdSourceRef.current === 'latch') endHold('latch');
              else beginHold('latch');
            }}
            // Space is handled for the whole window (see above). Both keys stop
            // the browser from turning the key into a click, or the latch would
            // fire on top of the hold.
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!event.repeat) beginHold('key');
              }
            }}
            onKeyUp={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                endHold('key');
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
