import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';

const ADMIN_PAGES = [
  { label: 'Overview', href: '/admin' },
  { label: 'Apps', href: '/admin/apps' },
  { label: 'Models', href: '/admin/models' },
  { label: 'Providers', href: '/admin/providers' },
  { label: 'Prompts', href: '/admin/prompts' },
  { label: 'Tools', href: '/admin/tools' },
  { label: 'Skills', href: '/admin/skills' },
  { label: 'Sources', href: '/admin/sources' },
  { label: 'Agents', href: '/admin/agents' },
  { label: 'Marketplace', href: '/admin/marketplace' },
  { label: 'Users', href: '/admin/users' },
  { label: 'Groups', href: '/admin/groups' },
  { label: 'Authentication', href: '/admin/auth' },
  { label: 'OAuth', href: '/admin/oauth' },
  { label: 'Integrations', href: '/admin/integrations' },
  { label: 'UI Customization', href: '/admin/ui' },
  { label: 'Pages', href: '/admin/pages' },
  { label: 'Short Links', href: '/admin/shortlinks' },
  { label: 'Usage Reports', href: '/admin/usage' },
  { label: 'Logging', href: '/admin/logging' },
  { label: 'Telemetry', href: '/admin/telemetry' },
  { label: 'Features', href: '/admin/features' },
  { label: 'Security', href: '/admin/security' },
  { label: 'Backup & Restore', href: '/admin/backup' },
  { label: 'Updates', href: '/admin/updates' },
  { label: 'Advanced', href: '/admin/advanced' },
  { label: 'Audit Log', href: '/admin/audit-log' },
  { label: 'Changelog', href: '/admin/changelog' }
];

const ACTIONS = [
  { label: 'New App', href: '/admin/apps/new' },
  { label: 'View Audit Log', href: '/admin/audit-log' },
  { label: 'Run Backup', href: '/admin/backup' },
  { label: 'Check for Updates', href: '/admin/updates' }
];

function trackRecentPage(href, label) {
  const key = 'admin_recent_pages';
  let recent = JSON.parse(localStorage.getItem(key) || '[]');
  recent = recent.filter(p => p.href !== href);
  recent.unshift({ href, label });
  recent = recent.slice(0, 5);
  localStorage.setItem(key, JSON.stringify(recent));
}

function fuzzyMatch(text, query) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText.includes(lowerQuery)) return true;
  let qi = 0;
  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) qi++;
  }
  return qi === lowerQuery.length;
}

const TYPE_ROUTES = {
  app: id => `/admin/apps/${id}`,
  prompt: id => `/admin/prompts/${id}`,
  model: id => `/admin/models/${id}`,
  group: id => `/admin/groups/${id}`,
  user: () => '/admin/users',
  source: () => '/admin/sources',
  provider: id => `/admin/providers/${id}`,
  tool: () => '/admin/tools'
};

const CATEGORY_TO_TYPE = {
  apps: 'app',
  prompts: 'prompt',
  models: 'model',
  groups: 'group',
  users: 'user',
  sources: 'source',
  providers: 'provider',
  tools: 'tool'
};

function buildSubtitle(type, entry) {
  switch (type) {
    case 'model':
      return entry.provider || null;
    case 'app':
      return entry.enabled === false ? 'disabled' : entry.category || null;
    case 'user':
      return entry.email || null;
    case 'source':
      return entry.type || null;
    case 'group':
      return entry.description || null;
    default:
      return null;
  }
}

function flattenSearchResults(data) {
  const items = [];
  for (const [category, entries] of Object.entries(data)) {
    const type = CATEGORY_TO_TYPE[category];
    if (!type || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const name = typeof entry.name === 'object' ? Object.values(entry.name)[0] : entry.name;
      const label = name || entry.username || entry.title || entry.id;
      const routeFn = TYPE_ROUTES[type];
      items.push({
        label,
        subtitle: buildSubtitle(type, entry),
        href: routeFn ? routeFn(entry.id) : '/admin',
        type
      });
    }
  }
  return items;
}

