// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import StreamingMarkdown from '../../../chat/components/StreamingMarkdown';
import { apiErrorMessage } from '../../../../utils/apiErrorMessage';

/** Whether a file is Markdown, which can be read rendered or as its source. */
const isMarkdown = path => /\.md$/i.test(path);

/** Code files get the code icon, everything else the document icon. */
const CODE_FILE = /\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|rb|php|go|rs|java|sql|css|html?)$/i;

/**
 * Review the files of a marketplace skill before installing it: a list of
 * every file the install would write (`SKILL.md` first) and the selected
 * file's text, fetched from the registry on demand and kept while the panel
 * is open. A Markdown file reads rendered by default; the source view shows
 * exactly what the file contains, including what rendering hides (comments,
 * link targets), which is what a review of instructions for a model needs.
 * Every other file is shown as plain text.
 *
 * @param {object} props
 * @param {string[]} props.files - The skill's files, relative to its folder
 * @param {(path: string) => Promise<string>} props.loadFile - Fetches one file's text
 */
function MarketplaceSkillFiles({ files, loadFile }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(files[0] || null);
  // path -> { status: 'loading' | 'ready' | 'error', text?, error? }
  const [entries, setEntries] = useState({});
  const [showSource, setShowSource] = useState(false);
  // Counts retries so the effect runs again for the same selected file
  const [attempt, setAttempt] = useState(0);
  const requestedRef = useRef(new Set());

  useEffect(() => {
    if (!selected || requestedRef.current.has(selected)) return;
    requestedRef.current.add(selected);
    const path = selected;
    setEntries(prev => ({ ...prev, [path]: { status: 'loading' } }));
    loadFile(path)
      .then(text => setEntries(prev => ({ ...prev, [path]: { status: 'ready', text } })))
      .catch(error =>
        setEntries(prev => ({
          ...prev,
          [path]: {
            status: 'error',
            error: apiErrorMessage(
              error,
              t,
              t('admin.marketplace.files.loadFailed', 'Could not load this file.')
            )
          }
        }))
      );
  }, [selected, attempt, loadFile, t]);

  const retry = () => {
    requestedRef.current.delete(selected);
    setAttempt(count => count + 1);
  };

  const entry = selected ? entries[selected] : null;
  const markdown = selected ? isMarkdown(selected) : false;

  return (
    <div className="space-y-4" data-testid="marketplace-skill-files">
      <nav aria-label={t('admin.marketplace.files.listLabel', 'Files of this skill')}>
        <ul className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-700">
          {files.map(path => (
            <li key={path}>
              <button
                type="button"
                onClick={() => setSelected(path)}
                aria-current={selected === path ? 'true' : undefined}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                  selected === path
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <Icon
                  name={CODE_FILE.test(path) ? 'code' : 'document-text'}
                  size="sm"
                  className="shrink-0 text-gray-500 dark:text-gray-400"
                />
                <span className="font-mono truncate">{path}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {selected && (
        <section aria-label={selected} data-testid="marketplace-skill-file-view">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="font-mono text-sm font-semibold text-gray-700 dark:text-gray-300 truncate">
              {selected}
            </h3>
            {markdown && entry?.status === 'ready' && (
              <button
                type="button"
                onClick={() => setShowSource(value => !value)}
                aria-pressed={showSource}
                className="shrink-0 text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                {showSource
                  ? t('admin.marketplace.files.showRendered', 'Show rendered')
                  : t('admin.marketplace.files.showSource', 'Show source')}
              </button>
            )}
          </div>

          {(!entry || entry.status === 'loading') && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
              <span className="sr-only">{t('common.loading', 'Loading…')}</span>
            </div>
          )}

          {entry?.status === 'error' && (
            <div role="alert" className="text-sm text-red-700 dark:text-red-300">
              <p className="break-words">{entry.error}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('admin.marketplace.files.retry', 'Try again')}
              </button>
            </div>
          )}

          {entry?.status === 'ready' &&
            (markdown && !showSource ? (
              <div className="prose dark:prose-invert max-w-none text-sm">
                <StreamingMarkdown content={entry.text} />
              </div>
            ) : (
              <pre
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
                tabIndex={0}
                className="text-xs bg-gray-50 dark:bg-gray-900 p-4 rounded-lg overflow-x-auto text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 whitespace-pre-wrap break-words"
              >
                {entry.text}
              </pre>
            ))}
        </section>
      )}
    </div>
  );
}

export default MarketplaceSkillFiles;
