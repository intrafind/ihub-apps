import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { fetchWithAuthRetry } from '../../../shared/utils/openSseStream';
import PcmStreamPlayer from './pcmStreamPlayer';

/**
 * Read aloud: the one playback the page has. Starting a message stops the one
 * playing, and every play button reads its state from here (see
 * `useReadAloudPlayback`). A finished message is kept in memory for a few
 * replays, so playing it again costs no second request.
 */

const IDLE = Object.freeze({ id: null, state: 'idle', error: null });
/** Finished recordings kept for an instant replay. */
const MAX_RECORDINGS = 5;
const MAX_RECORDINGS_BYTES = 64 * 1024 * 1024;

let snapshot = IDLE;
let player = null;
const listeners = new Set();
// Insertion order is recency order: a hit is deleted and re-inserted.
const recordings = new Map();

function emit(next) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot() {
  return snapshot;
}

/** The playback state of message `id`, or the shared idle state. */
export function getPlaybackFor(id) {
  return snapshot.id === id ? snapshot : IDLE;
}

function recordingKey(text, modelId) {
  return `${modelId || ''}\u0000${text}`;
}

function remember(key, recording) {
  if (!recording) return;
  recordings.delete(key);
  recordings.set(key, recording);
  let total = 0;
  for (const entry of recordings.values()) total += entry.bytes;
  for (const [oldKey, entry] of recordings) {
    if (recordings.size <= MAX_RECORDINGS && total <= MAX_RECORDINGS_BYTES) break;
    recordings.delete(oldKey);
    total -= entry.bytes;
  }
}

/**
 * Read `text` aloud as message `id`. Call it from the click handler: browsers
 * only start audio from a user gesture.
 *
 * @param {string} id - The message being read.
 * @param {{ text: string, modelId?: string, language?: string }} params -
 *   `modelId` omitted uses the platform default. `language` (the UI language)
 *   picks the voice when the message's own language is unclear.
 */
export function play(id, { text, modelId, language } = {}) {
  stop();
  const key = recordingKey(text, modelId);

  let current;
  try {
    current = new PcmStreamPlayer({
      onStateChange: (state, info) => {
        if (player !== current) return;
        if (state === 'ended') remember(key, current.getRecording());
        if (state === 'ended' || state === 'stopped') {
          player = null;
          emit(IDLE);
          return;
        }
        emit({ id, state, error: state === 'error' ? info?.error?.message || 'Error' : null });
        if (state === 'error') player = null;
      }
    });
  } catch (error) {
    emit({ id, state: 'error', error: error.message });
    return;
  }
  player = current;
  emit({ id, state: 'loading', error: null });

  const cached = recordings.get(key);
  if (cached) {
    recordings.delete(key);
    recordings.set(key, cached);
    current.replay(cached);
    return;
  }

  current.start(signal =>
    fetchWithAuthRetry(buildApiUrl('/voice/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(modelId ? { modelId } : {}),
        ...(language ? { language } : {})
      }),
      signal
    })
  );
}

export function pause() {
  player?.pause();
}

export function resume() {
  player?.resume();
}

/** Stop whatever is playing. With `id`, only when that message is the one playing. */
export function stop(id) {
  if (id !== undefined && snapshot.id !== id) return;
  const current = player;
  player = null;
  current?.stop();
  if (snapshot !== IDLE) emit(IDLE);
}

/**
 * The play button's click: play, pause, or resume message `id`.
 *
 * @param {string} id
 * @param {{ text: string, modelId?: string, language?: string }} params
 */
export function toggle(id, params) {
  if (snapshot.id === id) {
    if (snapshot.state === 'playing') return pause();
    if (snapshot.state === 'paused') return resume();
    // Still waiting for the first audio: clicking again cancels.
    if (snapshot.state === 'loading') return stop();
  }
  return play(id, params);
}

export default { subscribe, getSnapshot, getPlaybackFor, play, pause, resume, stop, toggle };
