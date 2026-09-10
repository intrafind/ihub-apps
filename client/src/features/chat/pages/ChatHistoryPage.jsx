import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useApps from '../../../shared/hooks/useApps';
import useChats, {
  invalidateChatsCache,
  patchChatInCache,
  removeChatFromCache
} from '../../../shared/hooks/useChats';
import { deleteChat, renameChat } from '../../../api';
import { CHAT_GROUPS, chatRecencyGroup } from '../../../utils/chatGroups';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { START_PAGE_PATH } from '../../../utils/homePage';
import ChatTitleEditor from '../components/ChatTitleEditor';

// Grouping modes
const GROUPINGS = ['recent', 'app', 'date'];

// What a row falls back to when the chat's app is gone from the user's list —
// revoked access, or an app an admin deleted. The chat is still readable.
const DEFAULT_APP_COLOR = '#4f46e5';
const DEFAULT_APP_ICON = 'chat-bubble';

const SKELETON_ROWS = [0, 1, 2, 3, 4];

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Placeholder rows in the shape of the real ones, so the list does not jump
 * when the chats arrive.
 *
 * @returns {JSX.Element} The loading skeleton.
 */
function ChatListSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden="true">
      {SKELETON_ROWS.map(row => (
        <div
          key={row}
          className="flex items-center gap-4 px-4 py-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse"
        >
          <span className="w-10 h-10 rounded-xl bg-gray-200 dark:bg-gray-700 flex-none" />
          <span className="flex-1 min-w-0">
            <span className="block h-3.5 w-1/2 rounded bg-gray-200 dark:bg-gray-700" />
            <span className="block mt-2 h-3 w-3/4 rounded bg-gray-100 dark:bg-gray-700/60" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Centered message for the three states with no rows to show: nothing stored
 * yet, nothing matching the search, and a list that failed to load.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.icon - Icon name.
 * @param {string} props.title - Headline.
 * @param {string} [props.description] - Supporting line.
 * @param {React.ReactNode} [props.children] - Optional action.
 * @returns {JSX.Element} The empty state.
 */
function EmptyState({ icon, title, description, children }) {
  return (
    <div className="text-center py-16">
      <Icon name={icon} size="xl" className="text-gray-300 dark:text-gray-600 mx-auto mb-3" />
      <p className="text-gray-500 dark:text-gray-400">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-gray-400 dark:text-gray-500">{description}</p>
      )}
      {children}
    </div>
  );
}

/**
 * One chat in the list.
 *
 * The link wraps only the chat itself, not the whole card: the rename and
 * delete buttons have to be siblings of it rather than nested inside, and the
 * row stays a real link so middle-click and open-in-new-tab keep working.
 *
 * @param {Object} props - Component properties.
 * @param {Object} props.chat - A chat resolved for display.
 * @param {boolean} props.editing - Whether this row's title is being renamed.
 * @param {string} props.timeLabel - Right-aligned recency label.
 * @param {() => void} props.onStartRename - Enter rename mode.
 * @param {(title: string) => void} props.onRename - Commit a new title.
 * @param {() => void} props.onCancelRename - Leave rename mode unchanged.
 * @param {() => void} props.onDelete - Ask to delete this chat.
 * @returns {JSX.Element} The chat row.
 */
function ChatRow({ chat, editing, timeLabel, onStartRename, onRename, onCancelRename, onDelete }) {
  const { t } = useTranslation();
  // Where the keyboard goes when the rename ends. The button itself is swapped
  // out for the editor, so it has to be reached through a ref that points at
  // the one remounted alongside the editor's teardown, not the detached node.
  const renameButtonRef = useRef(null);

  const tile = (
    <span
      className="w-10 h-10 rounded-xl flex items-center justify-center flex-none text-white"
      style={{ backgroundColor: chat.appColor }}
    >
      <Icon name={chat.appIcon} size="md" />
    </span>
  );

  const summary = (
    <span className="flex-1 min-w-0">
      <span className="flex items-center gap-2 mb-0.5">
        <span className="text-[15px] font-bold text-gray-900 dark:text-gray-100 truncate">
          {chat.displayTitle}
        </span>
        <span
          className="flex-none text-[11px] font-semibold rounded-full px-2 py-0.5"
          style={{
            color: chat.appColor,
            backgroundColor: hexToRgba(chat.appColor, 0.12)
          }}
        >
          {chat.appName}
        </span>
        {chat.hasUnseenActivity && (
          <span
            className="flex-none text-[11px] font-semibold rounded-full px-2 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            title={t('chatHistory.unseenHint', 'This chat answered while you were away')}
          >
            {t('chatHistory.unseen', 'New')}
          </span>
        )}
      </span>
      <span className="block text-sm text-gray-500 dark:text-gray-400 truncate leading-snug">
        {t('chatHistory.messageCount', {
          count: chat.messageCount || 0,
          defaultValue_one: '{{count}} message',
          defaultValue_other: '{{count}} messages'
        })}
      </span>
    </span>
  );

  return (
    <div className="group flex items-center gap-4 px-4 py-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md transition-all">
      {editing ? (
        <div className="flex items-center gap-4 flex-1 min-w-0">
          {tile}
          <ChatTitleEditor
            value={chat.title}
            onCommit={onRename}
            onCancel={onCancelRename}
            returnFocusRef={renameButtonRef}
            className="flex-1"
          />
        </div>
      ) : chat.to ? (
        <Link to={chat.to} className="flex items-center gap-4 flex-1 min-w-0 text-left">
          {tile}
          {summary}
        </Link>
      ) : (
        // A chat whose app was never recorded has nowhere to open.
        <div className="flex items-center gap-4 flex-1 min-w-0">
          {tile}
          {summary}
        </div>
      )}

      {!editing && (
        <>
          <span className="flex-none text-xs text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">
            {timeLabel}
          </span>
          {/* Hidden until the row is hovered or something in it takes focus,
              but always shown on touch, where there is no hover. */}
          <div className="flex-none flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
            <button
              type="button"
              ref={renameButtonRef}
              onClick={onStartRename}
              aria-label={t('chatHistory.rename', 'Rename chat')}
              title={t('chatHistory.rename', 'Rename chat')}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            >
              <Icon name="pencil" size="sm" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={t('chatHistory.delete', 'Delete chat')}
              title={t('chatHistory.delete', 'Delete chat')}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 dark:hover:text-red-400"
            >
              <Icon name="trash" size="sm" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ChatHistoryPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();

  const { chats, loading, error, hasMore, loadMore } = useChats();
  const { apps } = useApps();

  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState('date');
  const [editingId, setEditingId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [actionError, setActionError] = useState(null);
  // Success is silent for a screen reader otherwise: `actionError` is only
  // ever filled by a failure.
  const [actionStatus, setActionStatus] = useState('');
  // Deleting a row unmounts the button that was focused, in the same commit
  // the confirmation dialog is torn down, so the dialog's focus trap restores
  // focus to a detached node and the document is left focused on <body>.
  const listRef = useRef(null);
  const restoreListFocusRef = useRef(false);

  const appsById = useMemo(() => {
    const map = new Map();
    (apps || []).forEach(app => map.set(app.id, app));
    return map;
  }, [apps]);

  // `GET /api/chats` returns the stored document and nothing else: the app's
  // name, colour and icon are joined here from the apps list, and the recency
  // bucket is computed from `lastMessageAt` — one clock reading for the whole
  // list so it cannot split across a midnight boundary mid-render.
  const resolvedChats = useMemo(() => {
    const now = new Date();
    return (chats || []).filter(Boolean).map(chat => {
      const app = chat.appId ? appsById.get(chat.appId) : null;
      const title = chat.title ?? '';
      const appName =
        (app && getLocalizedContent(app.name, currentLanguage)) ||
        chat.appId ||
        t('chatHistory.unknownApp', 'Unknown app');
      return {
        ...chat,
        title,
        displayTitle: title || t('chatHistory.untitled', 'Untitled chat'),
        appName,
        appColor: app?.color || DEFAULT_APP_COLOR,
        appIcon: app?.icon || DEFAULT_APP_ICON,
        group: chatRecencyGroup(chat.lastMessageAt, now),
        to: chat.appId
          ? `/apps/${encodeURIComponent(chat.appId)}/c/${encodeURIComponent(chat.id)}`
          : null
      };
    });
  }, [chats, appsById, currentLanguage, t]);

  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return resolvedChats;
    return resolvedChats.filter(
      c => c.displayTitle.toLowerCase().includes(q) || c.appName.toLowerCase().includes(q)
    );
  }, [query, resolvedChats]);

  const groupLabel = useCallback(
    g =>
      ({
        today: t('chatHistory.group.today', 'Today'),
        yesterday: t('chatHistory.group.yesterday', 'Yesterday'),
        last7days: t('chatHistory.group.last7days', 'Last 7 days'),
        older: t('chatHistory.group.older', 'Older')
      })[g] || g,
    [t]
  );

  const histGroups = useMemo(() => {
    if (grouping === 'recent') {
      return [{ key: 'all', label: '', showLabel: false, items: filteredChats }];
    }
    if (grouping === 'app') {
      // Keyed by app id, labelled by name: two apps can share a name.
      const map = new Map();
      filteredChats.forEach(c => {
        const key = c.appId || '';
        if (!map.has(key)) map.set(key, { key, label: c.appName, showLabel: true, items: [] });
        map.get(key).items.push(c);
      });
      return Array.from(map.values());
    }
    // date grouping
    const map = {};
    filteredChats.forEach(c => {
      (map[c.group] = map[c.group] || []).push(c);
    });
    return CHAT_GROUPS.filter(g => map[g]).map(g => ({
      key: g,
      label: groupLabel(g),
      showLabel: true,
      items: map[g]
    }));
  }, [filteredChats, grouping, groupLabel]);

  const handleClearSearch = useCallback(() => setQuery(''), []);

  // Both actions answer in the shared chat cache first and reconcile on the
  // refetch. A private copy of the new title here would outlive that refetch
  // and then mask it: the server normalizes a title (whitespace collapsed,
  // length capped) and another surface can rename the same chat, and the row
  // would keep showing neither.
  const handleRename = useCallback(
    async (chat, title) => {
      setEditingId(null);
      setActionError(null);
      patchChatInCache(chat.id, { title, titleSetByUser: true });
      try {
        const result = await renameChat(chat.id, title);
        if (typeof result?.chat?.title === 'string') {
          patchChatInCache(chat.id, { title: result.chat.title });
        }
        setActionStatus(t('chatHistory.renamed', 'Chat renamed'));
        invalidateChatsCache();
      } catch {
        setActionError(
          t('chatHistory.renameFailed', 'The chat could not be renamed. Please try again.')
        );
        // Put the stored title back.
        invalidateChatsCache();
      }
    },
    [t]
  );

  const handleDelete = useCallback(
    chat => {
      setConfirmDialog({
        title: t('chatHistory.deleteTitle', 'Delete chat'),
        message: t('chatHistory.deleteMessage', {
          title: chat.displayTitle,
          defaultValue:
            'Delete “{{title}}”? The conversation and everything in it is removed for good.'
        }),
        confirmLabel: t('common.delete', 'Delete'),
        danger: true,
        onConfirm: async () => {
          setConfirmDialog(null);
          setActionError(null);
          // The row that owns the focused Delete button is about to unmount,
          // so claim the focus before the dialog's trap tries to restore it.
          restoreListFocusRef.current = true;
          removeChatFromCache(chat.id);
          setActionStatus(t('chatHistory.deleted', 'Chat deleted'));
          try {
            await deleteChat(chat.id);
            invalidateChatsCache();
          } catch {
            setActionStatus('');
            setActionError(
              t('chatHistory.deleteFailed', 'The chat could not be deleted. Please try again.')
            );
            invalidateChatsCache();
          }
        }
      });
    },
    [t]
  );

  // Runs in the same commit that removes the row, so it wins the race against
  // the focus trap's `queueMicrotask` restore onto the now-detached button.
  useLayoutEffect(() => {
    if (!restoreListFocusRef.current) return;
    restoreListFocusRef.current = false;
    listRef.current?.focus();
  });

  // The status line is an announcement, not a banner: clear it once it has
  // been read so a later, identical action announces again.
  useEffect(() => {
    if (!actionStatus) return undefined;
    const timer = setTimeout(() => setActionStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [actionStatus]);

  const groupingLabels = {
    recent: t('chatHistory.groupRecent', 'Recent'),
    app: t('chatHistory.groupByApp', 'By app'),
    date: t('chatHistory.groupByDate', 'By date')
  };

  const showSkeleton = loading && filteredChats.length === 0;
  const showLoadError = !loading && !!error && resolvedChats.length === 0;

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-6 py-10">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-[26px] font-extrabold text-gray-900 dark:text-gray-100 tracking-tight">
              {t('chatHistory.title', 'Your chats')}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {/* How many are on screen, not how many exist: the list is
                  cursor-paged and there is no cheap total, so with more still
                  to fetch the count says "30+" rather than claiming 30 is all
                  of them right above a "Show older chats" button. */}
              {hasMore
                ? t('chatHistory.subtitleMore', {
                    count: filteredChats.length,
                    defaultValue_one: '{{count}}+ conversation across your apps',
                    defaultValue_other: '{{count}}+ conversations across your apps'
                  })
                : t('chatHistory.subtitle', {
                    count: filteredChats.length,
                    defaultValue_one: '{{count}} conversation across your apps',
                    defaultValue_other: '{{count}} conversations across your apps'
                  })}
            </p>
          </div>
          <button
            onClick={() => navigate(START_PAGE_PATH)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors"
          >
            <Icon name="plus" size="sm" />
            {t('sidebar.newChat', 'New chat')}
          </button>
        </div>

        {/* Search + grouping */}
        <div className="flex gap-3 mb-6 flex-wrap">
          <div className="relative flex-1 min-w-50">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              <Icon name="search" size="sm" />
            </span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('chatHistory.searchPlaceholder', 'Search your chats…')}
              aria-label={t('chatHistory.searchPlaceholder', 'Search your chats…')}
              className="w-full pl-11 pr-10 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-hidden focus:border-indigo-400 dark:text-gray-100 dark:placeholder-gray-500"
            />
            {query && (
              <button
                onClick={handleClearSearch}
                aria-label={t('common.clearSearch', 'Clear search')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <Icon name="x" size="sm" />
              </button>
            )}
          </div>

          {/* Segmented grouping control */}
          <div
            role="group"
            aria-label={t('chatHistory.groupBy', 'Group by')}
            className="flex bg-gray-200 dark:bg-gray-700 rounded-xl p-1 gap-0.5"
          >
            {GROUPINGS.map(g => (
              <button
                key={g}
                onClick={() => setGrouping(g)}
                aria-pressed={grouping === g}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  grouping === g
                    ? 'bg-white dark:bg-gray-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {groupingLabels[g]}
              </button>
            ))}
          </div>
        </div>

        {/* Success has to be said out loud too: the row simply vanishing is
            nothing a screen reader reports. */}
        <span role="status" aria-live="polite" className="sr-only">
          {actionStatus}
        </span>

        {actionError && (
          <div
            role="alert"
            className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-800 dark:text-red-200"
          >
            <Icon name="warning" size="sm" className="mt-0.5 flex-none" />
            <span>{actionError}</span>
          </div>
        )}

        {/* Chat list */}
        {showSkeleton ? (
          <>
            <span role="status" aria-live="polite" className="sr-only">
              {t('common.loading', 'Loading…')}
            </span>
            <ChatListSkeleton />
          </>
        ) : showLoadError ? (
          <EmptyState
            icon="warning"
            title={t('chatHistory.loadFailed', 'Your chats could not be loaded')}
          >
            <button
              onClick={() => invalidateChatsCache()}
              className="mt-3 text-indigo-600 dark:text-indigo-400 text-sm font-medium hover:underline"
            >
              {t('app.retry', 'Retry')}
            </button>
          </EmptyState>
        ) : filteredChats.length === 0 ? (
          query ? (
            <EmptyState
              icon="chat-bubble"
              title={t('chatHistory.noResults', 'No chats match your search')}
            >
              <button
                onClick={handleClearSearch}
                className="mt-3 text-indigo-600 dark:text-indigo-400 text-sm font-medium hover:underline"
              >
                {t('pages.appsList.clearFilters', 'Clear filters')}
              </button>
            </EmptyState>
          ) : (
            <EmptyState
              icon="chat-bubble"
              title={t('chatHistory.empty', 'No chats yet')}
              description={t(
                'chatHistory.emptyHint',
                'Chats you start with an app are saved here so you can pick them up later.'
              )}
            >
              <button
                onClick={() => navigate(START_PAGE_PATH)}
                className="mt-3 text-indigo-600 dark:text-indigo-400 text-sm font-medium hover:underline"
              >
                {t('sidebar.newChat', 'New chat')}
              </button>
            </EmptyState>
          )
        ) : (
          // `tabIndex={-1}` so deleting a row has somewhere to put the focus
          // that the removed button was holding.
          <div ref={listRef} tabIndex={-1} className="outline-hidden">
            {histGroups.map(group => (
              <div key={group.key} className="mb-2">
                {group.showLabel && (
                  <h2 className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400 mt-5 mb-2.5 px-1">
                    {group.label}
                  </h2>
                )}
                <div className="flex flex-col gap-2.5">
                  {group.items.map(chat => (
                    <ChatRow
                      key={chat.id}
                      chat={chat}
                      editing={editingId === chat.id}
                      timeLabel={groupLabel(chat.group)}
                      onStartRename={() => setEditingId(chat.id)}
                      onRename={title => handleRename(chat, title)}
                      onCancelRename={() => setEditingId(null)}
                      onDelete={() => handleDelete(chat)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {hasMore && (
              <div className="flex justify-center mt-6">
                <button
                  onClick={loadMore}
                  disabled={loading}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600 disabled:opacity-60"
                >
                  {loading
                    ? t('common.loading', 'Loading…')
                    : t('chatHistory.loadMore', 'Show older chats')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={confirmDialog?.confirmLabel}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}
