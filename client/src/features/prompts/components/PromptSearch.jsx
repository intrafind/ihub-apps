import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchPrompts } from '../../../api';
import { fetchSkills } from '../../../api/endpoints/skills';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import SearchModal from '../../../shared/components/SearchModal';
import usePromptPreferences from '../hooks/usePromptPreferences';
import { selectPickerSkills } from '../../skills/utils/skillPicker';
import { PromptScopeBadge } from './PromptMeta';

/** Fields a query matches against. A constant: the modal rebuilds its index when this changes. */
const FUSE_KEYS = ['name', 'prompt', 'description', 'ownerName'];

/**
 * Order of the groups the list shows before anything is typed. The app's
 * global skills (`skill`) come before the caller's own skills and the skills
 * shared with them.
 */
const GROUP_ORDER = [
  'favorites',
  'recent',
  'mine',
  'shared',
  'global',
  'skill',
  'skillMine',
  'skillShared'
];

/**
 * The `/` search in an empty chat input: prompts — my own, shared with me,
 * global — and skills. Favorites and recents come first; with no query typed
 * the list is grouped, with a query it is ranked by match.
 *
 * Skills: a global skill is offered when the app lists it in `appSkills`; a
 * personal skill (own or shared) in every app unless the app turns them off
 * (`allowPersonalSkills`, from `skillSettings.allowPersonal`). See
 * `selectPickerSkills`.
 *
 * `onSelect` receives the chosen prompt (localized) or skill; filling in the
 * prompt's variables is the caller's job. It may return (a promise of)
 * whether the prompt was used: only a prompt that was — not one whose
 * variables dialog was cancelled — moves into "Recently used".
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {(item: Object) => (boolean|Promise<boolean>|void)} props.onSelect
 * @param {string} [props.appId] - The current app, to rank its prompts first.
 * @param {string[]} [props.appSkills=[]] - The app's global skills.
 * @param {boolean} [props.allowPersonalSkills=true] - Whether the app offers personal skills.
 * @param {boolean} [props.skillsEnabled=true] - Whether skills are offered at all here.
 * @param {boolean} [props.promptsEnabled=true] - Whether prompts are offered.
 */
