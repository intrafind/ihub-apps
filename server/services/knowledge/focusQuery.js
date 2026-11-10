// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The question a turn is about, for reading long text with the question in
 * mind (`focus`). Built from the user's own messages, with no model call.
 *
 * @module services/knowledge/focusQuery
 */

/** Longest focus query, in characters; longer is cut, never refused. */
export const MAX_FOCUS_CHARS = 500;

/** A message shorter than this is a follow-up that needs the one before it. */
const SHORT_MESSAGE_CHARS = 40;
const SHORT_MESSAGE_WORDS = 6;

/**
 * A focus: whitespace collapsed, cut at {@link MAX_FOCUS_CHARS}. Empty when it
 * is not a usable string, which means "no focus".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeFocus(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_FOCUS_CHARS ? text.slice(0, MAX_FOCUS_CHARS).trimEnd() : text;
}

/** The text of a user message, when it is plain text. */
function userText(message) {
  if (message?.role !== 'user' || typeof message.content !== 'string') return '';
  return normalizeFocus(message.content);
}

function isShort(text) {
  return text.length < SHORT_MESSAGE_CHARS || text.split(' ').length < SHORT_MESSAGE_WORDS;
}

/**
 * The query for a turn: the latest user message, and for a short follow-up
 * ("and in German?") the user message before it as well. Assistant text is
 * never part of it.
 *
 * @param {Array<{role: string, content: unknown}>} [messages] - The chat's
 *   messages as the user typed them (no expanded templates or file text)
 * @returns {string|null} Null when the user has said nothing to search for.
 */
export function focusQueryFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const typed = messages.map(userText).filter(Boolean);
  const latest = typed.at(-1);
  if (!latest) return null;
  const previous = typed.length > 1 ? typed.at(-2) : '';
  const query = isShort(latest) && previous ? `${latest} ${previous}` : latest;
  return normalizeFocus(query) || null;
}