export default function AdminCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [entityResults, setEntityResults] = useState([]);
  const [entityLoading, setEntityLoading] = useState(false);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const debounceRef = useRef(null);

  const navigate = useNavigate();
  const { t } = useTranslation();

  // Open/close handlers
  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setActiveIndex(0);
    setEntityResults([]);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    setEntityResults([]);
  }, []);

  // Listen for Cmd+K / Ctrl+K and custom event
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        if (open) {
          closePalette();
        } else {
          openPalette();
        }
      }
    }

    function handleCustomEvent() {
      openPalette();
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('admin:open-palette', handleCustomEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('admin:open-palette', handleCustomEvent);
    };
  }, [open, openPalette, closePalette]);

  // Focus input when palette opens
  useEffect(() => {
    if (open && inputRef.current) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Debounced entity search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (query.length < 2) {
      setEntityResults([]);
      setEntityLoading(false);
      return;
    }

    setEntityLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const response = await makeAdminApiCall(`/admin/search?q=${encodeURIComponent(query)}`);
        const data = response.data || response;
        setEntityResults(flattenSearchResults(data));
      } catch {
        setEntityResults([]);
      } finally {
        setEntityLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  // Build sections
  const sections = useMemo(() => {
    const result = [];

    // Recent pages
    const recentRaw = JSON.parse(localStorage.getItem('admin_recent_pages') || '[]');
    const recentPages = query ? recentRaw.filter(p => fuzzyMatch(p.label, query)) : recentRaw;
    if (recentPages.length > 0) {
      result.push({
        title: t('admin.commandPalette.recent', 'Recent'),
        items: recentPages
      });
    }

    // Pages
    const filteredPages = query ? ADMIN_PAGES.filter(p => fuzzyMatch(p.label, query)) : ADMIN_PAGES;
    if (filteredPages.length > 0) {
      result.push({
        title: t('admin.commandPalette.pages', 'Pages'),
        items: filteredPages
      });
    }

    // Actions
    const filteredActions = query ? ACTIONS.filter(a => fuzzyMatch(a.label, query)) : ACTIONS;
    if (filteredActions.length > 0) {
      result.push({
        title: t('admin.commandPalette.actions', 'Actions'),
        items: filteredActions
      });
    }

    // Entities
    if (entityResults.length > 0) {
      result.push({
        title: t('admin.commandPalette.entities', 'Entities'),
        items: entityResults
      });
    }

    return result;
  }, [query, entityResults, t]);

  // Flat list of all items for keyboard navigation
  const allItems = useMemo(() => {
    return sections.flatMap(s => s.items);
  }, [sections]);

  // Reset active index when items change
  useEffect(() => {
    setActiveIndex(0);
  }, [allItems.length]);

  // Navigate to an item
  const selectItem = useCallback(
    item => {
      trackRecentPage(item.href, item.label);
      closePalette();
      navigate(item.href);
    },
    [navigate, closePalette]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(prev => (prev + 1) % Math.max(allItems.length, 1));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(prev => (prev - 1 + allItems.length) % Math.max(allItems.length, 1));
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (allItems[activeIndex]) {
          selectItem(allItems[activeIndex]);
        }
        return;
      }
    },
    [allItems, activeIndex, closePalette, selectItem]
  );

  // Scroll active item into view
  useEffect(() => {
    if (listRef.current) {
      const activeEl = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex]);

  if (!open) return null;

  let globalIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 dark:bg-black/70" onClick={closePalette} />

      {/* Palette */}
      <div
        className="relative w-full max-w-lg bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-400 dark:text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t(
              'admin.commandPalette.placeholder',
              'Search pages, actions, entities...'
            )}
            className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-2">
          {sections.length === 0 && !entityLoading && (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {query
                ? t('admin.commandPalette.noResults', 'No results found.')
                : t('admin.commandPalette.typeToSearch', 'Start typing to search...')}
            </div>
          )}

          {sections.map(section => {
            const sectionItems = section.items.map(item => {
              const idx = globalIndex++;
              return (
                <button
                  key={`${item.href}-${idx}`}
                  data-index={idx}
                  onClick={() => selectItem(item)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors ${
                    idx === activeIndex
                      ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <span className="flex-1 min-w-0">
                    <span className="truncate block">{item.label}</span>
                    {item.subtitle && (
                      <span className="block text-xs text-gray-400 dark:text-gray-500 truncate capitalize">
                        {item.subtitle}
                      </span>
                    )}
                  </span>
                  {item.type && (
                    <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">
                      {item.type}
                    </span>
                  )}
                </button>
              );
            });

            return (
              <div key={section.title}>
                <div className="px-4 pt-2 pb-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  {section.title}
                </div>
                {sectionItems}
              </div>
            );
          })}

          {entityLoading && (
            <div className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500 text-center">
              {t('admin.commandPalette.searching', 'Searching...')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-[11px] text-gray-400 dark:text-gray-500">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
              &uarr;
            </kbd>
            <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
              &darr;
            </kbd>
            {t('admin.commandPalette.navigate', 'navigate')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
              &crarr;
            </kbd>
            {t('admin.commandPalette.select', 'select')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
              esc
            </kbd>
            {t('admin.commandPalette.close', 'close')}
          </span>
        </div>
      </div>
    </div>
  );
}
