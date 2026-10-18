import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getTranscriptionErrorMessage } from '../../../utils/transcriptionErrors';
import { VOICE_STATUS } from '../utils/voiceModeReducer';
import { READ_ALONG_HIGHLIGHT, findSpokenAnswer, findSpokenBoundary } from '../utils/readAlong';
import { VoiceWaveIcon } from './VoiceModeButton';
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

/**
 * Inside a dialog that is not the dock's own (a source viewer, an image, a
 * menu opened from a message): its keys are its own. The chat stays usable
 * while voice mode is open.
 */
function isInOtherDialog(target, dock) {
  if (!target || typeof target.closest !== 'function') return false;
  const dialog = target.closest(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog'
  );
  // A dialog the dock sits in (the admin's "Try it") is the dock's own.
  return Boolean(dialog) && !dock?.contains(dialog) && !dialog.contains(dock);
}

/** A touch screen has no Space key, so the status line must not tell people to press it. */
function hasCoarsePointer() {
  return (
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)')?.matches)
  );
}

/** Keeps the level bars and the glow moving with the mic without re-rendering anything. */
function useVoiceLevel(rootRef, levelRef) {
  useEffect(() => {
    let frame = 0;
    let shown = 0;
    const tick = () => {
      // Ease towards the level so the bars do not flicker on single frames.
      shown += (levelRef.current - shown) * 0.35;
      rootRef.current?.style.setProperty('--voice-level', shown.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [rootRef, levelRef]);
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

/** How long a scroll of the user's own keeps the read-along from scrolling the chat. */
const USER_SCROLL_GRACE_MS = 4000;

/** Keys that scroll the chat when it has the focus. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

/**
 * Scrolls the chat so the spot the voice has reached stays in view, unless the
 * user scrolled a moment ago: the text runs ahead of the voice, and someone
 * reading further up must not be pulled back.
 */
function keepInView(range, container, lastUserScroll) {
  if (!container || typeof range.getBoundingClientRect !== 'function') return;
  if (Date.now() - lastUserScroll < USER_SCROLL_GRACE_MS) return;
  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (!box.height) return;
  const top = rect.top - box.top;
  if (top < box.height * 0.1 || top > box.height * 0.75) {
    container.scrollTop += top - box.height * 0.4;
  }
}

/**
 * Marks the part of the answer still to be said in the chat message itself
 * (see utils/readAlong). The message is still being written while it is read
 * out, so the mark follows its nodes as they change.
 *
 * @param {React.RefObject<HTMLElement>} rootRef - The dock, inside `[data-voice-scope]`.
 * @param {string} caption - The speech text of the answer.
 * @param {number|null} spokenChars
 * @param {boolean} enabled
 */
function useReadAlong(rootRef, caption, spokenChars, enabled) {
  const marking =
    enabled &&
    typeof spokenChars === 'number' &&
    typeof caption === 'string' &&
    spokenChars < caption.length;
  const spokenText = marking ? caption.slice(0, spokenChars) : null;
  const lastUserScrollRef = useRef(0);

  useEffect(() => {
    const onUserScroll = () => {
      lastUserScrollRef.current = Date.now();
    };
    // A press in the chat (its scrollbar too) or a scrolling key there is the
    // user's own scrolling as well; a scroll event alone could be ours.
    const inChat = target => Boolean(target?.closest?.('[role="log"]'));
    const onPointerDown = event => {
      if (inChat(event.target)) onUserScroll();
    };
    const onKeyDown = event => {
      if (SCROLL_KEYS.has(event.key) && inChat(event.target)) onUserScroll();
    };
    document.addEventListener('wheel', onUserScroll, { passive: true });
    document.addEventListener('touchmove', onUserScroll, { passive: true });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('wheel', onUserScroll);
      document.removeEventListener('touchmove', onUserScroll);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      if (typeof CSS !== 'undefined') CSS.highlights?.delete(READ_ALONG_HIGHLIGHT);
    };
  }, []);

  useEffect(() => {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    if (!registry || typeof Highlight === 'undefined') return undefined;
    if (spokenText === null) {
      registry.delete(READ_ALONG_HIGHLIGHT);
      return undefined;
    }
    const scope = rootRef.current?.closest('[data-voice-scope]');
    let frame = 0;
    const mark = scroll => {
      frame = 0;
      const body = findSpokenAnswer(scope);
      const boundary = body && findSpokenBoundary(body, spokenText);
      if (!boundary) {
        registry.delete(READ_ALONG_HIGHLIGHT);
        return;
      }
      const range = document.createRange();
      range.setStart(boundary.node, boundary.offset);
      range.setEnd(body, body.childNodes.length);
      registry.set(READ_ALONG_HIGHLIGHT, new Highlight(range));
      if (scroll) keepInView(range, body.closest('[role="log"]'), lastUserScrollRef.current);
    };
    mark(true);
    const observer =
      scope && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            if (!frame) frame = requestAnimationFrame(() => mark(false));
          })
        : null;
    observer?.observe(scope, { childList: true, subtree: true, characterData: true });
    return () => {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef, spokenText]);
}

/** A microphone, struck through while it is muted (Heroicons has no mic-slash). */
function MicrophoneIcon({ muted }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      {muted && <path d="M4 4l16 16" strokeWidth="2.2" />}
    </svg>
  );
}

/**
 * The gear's popover, opening upwards from the dock. The gear toggles it
 * itself, so a press on the gear must not count as "outside": the
 * outside-closer would close it on mousedown and the gear's click would open
 * it again.
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
      // Never taller than the screen above the dock (a phone in landscape is
      // ~320 px high): the rest scrolls instead of being clipped.
      className="absolute bottom-full left-0 z-20 mb-2 max-h-[min(24rem,calc(100dvh-8rem))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
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

      <label className="flex cursor-pointer items-start gap-2 py-1 text-sm">
        <input
          type="checkbox"
          checked={prefs.captions}
          onChange={event => voiceMode.setCaptions(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded text-indigo-600"
        />
        <span>
          {t('voiceMode.settings.liveTranscript', 'Show live transcript')}
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t(
              'voiceMode.settings.liveTranscriptHint',
              'Your words as you speak, and the part of the answer still to be read out.'
            )}
          </span>
        </span>
      </label>
    </div>
  );
}

/** The End pill's colours: it carries the level bars, so it takes the state's colour. */
const PILL_TONES = {
  [VOICE_STATUS.CONNECTING]:
    'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600',
  [VOICE_STATUS.LISTENING]:
    'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-200 dark:hover:bg-indigo-500/25',
  [VOICE_STATUS.USER_SPEAKING]:
    'bg-indigo-100 text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-500/25 dark:text-indigo-100 dark:hover:bg-indigo-500/35',
  [VOICE_STATUS.THINKING]:
    'bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25',
  [VOICE_STATUS.SPEAKING]:
    'bg-sky-50 text-sky-800 hover:bg-sky-100 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25',
  [VOICE_STATUS.PAUSED]:
    'bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25',
  [VOICE_STATUS.ERROR]:
    'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
};

const FOCUS_RING =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800';
const ICON_BUTTON = `flex shrink-0 items-center justify-center rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11 sm:p-2.5 ${FOCUS_RING}`;
const NEUTRAL_ICON_BUTTON = `${ICON_BUTTON} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`;

/** The newest words of a long interim transcript: two lines show the tail, not the start. */
const TRANSCRIPT_TAIL = 160;

/**
 * Voice mode in the chat: it takes the composer's place while voice mode is
 * open, the way the composer turns into a voice strip in ChatGPT and Claude.
 * The conversation above stays visible, scrollable and live: every turn lands
 * in it as a normal message, and the part of the answer still to be read out
 * is muted in the message itself (read-along).
 *
 * The dock stays a text field, like Claude's composer: a typed message joins
 * the spoken conversation (`voiceMode.sendText`) and is answered out loud.
 * While the field is empty it shows the state in words, or what the user is
 * saying. Level bars and a soft glow show the state's colour, and the controls
 * are: settings, Stop the answer, Mute, Hold to talk (push-to-talk), Send
 * (with something typed) and End.
 *
 * Keyboard: Esc ends voice mode (or closes the settings first); Space is
 * push-to-talk, except in the text field; Enter sends what is typed. The host
 * mounts exactly one dock: its listeners are on the window.
 *
 * @param {Object} props
 * @param {ReturnType<import('../hooks/useVoiceMode').useVoiceMode>} props.voiceMode
 * @param {string} [props.value] - What is typed in the dock.
 * @param {(text: string) => void} [props.onChange]
 */
export default function VoiceModeDock({ voiceMode, value = '', onChange }) {
  const { t } = useTranslation();
  const { state, prefs, levelRef } = voiceMode;
  const { status } = state;
  const rootRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const holdButtonRef = useRef(null);
  const retryRef = useRef(null);
  const textRef = useRef(null);
  // Who is holding push-to-talk right now: 'key' (Space, Enter), 'pointer'
  // (mouse, touch, pen) or 'latch' (a click without a press, see below).
  const holdSourceRef = useRef(null);
  const settingsTitleId = useId();
  const settingsPanelId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [talkDown, setTalkDown] = useState(false);
  const [sending, setSending] = useState(false);
  const pushToTalk = prefs.listeningStyle === 'push-to-talk';
  // A key or button still down when push-to-talk is switched off is not "held".
  const talkHeld = talkDown && pushToTalk;
  const ready = status !== VOICE_STATUS.CONNECTING && status !== VOICE_STATUS.ERROR;
  const muted = status === VOICE_STATUS.PAUSED;
  const canMute = ready;
  const holdDisabled = !ready || muted;

  useVoiceLevel(rootRef, levelRef);
  useReadAlong(rootRef, state.assistantCaption, state.spokenChars, prefs.captions);

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

  // The field grows with what is typed, up to a few lines.
  useEffect(() => {
    const field = textRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [value]);

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

  // Nor the dock: it is replaced when the window crosses the phone/desktop
  // breakpoint while the session goes on, and the new one knows of no hold.
  const talkEndRef = useRef(talkEnd);
  talkEndRef.current = talkEnd;
  useEffect(
    () => () => {
      if (holdSourceRef.current) talkEndRef.current();
    },
    []
  );

  // Esc ends voice mode (or closes the settings first); Space is push-to-talk.
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        if (settingsOpen) {
          event.preventDefault();
          closeSettings();
          // The popover (and the focus inside it) is gone: back to its trigger.
          settingsButtonRef.current?.focus();
          return;
        }
        // The chat stays usable while voice mode is open: an Esc that closes
        // one of its dialogs (a source, an image) is that dialog's.
        if (event.defaultPrevented || isInOtherDialog(event.target, rootRef.current)) return;
        event.preventDefault();
        voiceMode.end('user');
        return;
      }
      if (
        event.key === ' ' &&
        pushToTalk &&
        ready &&
        !settingsOpen &&
        !isSpaceReserved(event.target, holdButtonRef.current) &&
        !isInOtherDialog(event.target, rootRef.current)
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

  // A button clicked with the mouse keeps the focus, and then Space would press
  // it again instead of talking. Keyboard users (detail 0) stay where they are.
  const releaseFocusAfterPointer = event => {
    if (event.detail > 0) rootRef.current?.focus();
  };

  const coarsePointer = hasCoarsePointer();
  // The error text has its own alert node, so the status node stays one stable
  // live region.
  const statusLabel = (() => {
    switch (status) {
      case VOICE_STATUS.CONNECTING:
        return t('voiceMode.status.connecting', 'Connecting…');
      case VOICE_STATUS.LISTENING:
        if (!pushToTalk) return t('voiceMode.status.listening', 'Listening…');
        return coarsePointer
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
  // What the user is saying, in place of the status, the way a composer fills
  // with dictated words. The status line stays the announced one. A final
  // caption while listening is the turn already sent: it is in the chat.
  const talking =
    status === VOICE_STATUS.USER_SPEAKING ||
    (status === VOICE_STATUS.LISTENING && !state.userCaption.final);
  const transcript = prefs.captions && talking ? state.userCaption.text : '';
  const transcriptShown =
    transcript.length > TRANSCRIPT_TAIL
      ? `…${transcript.slice(-TRANSCRIPT_TAIL).trimStart()}`
      : transcript;
  const hint = coarsePointer
    ? ''
    : pushToTalk
      ? t('voiceMode.hint.pushToTalk', 'Esc to end · Hold Space to talk')
      : t('voiceMode.hint.handsFree', 'Esc to end');
  const canStopAnswer = status === VOICE_STATUS.SPEAKING || status === VOICE_STATUS.THINKING;
  const isError = status === VOICE_STATUS.ERROR;
  const typed = value.trim();
  const canSend = Boolean(typed) && ready && !sending;

  // A typed message: it stops an answer that is still running, and is answered
  // out loud. The field is cleared once the chat took it.
  const submitText = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      if (await voiceMode.sendText(typed)) onChange?.('');
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-label={t('voiceMode.overlay.label', 'Voice mode')}
      data-testid="voice-mode-dock"
      data-status={status}
      className="voice-dock relative isolate mb-1 outline-hidden"
    >
      {/* The glow over the end of the chat, rising from behind the dock: the
          state's colour, breathing with the voice. */}
      <div
        aria-hidden="true"
        data-testid="voice-mode-glow"
        className="voice-glow pointer-events-none absolute inset-x-0 -top-28 bottom-1/2 -z-10"
      />
      {settingsOpen && (
        <SettingsPopover
          voiceMode={voiceMode}
          onClose={closeSettings}
          id={settingsPanelId}
          labelledBy={settingsTitleId}
          triggerRef={settingsButtonRef}
        />
      )}

      <div
        className={`flex flex-col rounded-2xl border bg-white shadow-xs dark:bg-gray-800 ${
          isError ? 'border-red-300 dark:border-red-700' : 'border-gray-300 dark:border-gray-600'
        }`}
      >
        <div className="relative flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          {/* One stable live region for the state; what is on the screen is
              the field's placeholder below. */}
          <p role="status" data-testid="voice-mode-status" className="sr-only">
            {statusLabel}
          </p>
          {isError ? (
            <>
              <p
                role="alert"
                data-testid="voice-mode-error"
                className="min-w-0 flex-1 text-base text-red-700 dark:text-red-300"
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
                className={`shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 ${FOCUS_RING}`}
              >
                {t('voiceMode.controls.retry', 'Try again')}
              </button>
            </>
          ) : (
            <>
              <textarea
                ref={textRef}
                rows={1}
                value={value}
                onChange={event => onChange?.(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submitText();
                  }
                }}
                aria-label={t('voiceMode.input.label', 'Type a message')}
                data-testid="voice-mode-input"
                className="max-h-40 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 text-gray-900 outline-hidden dark:text-gray-100"
              />
              {!value && (
                // The placeholder: the state, or the words the user is saying.
                // The status line above is what a screen reader hears, once,
                // instead of every interim word.
                <p
                  aria-hidden="true"
                  data-testid={transcriptShown ? 'voice-mode-transcript' : 'voice-mode-placeholder'}
                  className={`pointer-events-none absolute inset-x-4 top-3 line-clamp-2 text-base leading-6 ${
                    transcriptShown
                      ? state.userCaption.final
                        ? 'text-gray-900 dark:text-gray-100'
                        : 'text-gray-600 dark:text-gray-300'
                      : status === VOICE_STATUS.THINKING
                        ? 'text-violet-700 dark:text-violet-300'
                        : muted
                          ? 'text-amber-800 dark:text-amber-200'
                          : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {transcriptShown || statusLabel}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t border-gray-100 px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2 dark:border-gray-700/50">
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
            className={NEUTRAL_ICON_BUTTON}
          >
            <Icon name="cog" size="md" />
          </button>

          <div className="flex-1" />

          {/* The way to cut the answer short: a tap, while the app thinks or talks. */}
          {canStopAnswer && (
            <button
              type="button"
              onClick={event => {
                // Never hand the click event on: the hook reads its argument.
                voiceMode.interrupt();
                releaseFocusAfterPointer(event);
              }}
              aria-label={t('voiceMode.controls.stopAnswer', 'Stop the answer and talk')}
              title={t('voiceMode.controls.stopAnswer', 'Stop the answer and talk')}
              className={NEUTRAL_ICON_BUTTON}
            >
              <Icon name="stop" size="md" solid />
            </button>
          )}

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
            aria-label={
              muted
                ? t('voiceMode.controls.unmuteMicrophone', 'Unmute microphone')
                : t('voiceMode.controls.muteMicrophone', 'Mute microphone')
            }
            title={
              muted
                ? t('voiceMode.controls.unmuteMicrophone', 'Unmute microphone')
                : t('voiceMode.controls.muteMicrophone', 'Mute microphone')
            }
            className={`${ICON_BUTTON} ${
              muted
                ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
            }`}
          >
            <MicrophoneIcon muted={muted} />
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
              className={`touch-none select-none rounded-full px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-5 ${FOCUS_RING} ${
                talkHeld
                  ? 'bg-indigo-700 ring-4 ring-indigo-500/25'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {talkHeld
                ? t('voiceMode.controls.release', 'Release to send')
                : t('voiceMode.controls.holdToTalk', 'Hold to talk')}
            </button>
          )}

          {typed && (
            <button
              type="button"
              onClick={event => {
                submitText();
                releaseFocusAfterPointer(event);
              }}
              disabled={!canSend}
              aria-label={t('common.send', 'Send')}
              title={t('common.send', 'Send')}
              className={`${ICON_BUTTON} bg-indigo-600 text-white hover:bg-indigo-700`}
            >
              <Icon name="arrow-up" size="md" />
            </button>
          )}

          {/* End: where Send is in the composer. Ending keeps the conversation,
              so it is not a red, destructive button; it carries the level bars. */}
          <button
            type="button"
            onClick={() => voiceMode.end('user')}
            aria-label={t('voiceMode.controls.endTitle', 'End voice mode (Esc)')}
            title={t('voiceMode.controls.endTitle', 'End voice mode (Esc)')}
            data-testid="voice-mode-end"
            className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-colors pointer-coarse:min-h-11 ${FOCUS_RING} ${
              PILL_TONES[status] || PILL_TONES[VOICE_STATUS.CONNECTING]
            }`}
          >
            {isError ? (
              <Icon name="exclamation-circle" size="sm" />
            ) : (
              <VoiceWaveIcon className="voice-bars h-4 w-5" />
            )}
            {t('voiceMode.controls.end', 'End')}
          </button>
        </div>
      </div>

      {/* Under the dock, where the composer has its disclaimer: the shortcuts,
          or a notice. The notice line is always in the page, so a screen reader
          is already watching it when a notice appears. */}
      <div className="flex min-h-6 items-center justify-center gap-2 px-2 pt-1 text-xs text-gray-500 dark:text-gray-400">
        <p
          role="status"
          data-testid="voice-mode-notice"
          className={notice ? 'text-center text-amber-700 dark:text-amber-300' : 'sr-only'}
        >
          {notice}
        </p>
        {!notice && hint && <span aria-hidden="true">{hint}</span>}
      </div>
    </section>
  );
}
