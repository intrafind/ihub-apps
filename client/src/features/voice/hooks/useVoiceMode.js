import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { debugLog } from '../../../utils/debugLog';
import { createSpeechQueue } from '../utils/speechQueue';
import { createVoiceSession } from '../utils/voiceSession';
import {
  VOICE_STATUS,
  initialVoiceModeState,
  isDroppedTranscript,
  voiceModeReducer
} from '../utils/voiceModeReducer';
import { loadVoiceModePrefs, saveVoiceModePrefs } from '../utils/voiceModePrefs';
import {
  activeToolOf,
  answerForClarification,
  toSpokenText,
  toolStatusLabel
} from '../utils/voiceText';

const RESET = '@voiceMode/reset';

/** The reducer plus a reset, so a new session starts from a clean state. */
function sessionReducer(state, action) {
  if (action.type === RESET) return initialVoiceModeState(action.options);
  return voiceModeReducer(state, action);
}

/** The assistant message the turn that was sent after `baseCount` messages is answered in. */
function findTurnAssistant(messages, baseCount) {
  if (!Array.isArray(messages) || messages.length <= baseCount) return null;
  for (let i = messages.length - 1; i >= baseCount; i -= 1) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

/** Error code of a failed `getUserMedia`/session start, as the overlay words it. */
function startErrorCode(error) {
  if (error?.code) return error.code;
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'mic-denied';
  if (error?.name === 'NotFoundError') return 'mic-missing';
  return 'start-failed';
}

/**
 * Voice mode: a spoken conversation with the chat's app.
 *
 * This hook owns the session's pieces and wires them to the chat that is
 * already on screen: the microphone and speech-to-text (`voiceSession`), the
 * state machine (`voiceModeReducer`) and the spoken answer (`speechQueue`).
 * A final transcript goes out through the chat's own send path, so the app's
 * prompt, model, tools, sources and permissions all apply; the answer is read
 * from the assistant message the chat streams into and spoken sentence by
 * sentence while it is still being written.
 *
 * `start()` has to be called from the click that starts voice mode: the browser
 * only lets a user gesture ask for the microphone and unlock audio.
 *
 * @param {Object} params
 * @param {ReturnType<import('./useVoiceModeAvailability').useVoiceModeAvailability>} params.availability
 * @param {string} params.language - UI language: recognition and voice language hint.
 * @param {Array} params.messages - The chat's messages (`useAppChat`).
 * @param {boolean} params.processing - A turn is running (`useAppChat`).
 * @param {boolean} params.clarificationPending - The app asked a question and waits.
 * @param {(text: string) => Promise<boolean>} params.sendTurn - Send a spoken turn; resolves
 *   to whether it was accepted.
 * @param {(answer: { value: any, displayText: string }) => void} params.answerClarification
 * @param {(source: string) => void} params.cancelGeneration - Stop the running turn.
 * @param {(reason: 'user'|'time-limit'|'error') => void} [params.onEnded]
 */
export function useVoiceMode({
  availability,
  language,
  messages,
  processing,
  clarificationPending,
  sendTurn,
  answerClarification,
  cancelGeneration,
  onEnded
}) {
  const { t } = useTranslation();
  const settings = availability?.settings;
  const [prefs, setPrefs] = useState(loadVoiceModePrefs);
  const effective = {
    listeningStyle: prefs.listeningStyle ?? settings?.listeningStyle ?? 'hands-free',
    bargeIn: prefs.bargeIn ?? settings?.bargeIn ?? true,
    captions: prefs.captions ?? true,
    voice: prefs.voice ?? settings?.voice ?? ''
  };

  const [active, setActive] = useState(false);
  const [state, setState] = useState(() => initialVoiceModeState(effective));
  const stateRef = useRef(state);
  const send = useCallback(action => {
    const next = sessionReducer(stateRef.current, action);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
  }, []);

  // The newest props and options, read by the long-lived session callbacks.
  const latestRef = useRef({});
  latestRef.current = {
    availability,
    language,
    messages,
    processing,
    clarificationPending,
    sendTurn,
    answerClarification,
    cancelGeneration,
    onEnded,
    effective,
    t
  };

  const generationRef = useRef(0);
  const sessionRef = useRef(null);
  const queueRef = useRef(null);
  const turnRef = useRef(null);
  const timeLimitRef = useRef(null);
  /** Mic level (0..1) for the orb. A ref, so ~15 updates a second re-render nothing. */
  const levelRef = useRef(0);

  const clearTimeLimit = () => {
    if (timeLimitRef.current) clearTimeout(timeLimitRef.current);
    timeLimitRef.current = null;
  };

  const logTiming = turn => {
    if (!turn?.timing) return;
    const { turnEnd, final, firstToken, firstChunk, firstAudio } = turn.timing;
    if (!turnEnd || !firstAudio) return;
    debugLog('voiceMode.timing', {
      vadEnd: 0,
      sttFinal: final ? final - turnEnd : null,
      firstToken: firstToken ? firstToken - turnEnd : null,
      firstChunk: firstChunk ? firstChunk - turnEnd : null,
      firstAudio: firstAudio - turnEnd
    });
  };

  /** Close the microphone, the speech-to-text connection and the audio. */
  const teardown = useCallback(() => {
    generationRef.current += 1;
    clearTimeLimit();
    turnRef.current = null;
    levelRef.current = 0;
    const session = sessionRef.current;
    const queue = queueRef.current;
    sessionRef.current = null;
    queueRef.current = null;
    try {
      session?.stop();
    } catch (error) {
      debugLog('voiceMode: stopping the session failed', error);
    }
    try {
      queue?.dispose();
    } catch (error) {
      debugLog('voiceMode: disposing the speech queue failed', error);
    }
  }, []);

  // Ending voice mode stops the listening and the audio, not the turn: an
  // answer still being written keeps streaming into the chat as text.
  const end = useCallback(
    (reason = 'user') => {
      teardown();
      setActive(false);
      latestRef.current.onEnded?.(reason);
    },
    [teardown]
  );

  /** The user spoke over the app, or while it worked: stop it and listen. */
  const bargeIn = useCallback(() => {
    queueRef.current?.interrupt();
    const turn = turnRef.current;
    turnRef.current = null;
    if (turn && latestRef.current.processing) latestRef.current.cancelGeneration('voice-barge-in');
    sessionRef.current?.setAgentState('idle');
    send({ type: 'BARGE_IN' });
  }, [send]);

  const handleFinal = useCallback(
    async text => {
      const spoken = String(text ?? '').trim();
      const turn = turnRef.current;
      if (turn?.timing) turn.timing.final = performance.now();
      send({ type: 'FINAL', text: spoken });
      const session = sessionRef.current;
      if (isDroppedTranscript(spoken)) {
        session?.setAgentState('idle');
        return;
      }

      const current = latestRef.current;
      const base = { sent: true, baseCount: current.messages.length, timing: turn?.timing || {} };
      turnRef.current = { ...base, answered: false, askedQuestionId: null, text: '' };
      session?.setAgentState('thinking');

      let accepted = true;
      if (current.clarificationPending) {
        const message = [...current.messages].reverse().find(m => m.clarification);
        current.answerClarification(answerForClarification(spoken, message?.clarification));
      } else {
        accepted = await current.sendTurn(spoken);
      }
      if (!accepted) {
        turnRef.current = null;
        session?.setAgentState('idle');
        send({ type: 'RUN_ENDED' });
        queueRef.current?.say(
          latestRef.current.t(
            'voiceMode.errors.sendFailed',
            'I could not send that. Please try again.'
          )
        );
        return;
      }
      send({ type: 'SENT' });
    },
    [send]
  );

  const handleSessionEvent = useCallback(
    (generation, event) => {
      if (generation !== generationRef.current) return;
      switch (event.type) {
        case 'ready': {
          send({ type: 'READY' });
          const minutes = latestRef.current.availability?.settings?.maxSessionMinutes;
          if (minutes) {
            clearTimeLimit();
            timeLimitRef.current = setTimeout(() => end('time-limit'), minutes * 60_000);
          }
          break;
        }
        case 'level':
          levelRef.current = event.level;
          break;
        case 'speech-start':
          // Speaking while the app works on the answer is an interruption too.
          if (
            stateRef.current.status === VOICE_STATUS.THINKING &&
            latestRef.current.effective.bargeIn
          ) {
            bargeIn();
          } else {
            send({ type: 'SPEECH_START' });
          }
          break;
        case 'barge-in':
          bargeIn();
          break;
        case 'interim':
          send({ type: 'INTERIM', text: event.text });
          break;
        case 'turn-end':
          turnRef.current = { timing: { turnEnd: performance.now() } };
          send({ type: 'TURN_ENDED' });
          break;
        case 'final':
          void handleFinal(event.text);
          break;
        case 'error':
          debugLog('voiceMode: session error', event);
          if (!event.recoverable) {
            queueRef.current?.interrupt();
            sessionRef.current?.stop();
            sessionRef.current = null;
          }
          send({ type: 'ERROR', code: event.code, message: event.message });
          break;
        case 'closed':
          if (stateRef.current.status !== VOICE_STATUS.ERROR) {
            send({ type: 'ERROR', code: 'closed', message: '' });
          }
          break;
        default:
          break;
      }
    },
    [bargeIn, end, handleFinal, send]
  );

  const connect = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const { availability: avail, language: lang, effective: options } = latestRef.current;

    let queue;
    try {
      // Created in the click handler's call stack: it unlocks audio playback.
      queue = createSpeechQueue({
        modelId: avail.ttsModelId,
        language: lang,
        voice: options.voice || undefined,
        onSpeakingStart: () => {
          if (generation !== generationRef.current) return;
          const turn = turnRef.current;
          if (turn?.timing) turn.timing.firstAudio = performance.now();
          sessionRef.current?.setAgentState('speaking');
          send({ type: 'PLAYBACK_STARTED' });
        },
        onDrained: () => {
          if (generation !== generationRef.current) return;
          logTiming(turnRef.current);
          sessionRef.current?.setAgentState('idle');
          send({ type: 'PLAYBACK_DRAINED' });
        },
        onError: error => debugLog('voiceMode: text-to-speech failed', error),
        onTiming: (stage, ms) => {
          const turn = turnRef.current;
          if (stage === 'firstChunk' && turn?.timing) turn.timing.firstChunk = performance.now();
          debugLog('voiceMode.timing', { stage, ms });
        }
      });
    } catch (error) {
      send({ type: 'ERROR', code: 'audio-unsupported', message: error?.message || '' });
      return;
    }
    queueRef.current = queue;

    try {
      const session = await createVoiceSession({
        service: avail.speech.service,
        modelId: avail.speech.modelId,
        language: lang,
        listeningStyle: options.listeningStyle,
        bargeIn: options.bargeIn,
        endOfTurnSilenceMs: avail.settings.endOfTurnSilenceMs,
        speech: avail.platformSpeech,
        onEvent: event => handleSessionEvent(generation, event)
      });
      if (generation !== generationRef.current) {
        // Ended while the permission prompt was open.
        session.stop();
        return;
      }
      sessionRef.current = session;
    } catch (error) {
      if (generation !== generationRef.current) return;
      queueRef.current?.dispose();
      queueRef.current = null;
      send({ type: 'ERROR', code: startErrorCode(error), message: error?.message || '' });
    }
  }, [handleSessionEvent, send]);

  const start = useCallback(() => {
    if (!availability?.available || sessionRef.current || queueRef.current) return undefined;
    const next = initialVoiceModeState(latestRef.current.effective);
    stateRef.current = next;
    setState(next);
    setActive(true);
    return connect();
  }, [availability?.available, connect]);

  const retry = useCallback(() => {
    teardown();
    send({ type: 'RETRY' });
    return connect();
  }, [connect, send, teardown]);

  // Speak the answer as the chat streams it, and show what the app is doing.
  useEffect(() => {
    const turn = turnRef.current;
    const queue = queueRef.current;
    if (!active || !turn?.sent || !queue) return;
    const assistant = findTurnAssistant(messages, turn.baseCount);
    if (!assistant) return;

    const tool = activeToolOf(assistant);
    const toolKey = tool ? `${tool.kind}:${tool.scope}` : null;
    if (toolKey !== turn.toolKey) {
      turn.toolKey = toolKey;
      if (tool) {
        send({ type: 'TOOL_STARTED', kind: tool.kind, label: toolStatusLabel(tool, t) });
      } else {
        send({ type: 'TOOL_FINISHED' });
      }
    }

    const spoken = toSpokenText(typeof assistant.content === 'string' ? assistant.content : '');
    if (spoken !== turn.text) {
      if (spoken && !turn.timing.firstToken) turn.timing.firstToken = performance.now();
      turn.text = spoken;
      queue.update(spoken, { final: false });
      send({ type: 'ASSISTANT_TEXT', text: spoken });
    }

    if (!processing && !turn.answered) {
      turn.answered = true;
      queue.update(spoken, { final: true });
      send({ type: 'RUN_ENDED', speechPending: queue.isSpeaking() });
      // The app asked a question: say it. The next utterance answers it.
      const question = assistant.awaitingInput ? assistant.clarification : null;
      if (question?.question && turn.askedQuestionId !== question.questionId) {
        turn.askedQuestionId = question.questionId;
        queue.say(String(question.question));
      }
    }
  }, [active, messages, processing, send, t]);

  // The app asked a question while no turn of ours was running (reopened chat,
  // or a question raised after the answer): say it once.
  useEffect(() => {
    if (!active || turnRef.current?.sent || !clarificationPending) return;
    const message = [...(messages || [])].reverse().find(m => m.clarification && m.awaitingInput);
    const question = message?.clarification;
    if (!question?.question) return;
    const asked = turnRef.current?.askedQuestionId;
    if (asked === question.questionId) return;
    turnRef.current = { sent: false, askedQuestionId: question.questionId, timing: {} };
    queueRef.current?.say(String(question.question));
  }, [active, clarificationPending, messages]);

  // Never record in the background: when the tab is hidden the mic is muted
  // and stays muted until the user comes back and unmutes.
  useEffect(() => {
    if (!active) return undefined;
    const onVisibility = () => {
      if (document.hidden && stateRef.current.status !== VOICE_STATUS.ERROR) {
        sessionRef.current?.setMuted(true);
        send({ type: 'MUTE' });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active, send]);

  // Leaving the page ends the conversation and releases the microphone.
  useEffect(() => teardown, [teardown]);

  const setMuted = useCallback(
    muted => {
      sessionRef.current?.setMuted(muted);
      send({ type: muted ? 'MUTE' : 'UNMUTE' });
      if (muted) queueRef.current?.interrupt();
    },
    [send]
  );

  const updatePref = useCallback((patch, apply) => {
    setPrefs(prev => ({ ...prev, ...patch }));
    saveVoiceModePrefs(patch);
    apply?.();
  }, []);

  return {
    active,
    state,
    levelRef,
    prefs: effective,
    start,
    end,
    retry,
    toggle: () => (active ? end('user') : start()),
    setMuted,
    pushToTalkStart: () => sessionRef.current?.pushToTalkStart(),
    pushToTalkEnd: () => sessionRef.current?.pushToTalkEnd(),
    interrupt: bargeIn,
    setListeningStyle: style =>
      updatePref({ listeningStyle: style }, () => {
        sessionRef.current?.setListeningStyle(style);
        send({ type: 'SET_LISTENING_STYLE', style });
      }),
    setBargeIn: value =>
      updatePref({ bargeIn: value }, () => {
        sessionRef.current?.setBargeIn(value);
        send({ type: 'SET_BARGE_IN', value });
      }),
    setCaptions: value =>
      updatePref({ captions: value }, () => send({ type: 'SET_CAPTIONS', value })),
    setVoice: voice => updatePref({ voice })
  };
}

export default useVoiceMode;
