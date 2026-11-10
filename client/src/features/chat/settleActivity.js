// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a message's activity shows once its turn is over on the client but the
 * run never said so (issue #3534).
 *
 * Two cases leave the run state behind what the user sees:
 *
 * - **Stop, or a transport error.** The client closes the stream and drops every
 *   later frame (`useEventSource`), so neither `args.ended` (aborted) nor
 *   `run/ended` reaches the reducer. The run still looks as if it were writing a
 *   call or waiting for the model, with a clock that keeps counting, although
 *   the message is no longer loading.
 * - **A decided approval.** The call continues in a new answer; the old run keeps
 *   its pending interaction, so its row would say "Waiting for approval" next to
 *   the card that already shows the decision.
 *
 * Pure: it returns the activity it was given when there is nothing to settle.
 *
 * @module features/chat/settleActivity
 */

/** Row states that mean "still going"; after an interruption they are `stopped`. */
const ACTIVE_STATUSES = new Set(['preparing', 'running']);

/** A row that was still going when the turn was interrupted, now final. */
function settleItem(item) {
  return ACTIVE_STATUSES.has(item.status) ? { ...item, status: 'stopped', ready: false } : item;
}

/**
 * @param {{items?: Object[], reading?: string|null, idle?: Object, answering?: boolean}|null|undefined} activity
 *   see `shared/run/toolActivity`
 * @param {Object} [state]
 * @param {boolean} [state.interrupted] - the turn ended by Stop or an error, and is no longer loading
 * @param {boolean} [state.decided] - the user answered the approval the activity waits on
 * @returns {Object|null|undefined} the activity to show
 */
export function settleActivity(activity, { interrupted = false, decided = false } = {}) {
  if (!activity || (!interrupted && !decided)) return activity;
  let items = activity.items || [];
  if (decided) items = items.filter(item => item.status !== 'awaiting');
  if (!interrupted) return { ...activity, items };
  // The silence, the page being read and the answer being written are over.
  const { idle: _idle, answering: _answering, ...rest } = activity;
  return { ...rest, items: items.map(settleItem), reading: null };
}
