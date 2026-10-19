// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { fetchWithAuthRetry } from '../../../shared/utils/openSseStream';
import PcmStreamPlayer, { createAudioContext } from './pcmStreamPlayer';
import { createSpeakableChunker } from './speakableChunker';

/**
 * Speaks a streaming answer sentence by sentence (voice mode, issue #2868).
 *
 * `/api/voice/speech` takes one finished text, and waiting for the whole
 * answer would add its full generation time to every reply. So the answer's
 * text is fed in as it streams (`update(fullText)`), a chunker cuts it at
 * sentence ends, and each chunk becomes one speech request. Requests run up to
 * `maxInFlight` at a time, but the audio is played strictly in order and
 * gap-free: all chunks of an answer go through one multi-stream
 * `PcmStreamPlayer`, which schedules each stream right after the previous one
 * whichever response arrives first. The next chunk is generated while the
 * current one plays; speech models generate several times faster than real
 * time, so after the first chunk playback does not stall.
 *
 * One AudioContext serves the whole voice session. It is created (and
 * resumed) synchronously in `createSpeechQueue()`, which therefore has to run
 * inside the click that starts voice mode: that is what autoplay policies
 * (Safari above all) want. `interrupt()` stops the audio without closing it,
 * so the next answer plays at once.
 *
 * One language, so one voice, per answer: the endpoint detects the language of
 * each request's own text, and a short chunk could get a different voice than
 * the one before. The first response names the language it used
 * (`X-Speech-Language`); every later chunk of the answer is sent with that
 * language and `languageFixed: true`. For that, the second chunk is only
 * requested once the first one's response headers are in (they arrive with the
 * first audio, while it plays).
 */

/** `/api/voice/speech` answers 422 with this code for a chunk that has nothing to read (a table, code). */
const NO_SPEAKABLE_TEXT = 'no-speakable-text';

/**
 * Speaking pace used to place the playhead inside a chunk whose audio is still
 * arriving (characters per second, about 170 words a minute).
 */
const CHARS_PER_SECOND = 15;
/** How often the spoken position is read off the audio clock. */
const PROGRESS_INTERVAL_MS = 100;

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** Resume a context that the autoplay policy (or iOS after a call) suspended. Never throws. */
function resumeContext(context) {
  try {
    context.resume?.()?.catch?.(() => {});
  } catch {
    // Closed or not resumable: nothing to do.
  }
}

/** Run a caller's callback; one that throws must not stall the audio. */
function notify(callback, ...args) {
  try {
    callback?.(...args);
  } catch (error) {
    console.error('Speech queue callback failed:', error);
  }
}

