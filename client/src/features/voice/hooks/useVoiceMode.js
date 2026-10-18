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

/** Two pieces of one spoken sentence as one text; either may be empty. */
function joinSpoken(first, second) {
  return [first, second]
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Whether the transcript the state machine just took is the turn to send. While
 * the app speaks (or answers) and nobody interrupted it, a late transcript is
 * not one, and sending it would start a second run on top of the first.
 */
function startsTurn(before, after) {
  return (
    after !== before &&
    after.status === VOICE_STATUS.THINKING &&
    after.userCaption.final &&
    !after.runActive
  );
}

/** The question the app asked last (`ask_user`), whether or not it still waits. */
function lastClarification(messages) {
  return [...(messages || [])].reverse().find(message => message.clarification)?.clarification;
}

/** Send the turn's text through the chat; a send that fails or throws is "not accepted". */
async function sendSpoken(sendTurn, spoken, options) {
  try {
    return await (options ? sendTurn(spoken, options) : sendTurn(spoken));
  } catch (error) {
    debugLog('voiceMode: sending the turn failed', error);
    return false;
  }
}

/** How long a typed message waits for the answer it stopped to wind down. */
const STOPPED_RUN_GRACE_MS = 3000;

/**
 * Resolves once the chat has no run going (or after `timeoutMs`): a run that
 * was just cancelled ends a moment later, and the chat turns a new message
 * away while one is running.
 */
async function untilIdle(latestRef, timeoutMs = STOPPED_RUN_GRACE_MS) {
  const until = Date.now() + timeoutMs;
  while (latestRef.current.processing && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * The `TOOL_STARTED` / `TOOL_FINISHED` action for a tool that started or ended
 * since the last pass over the assistant message, or null. Remembers the tool on
 * the turn so that the same one is reported once.
 */
function nextToolAction(turn, assistant, t) {
  const tool = activeToolOf(assistant);
  const toolKey = tool ? `${tool.kind}:${tool.scope}` : null;
  if (toolKey === turn.toolKey) return null;
  turn.toolKey = toolKey;
  if (!tool) return { type: 'TOOL_FINISHED' };
  return { type: 'TOOL_STARTED', kind: tool.kind, label: toolStatusLabel(tool, t) };
}

/**
 * The stages of a turn in milliseconds after the voice activity detector's
 * speech-end event, or null for a turn that has no such event or no audio.
 *
 * That event comes `endOfTurnSilenceMs` after the user's last word (the silence
 * that ends a turn), so the time from the end of the speech to the first audio
 * is `endOfTurnSilenceMs + firstAudio`.
 *
 * @param {{ turnEnd?: number, final?: number, firstToken?: number, firstChunk?: number, firstAudio?: number }} timing
 *   `performance.now()` timestamps.
 * @param {number} [endOfTurnSilenceMs]
 */
function timingReport(timing, endOfTurnSilenceMs) {
  const { turnEnd, final, firstToken, firstChunk, firstAudio } = timing;
  if (!turnEnd || !firstAudio) return null;
  const after = at => (at ? at - turnEnd : null);
  return {
    endOfTurnSilenceMs: endOfTurnSilenceMs ?? null,
    sttFinal: after(final),
    firstToken: after(firstToken),
    firstChunk: after(firstChunk),
    firstAudio: firstAudio - turnEnd
  };
}

/**
 * Record when the first audio of a turn starts and log the turn's stages (once:
 * a later answer in the same turn, such as a question, is not its first audio).
 */
function logFirstAudio(turn, endOfTurnSilenceMs) {
  const timing = turn?.timing;
  if (!timing || timing.firstAudio) return;
  timing.firstAudio = performance.now();
  const report = timingReport(timing, endOfTurnSilenceMs);
  if (report) debugLog('voiceMode.timing', report);
}

/**
 * Hand the session what changed while it was being created (the microphone
 * prompt can stay open for a long time): the options the user picked and the
 * mute. `applied` is what `createVoiceSession` was given.
 */
function syncNewSession(session, applied, latest, muted) {
  if (latest.listeningStyle !== applied.listeningStyle) {
    session.setListeningStyle(latest.listeningStyle);
  }
  if (latest.bargeIn !== applied.bargeIn) session.setBargeIn(latest.bargeIn);
  if (muted) session.setMuted(true);
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
 * `interrupt()` is what a tap on the orb calls: it stops the app (audio and run)
 * and listens, whatever the "interrupt by speaking" setting says.
 *
 * @param {Object} params
 * @param {ReturnType<import('./useVoiceModeAvailability').useVoiceModeAvailability>} params.availability
 * @param {string} params.language - UI language: recognition and voice language hint.
 * @param {Array} params.messages - The chat's messages (`useAppChat`).
 * @param {boolean} params.processing - A turn is running (`useAppChat`).
 * @param {boolean} params.clarificationPending - The app asked a question and waits.
 * @param {(text: string, options?: { typed?: boolean }) => Promise<boolean>} params.sendTurn -
 *   Send a turn; resolves to whether it was accepted. `typed` is a message typed while voice
 *   mode is on (see `sendText`), not spoken.
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
    captions: prefs.captions ?? true
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
  /**
   * The turn in progress. Before it is sent: `{ timing }` (the user spoke, the
   * transcript is on its way). After: `{ sent, baseCount, timing, answered, text,
   * toolKey, silenced }`, which the answer is read against.
   */
  const turnRef = useRef(null);
  /** A typed message is on its way (`sendText`): a late transcript is no turn. */
  const typingRef = useRef(false);
  /**
   * The text of a transcript that arrived while the user was already talking
   * again: the first part of a sentence the pause cut in two, to be put in
   * front of the next transcript.
   */
  const prefixRef = useRef('');
  /** The question (id) the app asked that was spoken in this session, so it is said once. */
  const askedQuestionRef = useRef(null);
  const timeLimitRef = useRef(null);
  /** Mic level (0..1) for the orb. A ref, so ~15 updates a second re-render nothing. */
  const levelRef = useRef(0);

  const clearTimeLimit = () => {
    if (timeLimitRef.current) clearTimeout(timeLimitRef.current);
    timeLimitRef.current = null;
  };

  /** Close the microphone, the speech-to-text connection and the audio. */
  const teardown = useCallback(() => {
    generationRef.current += 1;
    clearTimeLimit();
    turnRef.current = null;
    prefixRef.current = '';
    askedQuestionRef.current = null;
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

  /**
   * The user took over from the app: stop its audio and its run, and listen.
   * Speech over the app (the session's `barge-in`, or speech while it thinks)
   * respects the "interrupt by speaking" setting in the state machine; `force`,
   * for a tap on the orb, does not.
   *
   * @param {boolean} [force=false] - Anything but `true` (a click event) is not forced.
   */
  const bargeIn = useCallback(
    (force = false) => {
      // The state machine would turn the interruption down; the audio and the
      // run must not be stopped behind its back.
      if (force !== true && !stateRef.current.bargeIn) return;
      queueRef.current?.interrupt();
      const turn = turnRef.current;
      turnRef.current = null;
      if (turn && latestRef.current.processing) {
        latestRef.current.cancelGeneration('voice-barge-in');
      }
      sessionRef.current?.setAgentState('idle');
      send({ type: 'BARGE_IN', force: force === true });
    },
    [send]
  );

  /**
   * Stop the audio while the turn goes on (muted, or the session failed): the
   * answer keeps streaming into the chat. The speech queue forgets what it said
   * when interrupted, so feeding it the growing text again would read the whole
   * answer from its first sentence; the turn is marked `silenced` instead.
   */
  const silenceAudio = useCallback(() => {
    queueRef.current?.interrupt();
    if (turnRef.current?.sent) turnRef.current.silenced = true;
    sessionRef.current?.setAgentState('idle');
  }, []);

  /**
   * A turn that goes no further: the state goes back to listening and the app
   * says why. The caller decides whether anything is left pending (a question
   * the user still has to answer stays pending).
   */
  const endTurnWithMessage = useCallback(
    (key, fallback) => {
      turnRef.current = null;
      sessionRef.current?.setAgentState('idle');
      send({ type: 'RUN_ENDED' });
      queueRef.current?.say(latestRef.current.t(key, fallback));
    },
    [send]
  );

  /**
   * Send the turn (or answer the app's question with it) and start waiting for
   * the answer. Resolves to whether the chat took it.
   */
  const deliverTurn = useCallback(
    async (spoken, timing, { typed = false } = {}) => {
      const current = latestRef.current;
      // What the user said to a question the app asked. Words that name none of
      // its options are not an answer: guessing one would put the wrong
      // confirmation in front of the model.
      const asked = current.clarificationPending ? lastClarification(current.messages) : null;
      const answer = current.clarificationPending ? answerForClarification(spoken, asked) : null;
      if (current.clarificationPending && !answer) {
        // The question stays pending; the user is asked to say it again.
        endTurnWithMessage(
          'voiceMode.errors.notUnderstood',
          'I did not catch which option you meant. Please say it again.'
        );
        return false;
      }

      turnRef.current = {
        sent: true,
        baseCount: current.messages.length,
        timing: timing || {},
        answered: false,
        text: '',
        // A message typed while muted: the answer is only text, like the rest
        // of a muted conversation.
        silenced: stateRef.current.muted
      };
      sessionRef.current?.setAgentState('thinking');

      let accepted = true;
      if (answer) {
        current.answerClarification({
          questionId: asked?.questionId,
          answered: true,
          skipped: false,
          ...answer
        });
      } else {
        accepted = await sendSpoken(current.sendTurn, spoken, typed ? { typed } : undefined);
      }
      if (!accepted) {
        endTurnWithMessage(
          'voiceMode.errors.sendFailed',
          'I could not send that. Please try again.'
        );
        return false;
      }
      send({ type: 'SENT' });
      return true;
    },
    [endTurnWithMessage, send]
  );

  const handleFinal = useCallback(
    async text => {
      // The words of a sentence the user gave up for a typed message.
      if (typingRef.current) return;
      const heard = String(text ?? '').trim();
      if (stateRef.current.status === VOICE_STATUS.USER_SPEAKING) {
        // The user paused, the silence ended the turn, and they went on before
        // this transcript came back. It is the first part of one sentence, not a
        // turn: sending it now would answer half a question and swallow the rest.
        prefixRef.current = joinSpoken(prefixRef.current, heard);
        send({ type: 'FINAL', text: prefixRef.current });
        return;
      }

      const spoken = joinSpoken(prefixRef.current, heard);
      prefixRef.current = '';
      const turn = turnRef.current;
      // A transcript of no turn of ours (nothing sent yet) is what the timing is about.
      if (turn && !turn.sent && turn.timing) turn.timing.final = performance.now();
      const before = stateRef.current;
      send({ type: 'FINAL', text: spoken });
      if (isDroppedTranscript(spoken)) {
        // Back to idle only when nothing is going on: an empty transcript that
        // arrives during a run (a cough while the app thinks) does not end it.
        const { runActive, status } = stateRef.current;
        if (!runActive && status !== VOICE_STATUS.SPEAKING) {
          sessionRef.current?.setAgentState('idle');
        }
        return;
      }
      if (!startsTurn(before, stateRef.current)) return;
      await deliverTurn(spoken, turn && !turn.sent ? turn.timing : undefined);
    },
    [deliverTurn, send]
  );

  /**
   * A message typed while voice mode is on (the way Claude's composer stays a
   * text field): a turn like a spoken one, answered out loud, but not marked as
   * spoken. It takes over from an answer still running, like Stop, and from a
   * sentence the user had begun to say. Resolves to whether the chat took it.
   */
  const sendText = useCallback(
    async raw => {
      const text = String(raw ?? '').trim();
      const { status, runActive } = stateRef.current;
      if (!text || status === VOICE_STATUS.CONNECTING || status === VOICE_STATUS.ERROR) {
        return false;
      }
      if (status === VOICE_STATUS.THINKING || status === VOICE_STATUS.SPEAKING || runActive) {
        bargeIn(true);
      }
      prefixRef.current = '';
      turnRef.current = null;
      typingRef.current = true;
      send({ type: 'TYPED' });
      try {
        await untilIdle(latestRef);
        return await deliverTurn(text, undefined, { typed: true });
      } finally {
        typingRef.current = false;
      }
    },
    [bargeIn, deliverTurn, send]
  );

  /**
   * The app's question answered in the chat (an option button, or Skip) while
   * voice mode is on: a turn like a spoken answer, so the continuation is read
   * out. It takes over from an answer still running, like Stop.
   *
   * @param {Object} response - What the clarification card submits.
   */
  const answerInChat = useCallback(
    response => {
      const current = latestRef.current;
      const { status, runActive } = stateRef.current;
      if (status === VOICE_STATUS.CONNECTING || status === VOICE_STATUS.ERROR) {
        current.answerClarification(response);
        return;
      }
      if (status === VOICE_STATUS.THINKING || status === VOICE_STATUS.SPEAKING || runActive) {
        bargeIn(true);
      }
      prefixRef.current = '';
      turnRef.current = {
        sent: true,
        baseCount: current.messages.length,
        timing: {},
        answered: false,
        text: '',
        silenced: stateRef.current.muted
      };
      sessionRef.current?.setAgentState('thinking');
      send({ type: 'TYPED' });
      current.answerClarification(response);
      send({ type: 'SENT' });
    },
    [bargeIn, send]
  );

  /** The session ended a turn (silence, or push-to-talk released); the transcript follows. */
  const handleTurnEnd = useCallback(() => {
    const turn = turnRef.current;
    const turnEnd = performance.now();
    if (turn?.sent) {
      // A run is going and this sound is none of its business (the state machine
      // ignores it): replacing the turn would lose the answer that is on its way.
      if (!turn.timing.turnEnd) turn.timing.turnEnd = turnEnd;
    } else {
      turnRef.current = { timing: { turnEnd } };
    }
    send({ type: 'TURN_ENDED' });
    // The transcript is on its way: the app is busy from here on. With
    // interrupting off, whatever the user says meanwhile starts no turn.
    if (stateRef.current.status === VOICE_STATUS.THINKING) {
      sessionRef.current?.setAgentState('thinking');
    }
  }, [send]);

  /** Speaking while the app works on the answer is an interruption too. */
  const handleSpeechStart = useCallback(() => {
    if (stateRef.current.status === VOICE_STATUS.THINKING && latestRef.current.effective.bargeIn) {
      bargeIn();
    } else {
      send({ type: 'SPEECH_START' });
    }
  }, [bargeIn, send]);

  const handleSessionError = useCallback(
    event => {
      debugLog('voiceMode: session error', event);
      if (!event.recoverable) {
        silenceAudio();
        sessionRef.current?.stop();
        sessionRef.current = null;
      }
      send({ type: 'ERROR', code: event.code, message: event.message });
    },
    [send, silenceAudio]
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
          handleSpeechStart();
          break;
        case 'barge-in':
          bargeIn();
          break;
        case 'interim':
          // The caption is the whole sentence, with the part said before the pause.
          send({ type: 'INTERIM', text: joinSpoken(prefixRef.current, event.text) });
          break;
        case 'turn-end':
          handleTurnEnd();
          break;
        case 'final':
          handleFinal(event.text).catch(error => debugLog('voiceMode: final failed', error));
          break;
        case 'error':
          handleSessionError(event);
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
    [bargeIn, end, handleFinal, handleSessionError, handleSpeechStart, handleTurnEnd, send]
  );

  // --- the speech queue's callbacks; `generation` drops those of a closed session ---

  const handleSpeakingStart = useCallback(
    generation => {
      if (generation !== generationRef.current) return;
      logFirstAudio(turnRef.current, latestRef.current.availability?.settings?.endOfTurnSilenceMs);
      sessionRef.current?.setAgentState('speaking');
      send({ type: 'PLAYBACK_STARTED' });
    },
    [send]
  );

  const handleDrained = useCallback(
    generation => {
      if (generation !== generationRef.current) return;
      // The audio caught up with the text, but the answer is still being written.
      const busy = stateRef.current.runActive;
      sessionRef.current?.setAgentState(busy ? 'thinking' : 'idle');
      send({ type: 'PLAYBACK_DRAINED' });
    },
    [send]
  );

  const handleSpeechError = useCallback(
    (generation, error) => {
      if (generation !== generationRef.current) return;
      debugLog('voiceMode: text-to-speech failed', error);
      // Nothing would tell the user why they hear nothing; the caption has the answer.
      send({ type: 'NOTICE', notice: 'tts-failed' });
    },
    [send]
  );

  /** The audio has got this far into the caption's text: mark it as spoken. */
  const handleSpeechProgress = useCallback(
    (generation, chars) => {
      if (generation !== generationRef.current) return;
      send({ type: 'SPOKEN_PROGRESS', chars });
    },
    [send]
  );

  const handleSpeechTiming = useCallback((stage, ms) => {
    const timing = turnRef.current?.timing;
    if (stage === 'firstChunk' && timing && !timing.firstChunk) {
      timing.firstChunk = performance.now();
    }
    debugLog('voiceMode.timing', { stage, ms });
  }, []);

  const connect = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const { availability: avail, language: lang, effective: options } = latestRef.current;

    try {
      // Created in the click handler's call stack: it unlocks audio playback.
      queueRef.current = createSpeechQueue({
        modelId: avail.ttsModelId,
        language: lang,
        // The app's own voice (`inputMode.voiceMode.voice`), when it sets one.
        voice: avail.settings.voice || undefined,
        onSpeakingStart: () => handleSpeakingStart(generation),
        onDrained: () => handleDrained(generation),
        onError: error => handleSpeechError(generation, error),
        onProgress: chars => handleSpeechProgress(generation, chars),
        onTiming: handleSpeechTiming
      });
    } catch (error) {
      send({ type: 'ERROR', code: 'audio-unsupported', message: error?.message || '' });
      return;
    }

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
      syncNewSession(session, options, latestRef.current.effective, stateRef.current.muted);
    } catch (error) {
      if (generation !== generationRef.current) return;
      queueRef.current?.dispose();
      queueRef.current = null;
      send({ type: 'ERROR', code: startErrorCode(error), message: error?.message || '' });
    }
  }, [
    handleDrained,
    handleSessionEvent,
    handleSpeakingStart,
    handleSpeechError,
    handleSpeechProgress,
    handleSpeechTiming,
    send
  ]);

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
    // Feeding the queue after the final text would start a second answer.
    if (turn.answered) return;
    const assistant = findTurnAssistant(messages, turn.baseCount);
    if (!assistant) return;

    const toolAction = nextToolAction(turn, assistant, t);
    if (toolAction) send(toolAction);

    const spoken = toSpokenText(typeof assistant.content === 'string' ? assistant.content : '');
    if (spoken !== turn.text) {
      if (spoken && !turn.timing.firstToken) turn.timing.firstToken = performance.now();
      turn.text = spoken;
      if (!turn.silenced) queue.update(spoken, { final: false });
      send({ type: 'ASSISTANT_TEXT', text: spoken });
    }

    if (!processing && !turn.answered) {
      turn.answered = true;
      if (turn.silenced) {
        // Muted (or the session failed) while the answer streamed: it was only text.
        send({ type: 'RUN_ENDED', pendingAudio: false });
        return;
      }
      queue.update(spoken, { final: true });
      send({ type: 'RUN_ENDED', pendingAudio: queue.isSpeaking() });
      // The app asked a question: say it. The next utterance answers it.
      const question = assistant.awaitingInput ? assistant.clarification : null;
      if (question?.question && askedQuestionRef.current !== question.questionId) {
        askedQuestionRef.current = question.questionId;
        queue.say(String(question.question));
      }
    }
  }, [active, messages, processing, send, t]);

  // The app asked a question while no turn of ours was running (reopened chat,
  // or a question raised after the answer): say it once. Not before the session
  // is up: the audio would start while the state machine still ignores it.
  const connected = state.status !== VOICE_STATUS.CONNECTING;
  useEffect(() => {
    const queue = queueRef.current;
    if (!active || !connected || !queue || turnRef.current?.sent || !clarificationPending) return;
    const message = [...(messages || [])].reverse().find(m => m.clarification && m.awaitingInput);
    const question = message?.clarification;
    if (!question?.question || askedQuestionRef.current === question.questionId) return;
    askedQuestionRef.current = question.questionId;
    queue.say(String(question.question));
  }, [active, connected, clarificationPending, messages]);

  // Never record in the background: when the tab is hidden the mic is muted
  // and stays muted until the user comes back and unmutes.
  useEffect(() => {
    if (!active) return undefined;
    const onVisibility = () => {
      if (document.hidden && stateRef.current.status !== VOICE_STATUS.ERROR) {
        sessionRef.current?.setMuted(true);
        prefixRef.current = '';
        send({ type: 'MUTE' });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active, send]);

  // Leaving the page ends the conversation and releases the microphone.
  useEffect(() => teardown, [teardown]);

  // Muting stops the microphone and the audio; the turn in progress goes on as text.
  const setMuted = useCallback(
    muted => {
      sessionRef.current?.setMuted(muted);
      send({ type: muted ? 'MUTE' : 'UNMUTE' });
      if (muted) {
        // What was said before the mute is not the start of what is said after it.
        prefixRef.current = '';
        silenceAudio();
      }
    },
    [send, silenceAudio]
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
    sendText,
    answerInChat,
    setMuted,
    pushToTalkStart: () => sessionRef.current?.pushToTalkStart(),
    pushToTalkEnd: () => sessionRef.current?.pushToTalkEnd(),
    // The orb is a button: its click event must not reach `bargeIn` as `force`.
    interrupt: () => bargeIn(true),
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
      updatePref({ captions: value }, () => send({ type: 'SET_CAPTIONS', value }))
  };
}

export default useVoiceMode;
