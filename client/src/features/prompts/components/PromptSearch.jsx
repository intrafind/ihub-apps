import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Fuse from 'fuse.js';
import Icon from '../../../shared/components/Icon';
import { fetchPrompts } from '../../../api/api';
import { fetchSkills } from '../../../api/endpoints/skills';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getRecentPromptIds, recordPromptUsage } from '../../../utils/recentPrompts';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import SearchModal from '../../../shared/components/SearchModal';

const fuseRef = { current: null };

const PromptSearch = ({
  isOpen,
  onClose,
  onSelect,
  appId,
  appSkills = [],
  promptsEnabled = true
}) => {
  const { t, i18n } = useTranslation();
  const [prompts, setPrompts] = useState([]);
  const [skills, setSkills] = useState([]);
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
        // Fetch prompts and skills in parallel
        const [rawPrompts, rawSkills] = await Promise.all([
          promptsEnabled ? fetchPrompts().catch(() => []) : Promise.resolve([]),
          fetchSkills().catch(() => [])
        ]);
        const localized = (Array.isArray(rawPrompts) ? rawPrompts : []).map(p => ({
          ...p,
          _type: 'prompt',
          name: getLocalizedContent(p.name, i18n.language),
          prompt: getLocalizedContent(p.prompt, i18n.language),
          description: getLocalizedContent(p.description, i18n.language)
        }));
        setPrompts(localized);

        const skillItems = (Array.isArray(rawSkills) ? rawSkills : [])
          .filter(s => appSkills.length > 0 && appSkills.includes(s.name))
          .map(s => ({
            ...s,
            _type: 'skill',
            id: s.name,
            description: s.description || ''
          }));
        setSkills(skillItems);
      } catch (err) {
        console.error('Failed to load prompts/skills', err);
      }
    })();
  }, [isOpen, i18n.language]);

  useEffect(() => {
    if (isOpen) {
      setFavoritePromptIds(getFavoritePrompts());
      setRecentPromptIds(getRecentPromptIds());
      if (promptsEnabled && prompts.length === 0) {
        fetchPrompts()
          .then(raw => {
            const localized = (Array.isArray(raw) ? raw : []).map(p => ({
              ...p,
              _type: 'prompt',
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

  // Combine prompts and skills for unified search
  const searchItems = [...prompts, ...skills];

  const handleSelect = item => {
    if (item._type !== 'skill') {
      recordPromptUsage(item.id);
    }
    onSelect(item);
  };

  if (!isOpen) return null;

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onSelect={handleSelect}
      items={searchItems}
      fuseKeys={['name', 'prompt', 'description']}
      placeholder={t('common.promptSearch.placeholder', 'Search prompts and skills...')}
      renderResult={item =>
        item._type === 'skill' ? (
          <div className="flex items-start space-x-3">
            <div className="flex-shrink-0 w-6 h-6 bg-purple-100 rounded-lg flex items-center justify-center">
              <Icon name="sparkles" className="w-3.5 h-3.5 text-purple-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap mb-1">
                <span className="font-medium text-gray-900 text-sm mr-1">{item.name}</span>
                <span className="ml-1 px-1.5 py-0.5 text-xs text-purple-600 bg-purple-100 rounded-full">
                  {t('common.promptSearch.skill', 'skill')}
                </span>
              </div>
              <p
                className="text-xs text-gray-500 leading-4 overflow-hidden"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical'
                }}
              >
                {item.description}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start space-x-3">
            <div className="flex-shrink-0 w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
              <Icon name={item.icon || 'clipboard'} className="w-3.5 h-3.5 text-indigo-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap mb-1">
                <span className="font-medium text-gray-900 text-sm mr-1">{item.name}</span>
                {favoritePromptIds.includes(item.id) && (
                  <span
                    className="ml-1"
                    aria-label={t('pages.promptsList.favorite')}
                    title={t('pages.promptsList.favorite')}
                  >
                    <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                  </span>
                )}
                {recentPromptIds.includes(item.id) && (
                  <span
                    className="ml-1"
                    aria-label={t('pages.promptsList.recent')}
                    title={t('pages.promptsList.recent')}
                  >
                    <Icon name="clock" size="sm" className="text-indigo-600" solid={true} />
                  </span>
                )}
                {item.appId && item.appId === appId && (
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
                {highlightVariables(item.description || item.prompt)}
              </p>
            </div>
          </div>
        )
      }
    />
  );
};

export default PromptSearch;
