import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { fetchApps } from '../api/api';
import { getLocalizedContent } from '../utils/localizeContent';
import { getFavoriteApps } from '../utils/favoriteApps';
import { getRecentAppIds } from '../utils/recentApps';
import Fuse from 'fuse.js';

const fuseRef = { current: null };

const SmartSearch = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState([]);
  const [results, setResults] = useState([]);
  const [favoriteApps, setFavoriteApps] = useState([]);
  const inputRef = useRef(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const recentAppIds = useMemo(() => getRecentAppIds(), [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen(true);
      } else if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setFavoriteApps(getFavoriteApps());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const data = apps.length === 0 ? await fetchApps() : apps;
        if (apps.length === 0) {
          setApps(data);
        }
        const list = data.map(app => ({
          ...app,
          nameText: getLocalizedContent(app.name, currentLanguage) || '',
          descriptionText: getLocalizedContent(app.description, currentLanguage) || ''
        }));
        fuseRef.current = new Fuse(list, {
          keys: [
            { name: 'nameText', weight: 0.7 },
            { name: 'descriptionText', weight: 0.3 }
          ],
          threshold: 0.4
        });
      } catch (err) {
        console.error('Failed to initialize smart search', err);
      }
    })();
  }, [isOpen, currentLanguage, apps]);

  useEffect(() => {
    if (!isOpen || !query.trim() || !fuseRef.current) {
      setResults([]);
      return;
    }

    const searchResults = fuseRef.current.search(query).map(r => ({
      app: r.item,
      score: r.score
    }));

    const favorites = new Set(favoriteApps);
    const recents = new Set(recentAppIds);
    searchResults.sort((a, b) => {
      const aFav = favorites.has(a.app.id);
      const bFav = favorites.has(b.app.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      const aRecent = recents.has(a.app.id);
      const bRecent = recents.has(b.app.id);
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) {
        return recentAppIds.indexOf(a.app.id) - recentAppIds.indexOf(b.app.id);
      }

      const aHasOrder = a.app.order !== undefined && a.app.order !== null;
      const bHasOrder = b.app.order !== undefined && b.app.order !== null;

      if (aHasOrder && bHasOrder && a.app.order !== b.app.order) {
        return a.app.order - b.app.order;
      }
      if (aHasOrder && !bHasOrder) return -1;
      if (!aHasOrder && bHasOrder) return 1;

      return a.score - b.score;
    });

    const limited = searchResults.slice(0, 5);
    setResults(limited);
    setSelectedIndex(0);
  }, [query, isOpen, favoriteApps, recentAppIds]);

  const handleSelect = (appId) => {
    setIsOpen(false);
    setQuery('');
    navigate(`/apps/${appId}`);
  };

  const handleKeyNav = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      handleSelect(results[selectedIndex].app.id);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
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
            placeholder={t('smartSearch.placeholder', 'Search apps...')}
            className="w-full pl-12 pr-12 py-3 border rounded-lg text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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
        <ul>
          {results.map((r, idx) => (
            <li
              key={r.app.id}
              className={`px-4 py-2 cursor-pointer ${idx === selectedIndex ? 'bg-indigo-100' : ''}`}
              onMouseDown={() => handleSelect(r.app.id)}
            >
              <div className="flex items-center">
                <Icon name={r.app.icon || 'lightning-bolt'} className="w-5 h-5 mr-2" />
                <span className="font-medium mr-1 flex items-center">
                  {getLocalizedContent(r.app.name, currentLanguage) || r.app.id}
                  {favoriteApps.includes(r.app.id) && (
                    <Icon name="star" size="sm" className="text-yellow-500 ml-1" solid={true} />
                  )}
                  {recentAppIds.includes(r.app.id) && (
                    <Icon name="clock" size="sm" className="text-indigo-600 ml-1" solid={true} />
                  )}
                </span>
              </div>
              <p className="text-sm text-gray-600 ml-7 line-clamp-2">
                {getLocalizedContent(r.app.description, currentLanguage) || ''}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default SmartSearch;
