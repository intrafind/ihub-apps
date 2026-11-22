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
 * Opening and closing brackets a model reads as the square brackets of the
 * marker: ASCII, fullwidth, the CJK lenticular, tortoise-shell and white
 * brackets, the mathematical white square bracket and the small square brackets.
 */
const OPEN =
  '[\\[\\uFF3B\\u3010\\u3014\\u3016\\u3018\\u301A\\u27E6\\u2045\\uFE5D\\u298B\\u298D\\u298F]';
const CLOSE =
  '[\\]\\uFF3D\\u3011\\u3015\\u3017\\u3019\\u301B\\u27E7\\u2046\\uFE5E\\u298C\\u298E\\u2990]';
/** Blanks of any kind (line breaks, NBSP, ideographic space) and invisible format characters. */
const GAP = '[\\s\\p{Cf}]{0,16}';
/** Invisible format characters between the letters (a zero-width space, a soft hyphen). */
const JOIN = '\\p{Cf}{0,4}';
/** Each letter, also fullwidth and as its Cyrillic look-alike. */
const LETTERS = [
  '[s\\uFF53\\u0455]',
  '[t\\uFF54]',
  '[e\\uFF45\\u0435]',
  '[e\\uFF45\\u0435]',
  '[r\\uFF52]'
];

/**
 * The marker as a model reads it, not only as it is typed: `[steer]`,
 * `[ STEER ]`, a line break, a non-breaking or zero-width space inside it,
 * fullwidth or other look-alike brackets (`［steer］`, `【steer】`), fullwidth or
 * Cyrillic look-alike letters. Case-insensitive (`u` with `i` folds the
 * fullwidth and Cyrillic capitals too). Bounded quantifiers, so a long run of
 * blanks costs nothing.
 */
const MARKER_PATTERN = new RegExp(`${OPEN}${GAP}${LETTERS.join(JOIN)}${GAP}${CLOSE}`, 'giu');

/**
 * Whether a text contains the marker.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasSteerMarker(text) {
  if (typeof text !== 'string') return false;
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
