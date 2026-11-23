// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ANNOUNCE_CLEAR_AFTER_MS,
  ANNOUNCE_MIN_GAP_MS
} from '../../features/chat/activityConstants.js';

/** Pause between emptying the region and refilling it with a text it already holds, so it is read again. */
const REFILL_DELAY_MS = 50;

/** Most messages that wait for their turn; the oldest is dropped first. */
export const ANNOUNCER_MAX_QUEUE = 5;

const AnnouncerContext = createContext(null);

/** What `useAnnounce` gives outside a provider: nothing is said, nothing breaks. */
const SILENT = () => {};

/**
 * The page's one polite live region, and the queue in front of it.
 *
 * Every part of the page that has something to say to a screen reader (the run
 * activity, a toast, a message that waits for the answer) says it through
 * {@link useAnnounce} instead of rendering its own `aria-live` region: two
 * regions that speak at once cut each other off, and a region injected together
 * with its text is often not read at all. The region is rendered from the
 * start and stays empty until there is something to say.
 *
 * The rules of the region are the ones `RunAnnouncer` had for itself: at least
 * `ANNOUNCE_MIN_GAP_MS` between two messages (the later one waits, at most
 * {@link ANNOUNCER_MAX_QUEUE} wait), the text is emptied after
 * `ANNOUNCE_CLEAR_AFTER_MS`, and a text the region already holds is emptied and
 * filled again so it is read a second time. The same text said again while it
 * still waits, or less than `ANNOUNCE_MIN_GAP_MS` after it was said, is said
 * once: two copies of a part on one page (the chat list renders one for narrow
 * and one for wide screens) do not make a screen reader say everything twice.
 *
 * A provider inside another one adds no second region: it hands its children
 * the outer one. `Layout` mounts it for every page of the shell; the pages that
 * live outside the shell (the shared chat, the Office pane and the browser
 * extension) mount their own.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @returns {JSX.Element}
 */
export function AnnouncerProvider({ children }) {
  const outer = use(AnnouncerContext);
  if (outer) return children;
  return <AnnouncerRoot>{children}</AnnouncerRoot>;
}

function AnnouncerRoot({ children }) {
  const [text, setText] = useState('');
  const stateRef = useRef({
    queue: [],
    shown: '',
    spokeAt: null,
    lastText: null,
    timers: { drain: null, clear: null, refill: null }
  });

  const announce = useCallback(message => {
    const value = typeof message === 'string' ? message.trim() : '';
    if (!value) return;
    const current = stateRef.current;
    const { timers } = current;
    const show = next => {
      current.shown = next;
      setText(next);
    };
    const speak = next => {
      clearTimeout(timers.refill);
      if (current.shown === next) {
        // The same words again: the region has to change to be read.
        show('');
        timers.refill = setTimeout(() => show(next), REFILL_DELAY_MS);
      } else {
        show(next);
      }
      clearTimeout(timers.clear);
      timers.clear = setTimeout(() => show(''), ANNOUNCE_CLEAR_AFTER_MS);
    };
    const drain = () => {
      timers.drain = null;
      if (current.queue.length === 0) return;
      const now = performance.now();
      const waited = current.spokeAt === null ? Infinity : now - current.spokeAt;
      if (waited < ANNOUNCE_MIN_GAP_MS) {
        timers.drain = setTimeout(drain, ANNOUNCE_MIN_GAP_MS - waited + 1);
        return;
      }
      const [next, ...rest] = current.queue;
      current.queue = rest;
      current.spokeAt = now;
      current.lastText = next;
      speak(next);
      if (rest.length) timers.drain = setTimeout(drain, ANNOUNCE_MIN_GAP_MS + 1);
    };
    // The same words twice at once are one announcement: a page can hold two
    // copies of a part (the chat list is rendered for narrow and for wide
    // screens, one of them hidden), and both say what they see.
    const justSaid =
      current.lastText === value &&
      current.spokeAt !== null &&
      performance.now() - current.spokeAt < ANNOUNCE_MIN_GAP_MS;
    if (justSaid || current.queue.includes(value)) return;
    current.queue = [...current.queue, value].slice(-ANNOUNCER_MAX_QUEUE);
    if (!timers.drain) drain();
  }, []);

  useEffect(() => {
    const { timers } = stateRef.current;
    return () => Object.values(timers).forEach(timer => clearTimeout(timer));
  }, []);

  const value = useMemo(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="announcer"
      >
        {text}
      </div>
    </AnnouncerContext>
  );
}

/**
 * The function that says a text to a screen reader through the page's one live
 * region: `announce('Message removed')`. Stable across renders. Outside an
 * {@link AnnouncerProvider} it says nothing.
 *
 * @returns {(text: string) => void}
 */
export function useAnnounce() {
  return use(AnnouncerContext)?.announce || SILENT;
}

export default AnnouncerProvider;
