// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Lines the composer grows to before it scrolls, when the host sets no cap. */
export const DEFAULT_MAX_LINES = { multiline: 12, singleline: 5 };

/**
 * The lines the chat composer shows at least and grows to at most (#3520).
 *
 * An app's `inputMode.rows` are for the empty chat, where a user often starts
 * with a long request. Once the conversation has started (`compact`), the
 * composer is one line that grows as the user types. A host cap (`maxRows`,
 * the Outlook task pane's 3) wins over the app's rows.
 *
 * @param {Object} options
 * @param {boolean} options.multiline - The app's input is multi-line.
 * @param {number} [options.rows] - The app's `inputMode.rows`.
 * @param {boolean} [options.compact=false] - The conversation has started.
 * @param {number|null} [options.maxRows] - The host's cap, if any.
 * @returns {{ minLines: number, maxLines: number }}
 */
export function composerLineLimits({ multiline, rows, compact = false, maxRows = null }) {
  const defaultMaxLines = multiline ? DEFAULT_MAX_LINES.multiline : DEFAULT_MAX_LINES.singleline;
  const maxLines = typeof maxRows === 'number' && maxRows > 0 ? maxRows : defaultMaxLines;
  const configuredLines = multiline ? Math.max(1, Number(rows) || 2) : 1;
  return { minLines: Math.min(compact ? 1 : configuredLines, maxLines), maxLines };
}