/**
 * Create the speech queue. Call it from the click handler that starts voice
 * mode (it creates and resumes the AudioContext); it throws where Web Audio is
 * not available.
 *
 * An answer runs from the first `update()` (or `say()`) after idle or
 * `interrupt()` until `onDrained`. Callbacks may run synchronously inside
 * `update()` / `say()` (an answer with nothing to read drains at once) and
 * never after `interrupt()` or `dispose()`. The text of the next answer may
 * only be fed once the previous one has drained or been interrupted (the text
 * is cumulative per answer), and after `interrupt()` the caller must not feed
 * the interrupted run's text again: the next `update()` starts a new answer.
 *
 * @param {Object} [opts]
 * @param {string} [opts.modelId] - TTS model id; '' or omitted uses the server default.
 * @param {string} [opts.language] - UI language: the language hint of the first chunk.
 * @param {string} [opts.voice] - Voice id of the model, sent as `voice`.
 * @param {number} [opts.maxInFlight=2] - Speech requests in flight at once.
 * @param {{ update: Function, reset: Function }} [opts.chunker] - Replaces
 *   `createSpeakableChunker()` (tests).
 * @param {() => void} [opts.onSpeakingStart] - The first audio of an answer is scheduled.
 * @param {() => void} [opts.onDrained] - The final text was seen and every chunk has played out.
 * @param {(error: Error) => void} [opts.onError] - A chunk failed (HTTP error,
 *   network). The queue skips it and carries on with the next ones, so the
 *   caption still shows the whole answer. A chunk with nothing to read (422
 *   `no-speakable-text`) is skipped silently.
 * @param {(stage: 'firstChunk' | 'firstAudio', ms: number) => void} [opts.onTiming] -
 *   Milliseconds from the answer's first `update()`/`say()` to its first chunk
 *   being cut, and to its first audio being scheduled.
 * @param {(chars: number) => void} [opts.onProgress] - While the answer plays:
 *   how many characters of the text given to `update()` have been spoken so far
 *   (never less than before). The position is read off the audio clock, word by
 *   word; text that is not part of it (`say()`) does not move it, and a chunk
 *   that failed or has nothing to read is passed over as soon as the next one
 *   begins.
 * @returns {{
 *   update: (fullText: string, opts?: { final?: boolean }) => void,
 *   say: (text: string, opts?: { final?: boolean }) => void,
 *   interrupt: () => void,
 *   isSpeaking: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createSpeechQueue({
  modelId,
  language,
  voice,
  maxInFlight = 2,
  chunker,
  onSpeakingStart,
  onDrained,
  onError,
  onTiming,
  onProgress
} = {}) {
  const context = createAudioContext();
  // A context created in a gesture may still start suspended (Safari).
  resumeContext(context);

  const textChunker = chunker || createSpeakableChunker();
  const limit = Math.max(1, Math.floor(maxInFlight) || 1);
  let answer = null;
  let disposed = false;

  function startAnswer(autoFinal) {
    textChunker.reset();
    // Safari suspends an idle context ('interrupted' after a call or Siri).
    if (context.state === 'suspended' || context.state === 'interrupted') resumeContext(context);
    const current = {
      startedAt: now(),
      // Chunks cut but not requested yet.
      queue: [],
      inFlight: 0,
      // Requests sent before the answer's language was known, still awaiting headers.
      probing: 0,
      languageResolved: false,
      language: undefined,
      cutAny: false,
      // Every chunk cut, by index: `{ index, text, range }`, where `range` is
      // `[start, end)` in the text given to `update()`, or null (`say()`).
      chunks: [],
      // Where the next chunk is looked for in the answer text.
      cursor: 0,
      captionText: '',
      spokenChars: 0,
      ticker: null,
      spoke: false,
      finalSeen: false,
      // Created by `say()` alone: nothing else will say when the answer is complete.
      autoFinal,
      cancelled: false,
      player: null
    };
    current.player = new PcmStreamPlayer({
      context,
      multiStream: true,
      onStateChange: state => onPlayerState(current, state)
    });
    answer = current;
    return current;
  }

  function onPlayerState(current, state) {
    if (current.cancelled || answer !== current) return;
    if (state === 'playing' && !current.spoke) {
      current.spoke = true;
      startTicker(current);
      notify(onTiming, 'firstAudio', now() - current.startedAt);
      notify(onSpeakingStart);
    } else if (state === 'ended') {
      answer = null;
      stopTicker(current);
      notify(onDrained);
    }
  }

  /** How much of the answer text has been spoken, never less than reported before. */
  function spokenChars(current) {
    const progress = current.player.progress();
    if (!progress) return current.spokenChars;
    const range = current.chunks[progress.tag]?.range;
    if (!range) {
      // Text that is not part of the answer is playing (`say()`): the answer's
      // own chunks before it have been said.
      for (let k = progress.tag - 1; k >= 0; k -= 1) {
        const before = current.chunks[k]?.range;
        if (before) return Math.max(current.spokenChars, before[1]);
      }
      return current.spokenChars;
    }
    const [start, end] = range;
    // A chunk still arriving is at least as long as the pace says.
    const seconds = progress.complete
      ? progress.knownSeconds
      : Math.max(progress.knownSeconds, (end - start) / CHARS_PER_SECOND);
    const fraction = seconds > 0 ? Math.min(1, progress.playedSeconds / seconds) : 0;
    let at = start + Math.floor(fraction * (end - start));
    if (at < end) {
      // Only whole words count as spoken: stop where a word has ended.
      while (at > start && !/\s/.test(current.captionText[at])) at -= 1;
    }
    return Math.max(current.spokenChars, at);
  }

  function startTicker(current) {
    if (!onProgress || current.ticker) return;
    current.ticker = setInterval(() => {
      if (current.cancelled || answer !== current) return;
      const chars = spokenChars(current);
      if (chars === current.spokenChars) return;
      current.spokenChars = chars;
      notify(onProgress, chars);
    }, PROGRESS_INTERVAL_MS);
  }

  function stopTicker(current) {
    if (current.ticker) clearInterval(current.ticker);
    current.ticker = null;
  }

  function addChunk(current, text, range = null) {
    if (!current.cutAny) {
      current.cutAny = true;
      notify(onTiming, 'firstChunk', now() - current.startedAt);
    }
    const chunk = { index: current.chunks.length, text, range };
    current.chunks.push(chunk);
    current.queue.push(chunk);
  }

  /** Request the next chunks, as many as the in-flight cap and the language pinning allow. */
  function dispatch(current) {
    while (
      !current.cancelled &&
      current.queue.length &&
      current.inFlight < limit &&
      // Until the first response names the language, one request probes alone.
      (current.languageResolved || current.probing === 0)
    ) {
      send(current, current.queue.shift());
    }
  }

  function send(current, chunk) {
    current.inFlight++;
    let probing = !current.languageResolved;
    if (probing) current.probing++;
    const closeProbe = resolved => {
      if (!probing) return;
      probing = false;
      current.probing--;
      if (resolved) current.languageResolved = true;
    };

    const body = { text: chunk.text };
    if (modelId) body.modelId = modelId;
    if (current.language) {
      body.language = current.language;
      body.languageFixed = true;
    } else if (language) {
      body.language = language;
    }
    if (voice) body.voice = voice;

    const settle = result => {
      current.inFlight--;
      closeProbe(false);
      if (current.cancelled) return;
      if (result.status === 'error' && result.error?.code !== NO_SPEAKABLE_TEXT) {
        notify(onError, result.error);
      }
      dispatch(current);
      maybeFinish(current);
    };

    current.player
      .enqueueStream(
        signal =>
          fetchWithAuthRetry(buildApiUrl('/voice/speech'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
          }),
        {
          tag: chunk.index,
          onResponse: response => {
            if (current.cancelled) return;
            const spoken = response.headers?.get?.('X-Speech-Language');
            if (spoken && !current.language) current.language = spoken;
            closeProbe(true);
            dispatch(current);
          }
        }
      )
      .then(settle, error => settle({ status: 'error', error }));
  }

  /** Once the text is complete and every chunk is requested and received, let the player end. */
  function maybeFinish(current) {
    if (current.cancelled || !current.finalSeen || current.queue.length || current.inFlight) return;
    current.player.finish();
  }

  function interrupt() {
    textChunker.reset();
    const current = answer;
    answer = null;
    if (!current) return;
    current.cancelled = true;
    stopTicker(current);
    current.queue.length = 0;
    // Aborts every request in flight and stops every scheduled source; the
    // player leaves the shared context open.
    current.player.stop();
  }

  return {
    /**
     * Feed the cumulative answer text (not a delta). Chunks that became
     * complete are requested in order. `final: true` flushes the rest; once it
     * has been spoken `onDrained` fires.
     */
    update(fullText, { final = false } = {}) {
      if (disposed) return;
      const current = answer || startAnswer(false);
      if (current.autoFinal) {
        // A streamed answer joins a `say()` that opened it.
        current.autoFinal = false;
        current.finalSeen = false;
      }
      current.captionText = typeof fullText === 'string' ? fullText : '';
      for (const text of textChunker.update(fullText, { final })) {
        // A chunk is an exact piece of the cumulative text, in order.
        const start = current.captionText.indexOf(text, current.cursor);
        if (start === -1) {
          addChunk(current, text);
        } else {
          current.cursor = start + text.length;
          addChunk(current, text, [start, current.cursor]);
        }
      }
      if (final) current.finalSeen = true;
      dispatch(current);
      maybeFinish(current);
    },

    /**
     * Speak a short complete text (an interaction question, an error message)
     * as a chunk of the current answer, or of a new one. Alone it is a whole
     * answer: `onDrained` fires when it has been spoken. In the middle of a
     * streamed answer it does not end it (`final: true` would).
     */
    say(text, { final } = {}) {
      if (disposed) return;
      const spoken = typeof text === 'string' ? text.trim() : '';
      if (!spoken) return;
      const current = answer || startAnswer(true);
      addChunk(current, spoken);
      if (final === true || (final === undefined && current.autoFinal)) current.finalSeen = true;
      dispatch(current);
      maybeFinish(current);
    },

    /**
     * Barge-in: abort every request, stop the audio and drop what is queued.
     * The AudioContext stays open for the next answer; no callback fires.
     */
    interrupt,

    /** Whether chunks are pending or audio is scheduled. */
    isSpeaking() {
      const current = answer;
      return Boolean(
        current && (current.queue.length || current.inFlight || current.player.hasAudio())
      );
    },

    /** `interrupt()`, then close the AudioContext. The queue cannot be used afterwards. */
    dispose() {
      if (disposed) return;
      interrupt();
      disposed = true;
      try {
        context.close?.()?.catch?.(() => {});
      } catch {
        // Already closed.
      }
    }
  };
}

export default createSpeechQueue;
