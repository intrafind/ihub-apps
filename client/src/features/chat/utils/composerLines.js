// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Lines the composer grows to before it scrolls, when the host sets no cap. */
export const DEFAULT_MAX_LINES = { multiline: 12, singleline: 5 };

/**
 * Lines of the expanded composer (#3524). ChatInput.css holds the expanded box
 * to half the pane's height as well, which is the limit that applies in the
 * Outlook task pane; the lines only matter in a very tall one.
 */
export const EXPANDED_LINES = 20;

/**
 * The lines the chat composer shows at least and grows to at most (#3520).
 *
 * An app's `inputMode.rows` are for the empty chat, where a user often starts
 * with a long request. Once the conversation has started (`compact`), the
 * composer is one line that grows as the user types. A host cap (`maxRows`,
 * the Outlook task pane's 3) wins over the app's rows; without one, rows above
 * the default cap raise it for the empty chat.
 *
 * The user can expand a composer that offers it (`expanded`, #3524): it is then
 * a fixed, taller editing area, whatever the app's rows and the host's cap.
 *
 * @param {Object} options
 * @param {boolean} options.multiline - The app's input is multi-line.
 * @param {number} [options.rows] - The app's `inputMode.rows`.
 * @param {boolean} [options.compact=false] - The conversation has started.
 * @param {number|null} [options.maxRows] - The host's cap, if any.
 * @param {boolean} [options.expanded=false] - The user expanded the composer.
 * @returns {{ minLines: number, maxLines: number }}
 */
export function composerLineLimits({
  multiline,
  rows,
  compact = false,
  maxRows = null,
  expanded = false
}) {
  if (expanded) {
    return { minLines: EXPANDED_LINES, maxLines: EXPANDED_LINES };
  }
  const configuredLines = multiline ? Math.max(1, Number(rows) || 2) : 1;
  const startLines = compact ? 1 : configuredLines;
  if (typeof maxRows === 'number' && maxRows > 0) {
    return { minLines: Math.min(startLines, maxRows), maxLines: maxRows };
  }
  // Without a host cap, an app may ask for more rows (up to 20) than the
  // composer grows to: the empty chat shows them all.
  const defaultMaxLines = multiline ? DEFAULT_MAX_LINES.multiline : DEFAULT_MAX_LINES.singleline;
  return { minLines: startLines, maxLines: Math.max(defaultMaxLines, startLines) };
}
