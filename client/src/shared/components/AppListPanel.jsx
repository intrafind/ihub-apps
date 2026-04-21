import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchApps } from '../../api/api';
import { getLocalizedContent } from '../../utils/localizeContent';
import AppCard from './AppCard';

/**
 * Compact, embeddable app list panel.
 *
 * Fetches apps via fetchApps() (uses apiClient — works with the Office auth interceptor).
 * Renders AppCard variant="compact" for each app.
 *
 * @param {Function} onSelect - Called with the selected app object
 * @param {string} [language='en'] - Locale for app name/description
 * @param {'auto'|boolean} [showSearch='auto'] - Show search when 'auto' and > 6 apps, or always/never
 * @param {React.ReactNode} [header] - Optional header node rendered above the list
 */
function AppListPanel({ onSelect, language = 'en', showSearch = 'auto', header }) {
  const { t } = useTranslation();
  const [apps, setApps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetchApps()
      .then(data => {
        if (Array.isArray(data)) setApps(data);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const shouldShowSearch = showSearch === 'auto' ? apps.length > 6 : showSearch === true;

  const filteredApps = useMemo(() => {
    if (!shouldShowSearch || !searchQuery.trim()) return apps;
    const q = searchQuery.toLowerCase();
    return apps.filter(app => {
      const name = getLocalizedContent(app.name, language) || '';
      const desc = getLocalizedContent(app.description, language) || '';
      return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    });
  }, [apps, shouldShowSearch, searchQuery, language]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      {shouldShowSearch && (
        <div className="px-4 py-2 border-b border-slate-100">
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('pages.appsList.searchPlaceholder', 'Search apps...')}
            className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
      )}
      <div className="relative flex-1 overflow-y-auto">
        <div className="p-4 grid gap-4 grid-cols-1">
          {filteredApps.map(app => (
            <AppCard
              key={app.id}
              app={app}
              variant="compact"
              onClick={onSelect}
              language={language}
            />
          ))}
          {!isLoading && filteredApps.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">
              {t('pages.appsList.noApps', 'No apps available')}
            </p>
          )}
        </div>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
              <span className="text-sm text-slate-500">
                {t('pages.appsList.loading', 'Loading…')}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AppListPanel;
