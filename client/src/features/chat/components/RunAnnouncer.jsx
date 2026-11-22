// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ANNOUNCE_MIN_GAP_MS } from '../activityConstants.js';
import { useAnnounce } from '../../../shared/announce/AnnouncerProvider';
import {
  createAnnouncerState,
  deriveAnnouncements,
  enqueueAnnouncements,
  takeAnnouncement
} from '../deriveAnnouncements.js';

/**
 * Speaks the run activity to a screen reader, once, in a short script (issue
 * #3534).
 *
 * The chat log is `role="log" aria-live="polite"`, and the activity list inside
 * it is switched off (`aria-live="off"`) because a ticking clock would be read
 * every second; without this a screen-reader user would hear nothing of a
 * two-minute file creation. What is said, when, and in what order is decided by
 * `deriveAnnouncements`; this component only owns the queue and its timers: one
 * message goes out at a time, at least `ANNOUNCE_MIN_GAP_MS` apart. It renders
 * nothing: the words are said through the page's one live region
 * (`useAnnounce`, `AnnouncerProvider`), which also empties the text again so a
 * repeat of the same words is read again.
 *
 * @param {Object} props
 * @param {Array<Object>} props.messages - the displayed messages of the chat list
 * @param {string} [props.label] - said before each announcement ("Model A: Creating web
 *   artifact"), where several chats are visible at once
 */
function RunAnnouncer({ messages, label }) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const runRef = useRef({
    state: createAnnouncerState(),
    queue: [],
    spokeAt: null,
    timers: { wake: null, drain: null }
  });

  useEffect(() => {
    const current = runRef.current;
    const { timers } = current;
    const later = (name, ms, action) => {
      clearTimeout(timers[name]);
      timers[name] = setTimeout(action, ms);
    };
    const drain = () => {
      const now = performance.now();
      const next = takeAnnouncement(current.queue, current.spokeAt, now);
      current.queue = next.queue;
      if (next.announcement) {
        current.spokeAt = now;
        announce(label ? `${label}: ${next.announcement.text}` : next.announcement.text);
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
  }, [messages, t, label, announce]);

  useEffect(() => {
    const { timers } = runRef.current;
    return () => Object.values(timers).forEach(timer => clearTimeout(timer));
  }, []);

  return null;
}

export default RunAnnouncer;
