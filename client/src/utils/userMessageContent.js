// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Split a user message's display content into the text the user typed and the
 * markup added around it (image previews, file badges).
 *
 * The typed text must be shown verbatim (line breaks and indentation kept), the
 * markup as sanitized HTML. When the typed text cannot be located at the start
 * of the content (stored or legacy messages), nothing is split.
 *
 * @param {string} content - Display content (typed text + attachment markup)
 * @param {string} [rawContent] - The text exactly as typed
 * @returns {{ text: string, html: string } | null} null when no safe split exists
 */
export function splitUserMessageContent(content, rawContent) {
  if (typeof content !== 'string' || typeof rawContent !== 'string') return null;
  // The display content was built from the trimmed text, so match against that,
  // but show the text as typed: the first line keeps its leading indentation.
  const trimmed = rawContent.trim();
  if (!trimmed || !content.startsWith(trimmed)) return null;
  return { text: rawContent.trimEnd(), html: content.slice(trimmed.length) };
}
