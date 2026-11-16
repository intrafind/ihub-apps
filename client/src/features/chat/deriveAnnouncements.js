// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a screen reader is told about a turn, as pure functions (issue #3534).
 *
 * The activity list is silent (`aria-live="off"`: a ticking clock inside the
 * chat log's live region would be read every second), so the screen-reader
 * user would hear nothing of a two-minute file creation. `RunAnnouncer` speaks
 * a short script instead, decided here:
 *
 *   - a call starts (once it is shown): "Creating web artifact"
 *   - a call is waiting for approval, was cut off or refused, was stopped
 *   - a file is done: "Created web artifact"
 *   - the size has not grown for a while (the stall caption)
 *   - the model has been silent for a while: "Waiting for the model" / "Thinking"
 *
 * Never: sizes, clocks, reasoning text, the headline changing. Every event is
 * announced once (`key`), the state starts afresh for each turn, and a turn
 * already finished when it first shows up (a reopened chat) is not read out.
 *
 * @module features/chat/deriveAnnouncements
 */
import {
  ANNOUNCE_MAX_QUEUE,
  ANNOUNCE_MIN_GAP_MS,
  ANNOUNCE_PRIORITY,
  IDLE_ANNOUNCE_AFTER_MS,
  STALL_AFTER_MS
} from './activityConstants.js';
import {
  activeLabel,
  awaitingApprovalLabel,
  createdLabel,
  failedLabel,
  failureReasonOf,
  hasOutputKind,
  idleLabel,
  isActiveItem,
  outputNounOf,
  stalledLabel,
  stoppedUnstartedLabel,
  stripEllipsis
} from './activityHeadline.js';
import { elapsedAt, isPainted, isStalled, paintsIn } from './activityTiming.js';

/**
 * @typedef {Object} Announcement
 * @property {string} key - once per event: `<callId>:start`, `<callId>:done`, `idle:<kind>:<step>`…
 * @property {string} text - what is said: no numbers, no trailing ellipsis
 * @property {'low'|'normal'|'high'|'highest'} priority
 */

/** Longest reason read out after "Failed": the full text stays on screen. */
const MAX_REASON_CHARS = 160;

/** The state the announcer carries from one derivation to the next. */
export function createAnnouncerState() {
  return { messageId: null, quiet: false, done: {}, idleSince: {} };
}

/** A phrase as it is spoken: no ellipsis, first letter capitalised. */
export function spoken(text) {
  const plain = stripEllipsis(text);
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

function lastAssistant(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

/**
 * Collects what to say and when to look again during one derivation. An event
 * is said once: its key is recorded in `done`, which carries over to the next
 * derivation through the state.
 */
function createCollector(done) {
  const collector = {
    done: { ...done },
    announcements: [],
    wakeInMs: null,
    say(key, text, priority) {
      if (collector.done[key]) return;
      collector.done[key] = true;
      collector.announcements.push({ key, text, priority });
    },
    // Derive again in `ms` although nothing changed by then (a grace ends, a caption is due).
    wakeIn(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return;
      const wait = Math.max(1, ms);
      collector.wakeInMs = collector.wakeInMs === null ? wait : Math.min(collector.wakeInMs, wait);
    }
  };
  return collector;
}

/** The events of a call that is being written, waits for approval or runs. */
function announceActiveCall(collector, item, { t, now }) {
  const label = spoken(activeLabel(t, item, null));
  if (item.status === 'awaiting') {
    collector.say(`${item.id}:start`, label, 'normal');
    collector.say(`${item.id}:awaiting`, awaitingApprovalLabel(t), 'high');
    return;
  }
  collector.say(`${item.id}:start`, label, 'normal');
  if (item.status !== 'preparing' || item.ready) return;
  if (isStalled(item, now)) {
    collector.say(`${item.id}:stalled`, stalledLabel(t), 'normal');
  } else if (Number.isFinite(item.grewAtMs)) {
    collector.wakeIn(STALL_AFTER_MS - (elapsedAt(item, now) - item.grewAtMs));
  }
}

/** The events of a call that ended: a file is done, the call failed, a file was stopped. */
function announceEndedCall(collector, item, { t }) {
  const noun = outputNounOf(t, item.outputKind);
  if (item.status === 'completed' && noun) {
    collector.say(`${item.id}:done`, createdLabel(t, noun), 'high');
  } else if (item.status === 'error') {
    const reason = failureReasonOf(t, item) || item.error || '';
    const what = noun ? spoken(noun) : item.name;
    const detail = reason ? ` ${reason.slice(0, MAX_REASON_CHARS)}` : '';
    collector.say(`${item.id}:failed`, `${what}: ${failedLabel(t)}.${detail}`, 'highest');
  } else if (item.status === 'stopped' && !item.started && hasOutputKind(item)) {
    collector.say(`${item.id}:stopped`, stoppedUnstartedLabel(t, item), 'highest');
  } else if (
    item.status === 'completed' &&
    item.kind === 'search' &&
    item.resultCount === 0 &&
    ANNOUNCED_EMPTY_ORIGINS.has(item.origin)
  ) {
    // The server declared that the search found nothing: a screen reader hears
    // it, because an empty list is silent. Never said for a count not declared.
    collector.say(
      `${item.id}:noResults`,
      t(`toolActivity.announce.noResults.${item.origin}`),
      'normal'
    );
  }
}

const ANNOUNCED_EMPTY_ORIGINS = new Set(['web', 'project', 'ifinder', 'iassistant', 'documents']);

/** The idle line, once per model step, after it has been up for a while. */
function announceIdle(collector, idle, idleSince, { t, now }) {
  const key = `idle:${idle.kind}:${idle.step ?? 0}`;
  idleSince[key] = idleSince[key] ?? now;
  if (now - idleSince[key] >= IDLE_ANNOUNCE_AFTER_MS) {
    collector.say(key, spoken(idleLabel(t, idle.kind, idle)), 'low');
  } else {
    collector.wakeIn(IDLE_ANNOUNCE_AFTER_MS - (now - idleSince[key]));
  }
}

/**
 * Work out what to announce now.
 *
 * Looks at the newest assistant message only. The state is per message (each
 * turn has its own), so a new turn starts afresh. A message that is already
 * finished the first time it is seen is history (a reopened chat): its events
 * are recorded as announced and nothing is said.
 *
 * @param {Object} state - from `createAnnouncerState`, or the previous result's `state`
 * @param {Array<Object>} messages - the displayed messages of the list
 * @param {{t: Function, now: number}} context - translate function; `performance.now()`
 * @returns {{state: Object, announcements: Announcement[], wakeInMs: number|null}}
 *   `wakeInMs` is when to derive again although nothing changed (a row's grace
 *   ends, the stall caption is due, the idle line has been up long enough)
 */
export function deriveAnnouncements(state, messages, context) {
  const message = lastAssistant(messages);
  const messageId = message?.id ?? null;
  const previous =
    messageId === state.messageId
      ? state
      : { ...createAnnouncerState(), messageId, quiet: Boolean(message) && !message.loading };
  if (!message) return { state: previous, announcements: [], wakeInMs: null };

  const collector = createCollector(previous.done);
  const idleSince = { ...previous.idleSince };
  const activity = message.toolActivity;
  for (const item of activity?.items || []) {
    // A skill is not a call the user waits for.
    if (item.kind === 'skill') continue;
    if (!isPainted(item, context.now)) {
      collector.wakeIn(paintsIn(item, context.now));
    } else if (isActiveItem(item)) {
      announceActiveCall(collector, item, context);
    } else {
      announceEndedCall(collector, item, context);
    }
  }
  if (activity?.idle) announceIdle(collector, activity.idle, idleSince, context);

  return {
    state: { ...previous, done: collector.done, idleSince },
    announcements: previous.quiet ? [] : collector.announcements,
    wakeInMs: previous.quiet ? null : collector.wakeInMs
  };
}

/**
 * Add announcements to the waiting ones. At most `ANNOUNCE_MAX_QUEUE` wait;
 * beyond that the least important is dropped first (the oldest of equals), so
 * a burst of events never turns into a long monologue.
 *
 * @param {Announcement[]} queue
 * @param {Announcement[]} announcements
 * @returns {Announcement[]}
 */
export function enqueueAnnouncements(queue, announcements) {
  const next = [...queue, ...announcements];
  while (next.length > ANNOUNCE_MAX_QUEUE) {
    let weakest = 0;
    for (let i = 1; i < next.length; i++) {
      if (ANNOUNCE_PRIORITY[next[i].priority] < ANNOUNCE_PRIORITY[next[weakest].priority]) {
        weakest = i;
      }
    }
    next.splice(weakest, 1);
  }
  return next;
}

/**
 * The announcement to speak now, if any: the most important waiting one (the
 * oldest of equals), and only `ANNOUNCE_MIN_GAP_MS` after the last, so two
 * events a moment apart are not read over each other.
 *
 * @param {Announcement[]} queue
 * @param {number|null} lastSpokeAt - `performance.now()` of the last announcement, or null
 * @param {number} now - `performance.now()`
 * @returns {{announcement: Announcement|null, queue: Announcement[], waitMs: number|null}}
 *   `waitMs`: how long until the next may be spoken, when something waits
 */
export function takeAnnouncement(queue, lastSpokeAt, now) {
  if (queue.length === 0) return { announcement: null, queue, waitMs: null };
  const wait = lastSpokeAt === null ? 0 : ANNOUNCE_MIN_GAP_MS - (now - lastSpokeAt);
  if (wait > 0) return { announcement: null, queue, waitMs: wait };
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    if (ANNOUNCE_PRIORITY[queue[i].priority] > ANNOUNCE_PRIORITY[queue[best].priority]) best = i;
  }
  return {
    announcement: queue[best],
    queue: queue.filter((_, index) => index !== best),
    waitMs: null
  };
}
