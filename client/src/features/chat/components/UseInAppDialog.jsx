// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import useApps from '../../../shared/hooks/useApps';
import { usePlatformConfig } from '../../../shared/contexts/platformConfigContextValue';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getRecentAppIds } from '../../../utils/recentApps';
import { appsAcceptingFile } from '../utils/useInApp';

const { isFavorite } = createFavoriteItemHelpers('ihub_favorite_apps');

/**
 * Sort apps the way the other app pickers do: favourites, then recently used,
 * then by name.
 *
 * @param {Array<Object>} apps
 * @param {string} language
 * @returns {Array<Object>}
 */
function sortApps(apps, language) {
  const recent = getRecentAppIds();
  const nameOf = app => getLocalizedContent(app.name, language) || app.id;
  return [...apps].sort((a, b) => {
    const favourite = Number(isFavorite(b.id)) - Number(isFavorite(a.id));
    if (favourite !== 0) return favourite;
    const ra = recent.indexOf(a.id);
    const rb = recent.indexOf(b.id);
    if ((ra === -1) !== (rb === -1)) return ra === -1 ? 1 : -1;
    if (ra !== rb) return ra - rb;
    return nameOf(a).localeCompare(nameOf(b));
  });
}

/**
 * "Use in app…": pick the app whose new chat gets a file — a generated file of
 * a chat or a project document — as an attachment.
 *
 * Only apps that can take the file are listed: chat apps the user can use
 * (personal apps included) whose uploads are on and accept the file's type,
 * judged the way the composer's attach button is (`appsAcceptingFile`). A
 * picture is listed for the apps whose chats recognize its text (#3986). The
 * dialog only picks; the caller opens the chat (`openAppWithAttachment`).
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {import('../utils/useInApp').SourceAttachment|null} props.attachment
 * @param {(app: Object) => void} props.onSelect
 * @returns {JSX.Element|null}
 */
export default function UseInAppDialog({ isOpen, onClose, attachment, onSelect }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const searchRef = useRef(null);
  const { apps, loading, error } = useApps();
  const uploads = usePlatformConfig()?.platformConfig?.uploads || null;
  const [query, setQuery] = useState('');

  const candidates = useMemo(
    () => sortApps(appsAcceptingFile(apps, attachment || {}, { uploads }), language),
    [apps, attachment, language, uploads]
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter(app => {
      const name = (getLocalizedContent(app.name, language) || app.id).toLowerCase();
      const description = (getLocalizedContent(app.description, language) || '').toLowerCase();
      return name.includes(needle) || description.includes(needle);
    });
  }, [candidates, query, language]);

  if (!attachment) return null;
  const waiting = loading && apps.length === 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={titleId}
      initialFocusRef={searchRef}
      zIndexClassName="z-[70]"
    >
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('useInApp.title', 'Use in app')}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'useInApp.subtitle',
              'A new chat of the app you pick starts with a copy of “{{name}}” attached.',
              { name: attachment.name }
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      <div className="px-6 pt-3">
        <label htmlFor={`${baseId}-search`} className="sr-only">
          {t('useInApp.search', 'Search apps')}
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <Icon name="search" size="sm" className="text-gray-500" />
          </span>
          <input
            id={`${baseId}-search`}
            ref={searchRef}
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('useInApp.search', 'Search apps')}
            aria-controls={`${baseId}-list`}
            className="block w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-500 focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-300"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
        {waiting ? (
          <p role="status" className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('useInApp.loading', 'Loading apps…')}
          </p>
        ) : error && apps.length === 0 ? (
          <p role="alert" className="py-6 text-center text-sm text-red-600 dark:text-red-400">
            {t('useInApp.loadFailed', 'The apps could not be loaded. Please try again.')}
          </p>
        ) : candidates.length === 0 ? (
          <p
            className="py-6 text-center text-sm text-gray-500 dark:text-gray-400"
            data-testid="use-in-app-none"
          >
            {t('useInApp.noApps', 'None of your apps accepts this kind of file.')}
          </p>
        ) : shown.length === 0 ? (
          <p role="status" className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('useInApp.noMatch', 'No app matches your search.')}
          </p>
        ) : (
          <ul id={`${baseId}-list`} className="grid gap-2" data-testid="use-in-app-list">
            {shown.map(app => {
              const name = getLocalizedContent(app.name, language) || app.id;
              const description = getLocalizedContent(app.description, language) || '';
              return (
                <li key={app.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(app)}
                    data-testid="use-in-app-option"
                    className="flex w-full items-center gap-3 rounded-lg border border-gray-200 p-3 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-700 dark:hover:bg-gray-700/50"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
                      style={{ backgroundColor: app.color || '#4F46E5' }}
                    >
                      <Icon name={app.icon || 'chat-bubble-left'} size="sm" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-gray-900 dark:text-gray-100">
                        {name}
                      </span>
                      {description && (
                        <span className="block truncate text-sm text-gray-500 dark:text-gray-400">
                          {description}
                        </span>
                      )}
                    </span>
                    <Icon name="chevron-right" size="sm" className="shrink-0 text-gray-500" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex justify-end border-t border-gray-200 px-6 py-3 dark:border-gray-700">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          {t('common.cancel', 'Cancel')}
        </button>
      </div>
    </Modal>
  );
}
