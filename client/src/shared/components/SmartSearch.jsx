import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { fetchApps } from '../../api/api';
import { getLocalizedContent } from '../../utils/localizeContent';
import { createFavoriteItemHelpers } from '../../utils/favoriteItems';
import { getRecentAppIds } from '../../utils/recentApps';
import Fuse from 'fuse.js';
import SearchModal from './SearchModal';

const SmartSearch = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [apps, setApps] = useState([]);
  const [favoriteApps, setFavoriteApps] = useState([]);
  const recentAppIds = useMemo(() => getRecentAppIds(), [isOpen]);

  // Create favorite apps helpers
  const { getFavorites: getFavoriteApps } = createFavoriteItemHelpers('aihub_favorite_apps');

  useEffect(() => {
    const handleKeyDown = e => {
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
    if (isOpen) {
      setFavoriteApps(getFavoriteApps());
      if (apps.length === 0) {
        fetchApps()
          .then(setApps)
          .catch(err => console.error('Failed to load apps', err));
      }
    }
  }, [isOpen]);

  const searchItems = apps.map(app => ({
    ...app,
    nameText: getLocalizedContent(app.name, currentLanguage) || '',
    descriptionText: getLocalizedContent(app.description, currentLanguage) || ''
  }));

  const handleSelect = app => {
    setIsOpen(false);
    navigate(`/apps/${app.id}`);
  };

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      onSelect={handleSelect}
      items={searchItems}
      fuseKeys={['nameText', 'descriptionText']}
      placeholder={t('smartSearch.placeholder', 'Search apps...')}
      renderResult={app => (
        <div className="flex items-start space-x-3">
          <div className="flex-shrink-0 w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
            <Icon name={app.icon || 'lightning-bolt'} className="w-3.5 h-3.5 text-indigo-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap mb-1">
              <span className="font-medium text-gray-900 text-sm mr-1">
                {getLocalizedContent(app.name, currentLanguage) || app.id}
              </span>
              {favoriteApps.includes(app.id) && (
                <span
                  className="ml-1"
                  aria-label={t('common.favorite', 'Favorite')}
                  title={t('common.favorite', 'Favorite')}
                >
                  <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                </span>
              )}
              {recentAppIds.includes(app.id) && (
                <span
                  className="ml-1"
                  aria-label={t('common.recent', 'Recent')}
                  title={t('common.recent', 'Recent')}
                >
                  <Icon name="clock" size="sm" className="text-indigo-600" solid={true} />
                </span>
              )}
            </div>
            <p
              className="text-xs text-gray-500 leading-4 overflow-hidden"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical'
              }}
            >
              {getLocalizedContent(app.description, currentLanguage) || ''}
            </p>
          </div>
        </div>
      )}
    />
  );
};

export default SmartSearch;
