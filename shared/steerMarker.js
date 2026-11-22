// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The marker a message the person sent into a running answer starts with, and
 * the one way text from anywhere else is kept from posing as such a message.
 *
 * A message sent while an answer is being written reaches the model as a user
 * message that starts with {@link STEER_MARKER} (`server/services/loop/steering.js`).
 * The model is told by that marker that the person running the task speaks. A
 * tool result, an uploaded file or a report can contain the same characters;
 * {@link neutraliseSteerMarker} rewrites every occurrence in such text, so the
 * only marker the model sees is the one the server put in front of a message
 * the person sent. Who sent a message is metadata on it (`_origin`,
 * `_steerId`); the marker is rendered from that, never read back.
 *
 * Pure and dependency-free: the server and the shared prompt rendering import it.
 *
 * @module shared/steerMarker
 */

/** The prefix of a message the person sent into a running answer. */
export const STEER_MARKER = '[steer]';

/** What the marker becomes in text that is not such a message. */
export const NEUTRALISED_STEER_MARKER = '(steer)';

/**
 * The marker with any case and any blanks inside the brackets: `[steer]`,
 * `[ STEER ]`. Bounded quantifiers, so a long run of blanks costs nothing.
 */
const MARKER_PATTERN = /\[[ \t]{0,16}steer[ \t]{0,16}\]/gi;

/**
 * Whether a text contains the marker.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasSteerMarker(text) {
  if (typeof text !== 'string' || !text.includes('[')) return false;
  MARKER_PATTERN.lastIndex = 0;
  const found = MARKER_PATTERN.test(text);
  MARKER_PATTERN.lastIndex = 0;
  return found;
}

/**
 * The text with every occurrence of the marker rewritten, so it no longer
 * reads as the start of a message the person sent. Anything that is not a
 * string is returned as it is.
 *
 * @template T
 * @param {T} text
 * @returns {T}
 */
export function neutraliseSteerMarker(text) {
  if (!hasSteerMarker(text)) return text;
  return text.replace(MARKER_PATTERN, NEUTRALISED_STEER_MARKER);
}
