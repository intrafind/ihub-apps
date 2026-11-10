// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { quoteExcerpt } from '../utils/quote';

/**
 * The passage quoted from the workspace pane, as a block above the composer's
 * text (concept §6.1): a two-line excerpt and what it is from. "Edit with AI"
 * says plainly that the answer is a new file — Phase 1 has no in-place revision.
 *
 * @param {Object} props
 * @param {import('../utils/quote').WorkspaceQuote} props.quote
 * @param {() => void} [props.onRemove]
 */
export default function ComposerQuote({ quote, onRemove }) {
  const { t } = useTranslation();
  const name = quote.source?.name || '';
  return (
    <div
      className="mx-2 mt-2 flex items-start gap-2 rounded-md border-l-2 border-indigo-400 bg-indigo-50/60 px-2 py-1.5 dark:bg-indigo-900/20"
      data-testid="composer-quote"
      data-quote-mode={quote.mode}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-xs font-medium text-indigo-800 dark:text-indigo-200">
          <Icon name={quote.mode === 'edit' ? 'pencil' : 'sparkles'} size="xs" />
          <span className="truncate">
            {quote.mode === 'edit'
              ? t('workspace.quote.editFrom', 'Edit in {{name}}', { name })
              : t('workspace.quote.askFrom', 'About {{name}}', { name })}
          </span>
        </p>
        <p className="line-clamp-2 whitespace-pre-line text-xs text-gray-700 dark:text-gray-200">
          {quoteExcerpt(quote.text)}
        </p>
        {quote.mode === 'edit' && (
          <p className="mt-0.5 text-[0.6875rem] text-gray-600 dark:text-gray-300">
            {t(
              'workspace.quote.editNote',
              'The assistant writes a new file with the change. The original stays as it is.'
            )}
          </p>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded text-gray-600 hover:bg-white/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-800"
          aria-label={t('workspace.quote.remove', 'Remove quote')}
          title={t('workspace.quote.remove', 'Remove quote')}
        >
          <Icon name="x" size="xs" />
        </button>
      )}
    </div>
  );
}
