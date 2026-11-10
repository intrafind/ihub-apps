// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A quote taken from the workspace pane into the composer ("Ask about" /
 * "Edit with AI", concept §6.1), and the message it becomes. No server change:
 * the quote travels as Markdown in the text of the question, with the name and
 * id of what it is from, so the model can read the whole file with the tools it
 * already has.
 *
 * @typedef {Object} WorkspaceQuote
 * @property {'ask'|'edit'} mode
 * @property {string} text - The selected text.
 * @property {{ kind: 'artifact'|'file'|'source', id: string, name: string }} source
 *
 * @module features/workspace/utils/quote
 */

/** Longest selection taken into the composer. */
export const MAX_QUOTE_CHARS = 4000;

/**
 * The first lines of a quote, for the block above the composer.
 *
 * @param {string} text
 * @param {number} [lines]
 * @returns {string}
 */
export function quoteExcerpt(text, lines = 2) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join('\n');
}

/** The text quoted as a Markdown block quote. */
function blockQuote(text) {
  return String(text || '')
    .slice(0, MAX_QUOTE_CHARS)
    .split(/\r?\n/)
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * The message a quote and what the user typed become.
 *
 * "Edit with AI" asks for a new file: Phase 1 has no in-place revision, and the
 * wording says so to the model as the UI says it to the user.
 *
 * @param {WorkspaceQuote|null} quote
 * @param {string} typed
 * @param {(key: string, fallback: string, options?: Object) => string} t
 * @returns {string}
 */
export function composeQuotedMessage(quote, typed, t) {
  if (!quote?.text) return typed;
  const name = quote.source?.name || '';
  const ref =
    quote.source?.kind === 'artifact' &&
    quote.source.id &&
    !String(quote.source.id).startsWith('live:')
      ? t('workspace.quote.artifactRef', ' (artifact id: {{id}})', { id: quote.source.id })
      : '';
  const lead =
    quote.mode === 'edit'
      ? t(
          'workspace.quote.editLead',
          'Edit this passage of "{{name}}"{{ref}} and give me the whole document again as a new file:',
          { name, ref }
        )
      : t('workspace.quote.askLead', 'About this passage of "{{name}}"{{ref}}:', { name, ref });
  const question = String(typed || '').trim();
  return `${lead}\n\n${blockQuote(quote.text)}\n\n${question}`.trimEnd();
}
