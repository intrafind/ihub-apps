import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Fuse from 'fuse.js';
import Icon from '../../../shared/components/Icon';
import { fetchPrompts } from '../../../api/api';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getRecentPromptIds, recordPromptUsage } from '../../../utils/recentPrompts';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import SearchModal from '../../../shared/components/SearchModal';

const fuseRef = { current: null };

const PromptSearch = ({ isOpen, onClose, onSelect, appId }) => {
  const { t, i18n } = useTranslation();
  const [prompts, setPrompts] = useState([]);
  const [favoritePromptIds, setFavoritePromptIds] = useState([]);
  const [recentPromptIds, setRecentPromptIds] = useState([]);

  // Create favorite prompts helpers
  const { getFavorites: getFavoritePrompts } = createFavoriteItemHelpers('ihub_favorite_prompts');

  useEffect(() => {
    if (isOpen) {
      setFavoritePromptIds(getFavoritePrompts());
      setRecentPromptIds(getRecentPromptIds());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (isOpen) {
      setFavoritePromptIds(getFavoritePrompts());
      setRecentPromptIds(getRecentPromptIds());
      if (prompts.length === 0) {
        fetchPrompts()
          .then(raw => {
            const localized = (Array.isArray(raw) ? raw : []).map(p => ({
              ...p,
              name: getLocalizedContent(p.name, i18n.language),
              prompt: getLocalizedContent(p.prompt, i18n.language),
              description: getLocalizedContent(p.description, i18n.language)
            }));
            setPrompts(localized);
          })
          .catch(err => console.error('Failed to load prompts', err));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, i18n.language, prompts.length]);

  const searchItems = prompts;

  const handleSelect = p => {
    recordPromptUsage(p.id);
    onSelect(p);
  };

  if (!isOpen) return null;

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onSelect={handleSelect}
      items={searchItems}
      fuseKeys={['name', 'prompt', 'description']}
      placeholder={t('common.promptSearch.placeholder', 'Search prompts...')}
      renderResult={p => (
        <div className="flex items-start space-x-3">
          <div className="flex-shrink-0 w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
            <Icon name={p.icon || 'clipboard'} className="w-3.5 h-3.5 text-indigo-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap mb-1">
              <span className="font-medium text-gray-900 text-sm mr-1">{p.name}</span>
              {favoritePromptIds.includes(p.id) && (
                <span
                  className="ml-1"
                  aria-label={t('pages.promptsList.favorite')}
                  title={t('pages.promptsList.favorite')}
                >
                  <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                </span>
              )}
              {recentPromptIds.includes(p.id) && (
                <span
                  className="ml-1"
                  aria-label={t('pages.promptsList.recent')}
                  title={t('pages.promptsList.recent')}
                >
                  <Icon name="clock" size="sm" className="text-indigo-600" solid={true} />
                </span>
              )}
              {p.appId && p.appId === appId && (
                <span className="ml-1 px-1.5 py-0.5 text-xs text-indigo-600 bg-indigo-100 rounded-full">
                  {t('common.promptSearch.appSpecific', 'app')}
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
              {highlightVariables(p.description || p.prompt)}
            </p>
          </div>
        </div>
      )}
    />
  );
};

export default PromptSearch;
