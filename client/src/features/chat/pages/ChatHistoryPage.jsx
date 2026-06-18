import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { MOCK_CHATS, CHAT_GROUPS } from '../data/mockChats';

// Grouping modes
const GROUPINGS = ['recent', 'app', 'date'];

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function ChatHistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState('date');

  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MOCK_CHATS;
    return MOCK_CHATS.filter(
      c =>
        c.title.toLowerCase().includes(q) ||
        c.appName.toLowerCase().includes(q) ||
        c.snippet.toLowerCase().includes(q)
    );
  }, [query]);

  const histGroups = useMemo(() => {
    if (grouping === 'recent') {
      return [{ key: 'all', label: '', showLabel: false, items: filteredChats }];
    }
    if (grouping === 'app') {
      const map = {};
      filteredChats.forEach(c => {
        (map[c.appName] = map[c.appName] || []).push(c);
      });
      return Object.keys(map).map(k => ({ key: k, label: k, showLabel: true, items: map[k] }));
    }
    // date grouping
    const map = {};
    filteredChats.forEach(c => {
      (map[c.group] = map[c.group] || []).push(c);
    });
    return CHAT_GROUPS.filter(g => map[g]).map(g => ({
      key: g,
      label: g,
      showLabel: true,
      items: map[g]
    }));
  }, [filteredChats, grouping]);

  const handleClearSearch = useCallback(() => setQuery(''), []);

  const groupingLabels = {
    recent: t('chatHistory.groupRecent', 'Recent'),
    app: t('chatHistory.groupByApp', 'By app'),
    date: t('chatHistory.groupByDate', 'By date')
  };

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
              {t('chatHistory.subtitle', '{{count}} conversations across your apps', {
                count: MOCK_CHATS.length
              })}
            </p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors"
          >
            <Icon name="plus" size="sm" />
            {t('sidebar.newChat', 'New chat')}
          </button>
        </div>

        {/* Search + grouping */}
        <div className="flex gap-3 mb-6 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              <Icon name="search" size="sm" />
            </span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('chatHistory.searchPlaceholder', 'Search your chats…')}
              className="w-full pl-11 pr-10 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none focus:border-indigo-400 dark:text-gray-100 dark:placeholder-gray-500"
            />
            {query && (
              <button
                onClick={handleClearSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <Icon name="x" size="sm" />
              </button>
            )}
          </div>

          {/* Segmented grouping control */}
          <div className="flex bg-gray-200 dark:bg-gray-700 rounded-xl p-1 gap-0.5">
            {GROUPINGS.map(g => (
              <button
                key={g}
                onClick={() => setGrouping(g)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  grouping === g
                    ? 'bg-white dark:bg-gray-800 text-indigo-600 dark:text-indigo-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {groupingLabels[g]}
              </button>
            ))}
          </div>
        </div>

        {/* Chat list */}
        {filteredChats.length === 0 ? (
          <div className="text-center py-16">
            <Icon
              name="chat-bubble"
              size="xl"
              className="text-gray-300 dark:text-gray-600 mx-auto mb-3"
            />
            <p className="text-gray-500 dark:text-gray-400">
              {t('chatHistory.noResults', 'No chats match your search')}
            </p>
            {query && (
              <button
                onClick={handleClearSearch}
                className="mt-3 text-indigo-600 dark:text-indigo-400 text-sm font-medium hover:underline"
              >
                {t('pages.appsList.clearFilters', 'Clear filters')}
              </button>
            )}
          </div>
        ) : (
          histGroups.map(group => (
            <div key={group.key} className="mb-2">
              {group.showLabel && (
                <div className="text-[11px] font-bold tracking-widest uppercase text-gray-400 mt-5 mb-2.5 px-1">
                  {group.label}
                </div>
              )}
              <div className="flex flex-col gap-2.5">
                {group.items.map(chat => (
                  <button
                    key={chat.id}
                    onClick={() => navigate('/')}
                    className="flex items-center gap-4 px-4 py-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-left hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md transition-all"
                  >
                    <span
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-none text-white"
                      style={{ backgroundColor: chat.appColor || '#4f46e5' }}
                    >
                      <Icon name={chat.appIcon} size="md" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 mb-0.5">
                        <span className="text-[15px] font-bold text-gray-900 dark:text-gray-100 truncate">
                          {chat.title}
                        </span>
                        <span
                          className="flex-none text-[11px] font-semibold rounded-full px-2 py-0.5"
                          style={{
                            color: chat.appColor,
                            backgroundColor: hexToRgba(chat.appColor || '#4f46e5', 0.12)
                          }}
                        >
                          {chat.appName}
                        </span>
                      </span>
                      <span className="block text-sm text-gray-500 dark:text-gray-400 truncate leading-snug">
                        {chat.snippet}
                      </span>
                    </span>
                    <span className="flex-none text-xs text-gray-400 dark:text-gray-500 font-medium whitespace-nowrap">
                      {chat.group}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
