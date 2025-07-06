import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useUIConfig } from './UIConfigContext';
import Fuse from 'fuse.js';
import Icon from './Icon';
import { fetchPrompts } from '../api/api';
import { createFavoriteItemHelpers } from '../utils/favoriteItems';
import { getRecentPromptIds, recordPromptUsage } from '../utils/recentPrompts';
import { getLocalizedContent } from '../utils/localizeContent';
import { highlightVariables } from '../utils/highlightVariables';

const fuseRef = { current: null };


const PromptSearch = ({ isOpen, onClose, onSelect, appId }) => {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const [prompts, setPrompts] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [favoritePromptIds, setFavoritePromptIds] = useState([]);
  const [recentPromptIds, setRecentPromptIds] = useState([]);
  const inputRef = useRef(null);

  // Create favorite prompts helpers
  const { getFavorites: getFavoritePrompts } = createFavoriteItemHelpers('aihub_favorite_prompts');

  useEffect(() => {
    if (isOpen) {
      setFavoritePromptIds(getFavoritePrompts());
      setRecentPromptIds(getRecentPromptIds());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const raw = await fetchPrompts();
        const localized = (Array.isArray(raw) ? raw : []).map(p => ({
          ...p,
          name: getLocalizedContent(p.name, i18n.language),
          prompt: getLocalizedContent(p.prompt, i18n.language),
          description: getLocalizedContent(p.description, i18n.language)
        }));
        setPrompts(localized);
        fuseRef.current = new Fuse(localized, {
          keys: ['name', 'prompt', 'description'],
          threshold: 0.4
        });
      } catch (err) {
        console.error('Failed to load prompts', err);
      }
    })();
  }, [isOpen, i18n.language]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !query.trim() || !fuseRef.current) {
      setResults([]);
      return;
    }
    const searchResults = fuseRef.current.search(query).map(r => r.item);
    const favs = new Set(favoritePromptIds);
    const recents = new Set(recentPromptIds);
    searchResults.sort((a, b) => {
      const aFav = favs.has(a.id);
      const bFav = favs.has(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      const aRecent = recents.has(a.id);
      const bRecent = recents.has(b.id);
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) {
        return recentPromptIds.indexOf(a.id) - recentPromptIds.indexOf(b.id);
      }

      const aMatch = a.appId === appId;
      const bMatch = b.appId === appId;
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });
    setResults(searchResults.slice(0, 5));
    setSelectedIndex(0);
  }, [query, isOpen, appId, favoritePromptIds, recentPromptIds]);

  const handleKeyNav = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      recordPromptUsage(results[selectedIndex].id);
      onSelect(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-xl mt-20">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Icon name="search" className="text-gray-400" />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyNav}
            placeholder={t('common.promptSearch.placeholder', 'Search prompts...')}
            className="w-full pl-12 pr-12 py-3 border rounded-lg text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
              aria-label={t('common.clear', 'Clear')}
            >
              <Icon name="x" className="w-5 h-5" />
            </button>
          )}
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {results.map((p, idx) => (
            <li
              key={p.id}
              className={`p-3 cursor-pointer border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${idx === selectedIndex ? 'bg-indigo-50 border-indigo-200' : ''}`}
              onMouseDown={() => {
                recordPromptUsage(p.id);
                onSelect(p);
              }}
            >
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0 w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
                  <Icon name={p.icon || 'clipboard'} className="w-3.5 h-3.5 text-indigo-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center flex-wrap mb-1">
                    <span className="font-medium text-gray-900 text-sm mr-1">
                      {p.name}
                    </span>
                    {favoritePromptIds.includes(p.id) && (
                      <span className="ml-1" aria-label={t('pages.promptsList.favorite')} title={t('pages.promptsList.favorite')}>
                        <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                      </span>
                    )}
                    {recentPromptIds.includes(p.id) && (
                      <span className="ml-1" aria-label={t('pages.promptsList.recent')} title={t('pages.promptsList.recent')}>
                        <Icon name="clock" size="sm" className="text-indigo-600" solid={true} />
                      </span>
                    )}
                    {p.appId && p.appId === appId && (
                      <span className="ml-1 px-1.5 py-0.5 text-xs text-indigo-600 bg-indigo-100 rounded-full">{t('common.promptSearch.appSpecific', 'app')}</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 leading-4 overflow-hidden" style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical'
                  }}>
                    {highlightVariables(p.description || p.prompt)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="text-right p-2">
          {uiConfig?.promptsList?.enabled !== false && (
            <Link
              to="/prompts"
              onClick={onClose}
              className="text-indigo-600 hover:underline"
            >
              {t('common.promptSearch.viewAll', 'View all prompts')}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default PromptSearch;
