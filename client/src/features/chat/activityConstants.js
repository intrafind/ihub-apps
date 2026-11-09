// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Timings and limits of the run activity display (issue #3534): the one place
 * product can tune them. The server owns when it announces a call and when it
 * reports that the model is silent (`model.waiting`); these are the client's
 * own delays.
 *
 * @module features/chat/activityConstants
 */

/** A row whose arguments are still being written is first painted after this long (no flicker for tiny calls). */
export const PREPARING_GRACE_MS = 500;

/**
 * The model is silent for this long before the server sends `model.waiting`
 * ("Waiting for the model…", "Thinking…"). The clock of that line starts here,
 * so it is shown from its first paint.
 */
export const IDLE_LABEL_AFTER_MS = 3000;

/** The size of the arguments has not grown for this long: the stall caption appears. */
export const STALL_AFTER_MS = 20000;

/** The visible numbers (size, clock) are redrawn at most this often. */
export const PROGRESS_RENDER_MS = 1000;

/** The idle line has been visible this long before a screen reader is told about it. */
export const IDLE_ANNOUNCE_AFTER_MS = 5000;

/** Least time between two announcements to a screen reader. */
export const ANNOUNCE_MIN_GAP_MS = 1500;

/** The announcer's text is emptied after this long, so an identical later message is read again. */
export const ANNOUNCE_CLEAR_AFTER_MS = 5000;

/** Most announcements waiting for their turn; the least important is dropped first. */
export const ANNOUNCE_MAX_QUEUE = 3;

/** How important an announcement is, for ordering and for dropping (higher wins). */
export const ANNOUNCE_PRIORITY = Object.freeze({ low: 1, normal: 2, high: 3, highest: 4 });