function PromptSearch({
  isOpen,
  onClose,
  onSelect,
  appId,
  appSkills = [],
  allowPersonalSkills = true,
  skillsEnabled = true,
  promptsEnabled = true
}) {
  const { t, i18n } = useTranslation();
  const [prompts, setPrompts] = useState([]);
  const [skills, setSkills] = useState([]);
  const { favorites, recents, recordUsage } = usePromptPreferences();
  // Compared by content: a new array each render must not refetch. Skill
  // names are slugs, so '|' cannot occur in one.
  const appSkillsKey = (Array.isArray(appSkills) ? appSkills : []).join('|');

  useEffect(() => {
    if (!isOpen) return undefined;
    let active = true;
    void (async () => {
      try {
        const [rawPrompts, rawSkills] = await Promise.all([
          promptsEnabled ? fetchPrompts().catch(() => []) : Promise.resolve([]),
          // Fresh on every open: another user's share or revocation, or a
          // deleted skill, must show up without waiting for a cache to expire.
          skillsEnabled
            ? fetchSkills(undefined, { skipCache: true }).catch(() => [])
            : Promise.resolve([])
        ]);
        if (!active) return;
        setPrompts(
          (Array.isArray(rawPrompts) ? rawPrompts : []).map(p => ({
            ...p,
            _type: 'prompt',
            scope: p.scope || 'global',
            name: getLocalizedContent(p.name, i18n.language),
            prompt: getLocalizedContent(p.prompt, i18n.language),
            description: getLocalizedContent(p.description, i18n.language),
            ownerName: p.owner?.name || ''
          }))
        );
        setSkills(
          selectPickerSkills(rawSkills, {
            appSkills: appSkillsKey ? appSkillsKey.split('|') : [],
            allowPersonal: allowPersonalSkills
          })
        );
      } catch (err) {
        console.error('Failed to load prompts/skills', err);
      }
    })();
    return () => {
      active = false;
    };
  }, [isOpen, i18n.language, promptsEnabled, skillsEnabled, allowPersonalSkills, appSkillsKey]);

  const groupOf = useMemo(() => {
    const favs = new Set(favorites);
    const recentSet = new Set(recents);
    return item => {
      if (item._type === 'skill') return item.group || 'skill';
      if (favs.has(item.id)) return 'favorites';
      if (recentSet.has(item.id)) return 'recent';
      return item.scope;
    };
  }, [favorites, recents]);

  // Favorites, then recents (most recent first), then mine, shared and
  // global; within a group, prompts for this app first.
  const searchItems = useMemo(() => {
    const rank = item => GROUP_ORDER.indexOf(groupOf(item));
    return [...prompts, ...skills].sort((a, b) => {
      const byGroup = rank(a) - rank(b);
      if (byGroup !== 0) return byGroup;
      if (groupOf(a) === 'recent') return recents.indexOf(a.id) - recents.indexOf(b.id);
      const aApp = a.appId && a.appId === appId ? 0 : 1;
      const bApp = b.appId && b.appId === appId ? 0 : 1;
      return aApp - bApp;
    });
  }, [prompts, skills, groupOf, recents, appId]);

  const groupLabels = {
    favorites: t('prompts.groups.favorites', 'Favorites'),
    recent: t('prompts.groups.recent', 'Recently used'),
    mine: t('prompts.groups.mine', 'My prompts'),
    shared: t('prompts.groups.shared', 'Shared with me'),
    global: t('prompts.groups.global', 'Global prompts'),
    skill: t('prompts.groups.skills', 'Skills'),
    skillMine: t('prompts.groups.mySkills', 'My skills'),
    skillShared: t('prompts.groups.sharedSkills', 'Shared skills')
  };

  const handleSelect = async item => {
    const used = await onSelect(item);
    if (item._type !== 'skill' && used !== false) recordUsage(item.id);
  };

  if (!isOpen) return null;

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onSelect={handleSelect}
      items={searchItems}
      fuseKeys={FUSE_KEYS}
      placeholder={t('common.promptSearch.placeholder', 'Search prompts and skills...')}
      getGroupLabel={item => groupLabels[groupOf(item)]}
      maxResults={30}
      renderResult={item =>
        item._type === 'skill' ? (
          <div className="flex items-start space-x-3">
            <div className="shrink-0 w-6 h-6 bg-purple-100 rounded-lg flex items-center justify-center">
              <Icon name="sparkles" className="w-3.5 h-3.5 text-purple-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap mb-1">
                <span className="font-medium text-gray-900 dark:text-gray-100 text-sm mr-1">
                  {item.name}
                </span>
                <span className="ml-1 px-1.5 py-0.5 text-xs text-purple-600 bg-purple-100 rounded-full">
                  {t('common.promptSearch.skill', 'skill')}
                </span>
                {item.scope !== 'global' && (
                  <span className="ml-1">
                    <PromptScopeBadge prompt={item} />
                  </span>
                )}
              </div>
              <p
                className="text-xs text-gray-500 dark:text-gray-400 leading-4 overflow-hidden"
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
            <div className="shrink-0 w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
              <Icon name={item.icon || 'clipboard'} className="w-3.5 h-3.5 text-indigo-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap gap-1 mb-1">
                <span className="font-medium text-gray-900 dark:text-gray-100 text-sm mr-1">
                  {item.name}
                </span>
                {favorites.includes(item.id) && (
                  <span
                    aria-label={t('pages.promptsList.favorite')}
                    title={t('pages.promptsList.favorite')}
                  >
                    <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                  </span>
                )}
                {item.scope !== 'global' && <PromptScopeBadge prompt={item} />}
                {item.appId && item.appId === appId && (
                  <span className="px-1.5 py-0.5 text-xs text-indigo-600 bg-indigo-100 rounded-full">
                    {t('common.promptSearch.appSpecific', 'app')}
                  </span>
                )}
              </div>
              <p
                className="text-xs text-gray-500 dark:text-gray-400 leading-4 overflow-hidden"
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
}

export default PromptSearch;
