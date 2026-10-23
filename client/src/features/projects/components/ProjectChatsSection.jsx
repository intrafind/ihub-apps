// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import useApps from '../../../shared/hooks/useApps';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { fetchProjectChats } from '../../../api';
import DataTablePagination from '../../admin/components/data-table/DataTablePagination';
import { projectErrorMessage } from '../utils/projectErrors';
import { PROJECT_CHAT_FILTERS, chatPath } from '../utils/projectView';

/** Chats per page: the default, and the choices. The list is never longer than a page. */
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const DEFAULT_PAGE_SIZE = PAGE_SIZE_OPTIONS[0];

/** A date and time in the user's language. */
function formatWhen(value, language) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

/**
 * The chats inside a project (spec 1 §6.4): everyone's, or only the
 * caller's (`filter=mine`); each links into its app, read-only for the chats
 * of other members. "New chat" is in the project page's header, the main
 * action of a project.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @returns {JSX.Element}
 */
function ProjectChatsSection({ project }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { apps } = useApps();
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [state, setState] = useState({ loading: true, chats: [], total: 0, error: null });

  useEffect(() => {
    let active = true;
    setState(prev => ({ ...prev, loading: true, error: null }));
    fetchProjectChats(project.id, {
      filter,
      limit: pageSize,
      cursor: page > 1 ? String((page - 1) * pageSize) : null
    })
      .then(({ items, total }) => {
        if (!active) return;
        // The page is gone (chats were removed meanwhile): back to the first.
        if (items.length === 0 && page > 1) return setPage(1);
        setState({ loading: false, chats: items, total, error: null });
      })
      .catch(
        err =>
          active &&
          setState({ loading: false, chats: [], total: 0, error: projectErrorMessage(err, t) })
      );
    return () => {
      active = false;
    };
  }, [project.id, filter, page, pageSize, t]);

  const appName = useMemo(() => {
    const byId = new Map(apps.map(app => [app.id, app]));
    return id => getLocalizedContent(byId.get(id)?.name, language) || id || '';
  }, [apps, language]);

  const filterLabels = {
    all: t('projects.chats.filters.all', 'All chats'),
    mine: t('projects.chats.filters.mine', 'My chats')
  };

  return (
    <section
      className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5"
      aria-labelledby="project-chats-title"
    >
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2
          id="project-chats-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('projects.chats.title', 'Chats')}
        </h2>
        {/* Someone from the catalog sees only their own chats: nothing to filter. */}
        {project.permissions?.readsAllChats !== false && (
          <div
            className="flex gap-1"
            role="group"
            aria-label={t('projects.chats.filterLabel', 'Show')}
          >
            {PROJECT_CHAT_FILTERS.map(id => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => {
                  setFilter(id);
                  setPage(1);
                }}
                className={`px-2.5 py-1 text-xs rounded-md ${
                  filter === id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                {filterLabels[id]}
              </button>
            ))}
          </div>
        )}
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state.loading ? (
        <p className="text-sm text-gray-500">{t('common.loading', 'Loading…')}</p>
      ) : state.chats.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('projects.chats.empty', 'No chats in this project yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {state.chats.map(chat => (
            <li key={chat.id} className="py-2.5 flex items-center gap-3">
              <Icon name="chat-bubble-left" size="sm" className="text-gray-500 flex-none" />
              <div className="flex-1 min-w-0">
                <Link
                  to={chatPath(chat)}
                  className="block text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400 truncate"
                >
                  {chat.title || t('chatHistory.untitled', 'Untitled chat')}
                </Link>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {[
                    appName(chat.appId),
                    chat.owner?.mine
                      ? t('projects.chats.byMe', 'by you')
                      : t('projects.chats.byOther', 'by {{name}} (read-only)', {
                          name: chat.owner?.name || t('projects.chats.someone', 'another member')
                        }),
                    formatWhen(chat.lastMessageAt, language)
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.total > PAGE_SIZE_OPTIONS[0] && (
        <div className="mt-3 -mx-5 -mb-5 overflow-hidden rounded-b-xl">
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            total={state.total}
            onPageChange={setPage}
            onPageSizeChange={size => {
              setPageSize(size);
              setPage(1);
            }}
            labels={{
              showing: (start, end, total) =>
                t('projects.chats.pager.showing', 'Chats {{start}}–{{end}} of {{total}}', {
                  start,
                  end,
                  total
                }),
              rowsPerPage: t('projects.chats.pager.perPage', 'Per page'),
              first: t('projects.chats.pager.first', 'First page'),
              previous: t('projects.chats.pager.previous', 'Previous page'),
              next: t('projects.chats.pager.next', 'Next page'),
              last: t('projects.chats.pager.last', 'Last page'),
              page: number => t('projects.chats.pager.page', 'Page {{number}}', { number })
            }}
          />
        </div>
      )}
    </section>
  );
}

export default ProjectChatsSection;
