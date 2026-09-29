import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChatHeader from '../chat/ChatHeader';
import SettingsDialog from '../settings-dialog';
import OfficeChatRow from './OfficeChatRow';
import Icon from '../../../../shared/components/Icon';
import useOfficeApps from '../../hooks/useOfficeApps';
import useOfficeChats from '../../hooks/useOfficeChats';
import { filterOfficeChats, groupOfficeChats } from '../../utilities/officeChatHistory';
import { invalidateChatsCache } from '../../../../shared/hooks/chatListStore';
import '../OfficeChatPanel.css';
import '../OfficeStartPage.css';
import './OfficeChatHistory.css';

const BUTTON_CLASS =
  'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';

/**
 * The user's stored chats in the task pane (durable chats only).
 *
 * The same list as the web app's `/chats` — chats started in the browser and
 * in the pane alike — narrowed to the apps the pane offers, grouped by
 * recency, searchable by title and app name, and paged with "Show older
 * chats". Picking one opens it in the chat panel with the email that is open
 * right now as context, so a conversation from earlier can inform the reply
 * being written.
 *
 * @param {object} props
 * @param {object|null} props.user - The signed-in user.
 * @param {() => void} props.onBack - Leave the history.
 * @param {string} props.backLabel - Label of the back button.
 * @param {(row: object) => void} props.onOpenChat - Open a chat (a row from
 *   `resolveOfficeChats`, carrying `chat` and `app`).
 * @param {() => void} props.onLogout
 */
function OfficeChatHistoryPage({ user, onBack, backLabel, onOpenChat, onLogout }) {
  const { t } = useTranslation();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { apps, loading: appsLoading, error: appsError, retry: retryApps } = useOfficeApps();
  // One row is enough to page towards: the empty state must not show while
  // older pages may still hold chats the pane can open.
  const { rows, loading, error, hasMore, loadMore } = useOfficeChats({
    user,
    enabled: true,
    apps,
    appsReady: !appsLoading && !appsError,
    minRows: 1
  });

  const groups = useMemo(() => groupOfficeChats(filterOfficeChats(rows, query)), [rows, query]);
  const groupLabels = {
    today: t('chatHistory.group.today', 'Today'),
    yesterday: t('chatHistory.group.yesterday', 'Yesterday'),
    last7days: t('chatHistory.group.last7days', 'Last 7 days'),
    older: t('chatHistory.group.older', 'Older')
  };

  const menuItems = [
    {
      key: 'settings',
      label: t('office.menu.settings', 'Settings'),
      onClick: () => setIsSettingsOpen(true)
    },
    { key: 'logout', label: t('office.menu.logout', 'Logout'), onClick: onLogout }
  ];

  // Rows need their app, so nothing is listed until the apps are in.
  const initialLoad = appsLoading || (loading && rows.length === 0);
  const searching = query.trim().length > 0;

  let status = null;
  if (initialLoad) {
    status = (
      <div
        className="office-history-status flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400"
        role="status"
      >
        <span
          className="h-4 w-4 rounded-full border-2 border-slate-300 border-t-slate-700 animate-spin dark:border-slate-600 dark:border-t-slate-300"
          aria-hidden
        />
        {t('pages.appsList.loading', 'Loading…')}
      </div>
    );
  } else if (appsError || (error && rows.length === 0)) {
    // Without the apps no chat can be listed (each row needs its app), so a
    // failed apps load must not read as an empty history.
    status = (
      <div className="office-history-status text-slate-500 dark:text-slate-400" role="alert">
        <p>{t('chatHistory.loadFailed', 'Your chats could not be loaded')}</p>
        <button
          type="button"
          onClick={appsError ? retryApps : invalidateChatsCache}
          className={`office-history-more mt-2 ${BUTTON_CLASS}`}
        >
          {t('office.history.retry', 'Try again')}
        </button>
      </div>
    );
  } else if (groups.length === 0 && searching) {
    status = (
      <div className="office-history-status text-slate-500 dark:text-slate-400" role="status">
        <p>{t('chatHistory.noResults', 'No chats match your search')}</p>
      </div>
    );
  } else if (groups.length === 0 && hasMore) {
    // The loaded chats are all in apps the pane does not offer, and the
    // automatic paging stopped short: older chats may still qualify.
    status = (
      <div className="office-history-status text-slate-500 dark:text-slate-400" role="status">
        <p>
          {t(
            'office.history.noneAvailable',
            'None of your latest chats is in an app available here.'
          )}
        </p>
      </div>
    );
  } else if (groups.length === 0) {
    status = (
      <div className="office-history-status text-slate-500 dark:text-slate-400" role="status">
        <p className="font-medium">{t('chatHistory.empty', 'No chats yet')}</p>
        <p className="mt-1">
          {t(
            'chatHistory.emptyHint',
            'Chats you start with an app are saved here so you can pick them up later.'
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="office-task-pane h-screen w-full flex flex-col p-0 bg-slate-50 dark:bg-slate-900">
      <div className="flex-1 min-h-0 flex flex-col w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden bg-white dark:bg-slate-900">
          <ChatHeader
            title={t('office.history.title', 'Chat history')}
            showCheckmark={false}
            menuItems={menuItems}
            onBackClick={onBack}
            backLabel={backLabel}
          />

          <div className="office-history flex-1 min-h-0 overflow-y-auto">
            <div className="relative">
              <Icon
                name="magnifying-glass"
                size="sm"
                className="office-history-search-icon text-slate-400 dark:text-slate-500"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('chatHistory.searchPlaceholder', 'Search your chats…')}
                aria-label={t('chatHistory.searchPlaceholder', 'Search your chats…')}
                className="office-history-search border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>

            {status}

            {!initialLoad &&
              groups.map(({ group, rows: groupRows }) => (
                <section
                  key={group}
                  className="office-history-group"
                  aria-labelledby={`office-history-${group}`}
                >
                  <h2
                    id={`office-history-${group}`}
                    className="office-start-heading text-slate-500 dark:text-slate-400"
                  >
                    {groupLabels[group]}
                  </h2>
                  <ul className="office-start-shortcuts">
                    {groupRows.map(row => (
                      <li key={row.id}>
                        <OfficeChatRow row={row} onOpen={onOpenChat} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}

            {/* A refresh or "Show older chats" that failed with rows on screen:
                the rows stay, and the failure is said rather than swallowed. */}
            {!initialLoad && !appsError && error && rows.length > 0 && (
              <p className="office-history-status text-slate-500 dark:text-slate-400" role="alert">
                {t('chatHistory.loadFailed', 'Your chats could not be loaded')}
              </p>
            )}

            {!initialLoad && !appsError && hasMore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loading}
                className={`office-history-more ${BUTTON_CLASS} disabled:opacity-60`}
              >
                {loading
                  ? t('pages.appsList.loading', 'Loading…')
                  : t('chatHistory.loadMore', 'Show older chats')}
              </button>
            )}
          </div>
        </div>
      </div>

      <SettingsDialog
        user={user}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

export default OfficeChatHistoryPage;
