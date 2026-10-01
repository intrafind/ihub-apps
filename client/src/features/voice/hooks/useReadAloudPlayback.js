import { useEffect, useSyncExternalStore } from 'react';
import { subscribe, getPlaybackFor, stop } from '../utils/readAloud';

/**
 * The read-aloud state of message `id`: `{ state, error }` where state is
 * `idle | loading | playing | paused | error`. Only the message being played
 * re-renders when playback changes. Leaving the chat (the message unmounts)
 * stops its playback.
 *
 * @param {string} id
 */
export function useReadAloudPlayback(id) {
  const playback = useSyncExternalStore(subscribe, () => getPlaybackFor(id));
  useEffect(() => () => stop(id), [id]);
  return playback;
}

export default useReadAloudPlayback;
