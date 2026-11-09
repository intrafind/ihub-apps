// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ANNOUNCE_CLEAR_AFTER_MS, ANNOUNCE_MIN_GAP_MS } from '../activityConstants.js';
import {
  createAnnouncerState,
  deriveAnnouncements,
  enqueueAnnouncements,
  takeAnnouncement
} from '../deriveAnnouncements.js';

/** Pause between emptying the region and refilling it with a text it already holds, so it is read again. */
const REFILL_DELAY_MS = 50;

/**
 * Speaks the run activity to a screen reader, once, in a short script (issue
 * #3534).
 *
 * The chat log is `role="log" aria-live="polite"`, and the activity list inside
 * it is switched off (`aria-live="off"`) because a ticking clock would be read
 * every second; without this a screen-reader user would hear nothing of a
 * two-minute file creation. What is said, when, and in what order is decided by
 * `deriveAnnouncements`; this component only owns the live region and the
 * timers: the region is rendered from the start (a live region that is injected
 * together with its text is unreliable), one message goes in at a time, at
 * least `ANNOUNCE_MIN_GAP_MS` apart, and the text is emptied again after
 * `ANNOUNCE_CLEAR_AFTER_MS` so a repeat of the same words is read again.
 *
 * @param {Object} props
 * @param {Array<Object>} props.messages - the displayed messages of the chat list
 */
function RunAnnouncer({ messages }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const runRef = useRef({
    state: createAnnouncerState(),
    queue: [],
    spokeAt: null,
    shown: '',
    timers: { wake: null, drain: null, clear: null, refill: null }
  });

  useEffect(() => {
    const current = runRef.current;
    const { timers } = current;
    const later = (name, ms, action) => {
      clearTimeout(timers[name]);
      timers[name] = setTimeout(action, ms);
    };
    const show = value => {
      current.shown = value;
      setText(value);
    };
    const speak = value => {
      clearTimeout(timers.refill);
      if (current.shown === value) {
        // The same words again: the region must change to be read.
        show('');
        timers.refill = setTimeout(() => show(value), REFILL_DELAY_MS);
      } else {
        show(value);
      }
      later('clear', ANNOUNCE_CLEAR_AFTER_MS, () => show(''));
    };
    const drain = () => {
      const now = performance.now();
      const next = takeAnnouncement(current.queue, current.spokeAt, now);
      current.queue = next.queue;
      if (next.announcement) {
        current.spokeAt = now;
        speak(next.announcement.text);
      }
      const wait = next.announcement && next.queue.length ? ANNOUNCE_MIN_GAP_MS : next.waitMs;
      if (wait !== null && wait !== undefined) later('drain', wait + 1, drain);
    };
    const derive = () => {
      const now = performance.now();
      const previousId = current.state.messageId;
      const result = deriveAnnouncements(current.state, messages, { t, now });
      // A new turn starts with nothing left over from the last.
      if (result.state.messageId !== previousId) current.queue = [];
      current.state = result.state;
      current.queue = enqueueAnnouncements(current.queue, result.announcements);
      drain();
      if (result.wakeInMs !== null) later('wake', result.wakeInMs + 1, derive);
      else clearTimeout(timers.wake);
    };
    derive();
  }, [messages, t]);

  useEffect(() => {
    const { timers } = runRef.current;
    return () => Object.values(timers).forEach(timer => clearTimeout(timer));
  }, []);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}

export default RunAnnouncer;
