import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  fetchContentAccess,
  getAdminApiErrorMessage,
  updateContentAccess
} from '../../../api/adminApi';

/**
 * Fallback wording per content type, used when no translation is loaded.
 * `subject` reads as the object of a sentence ("… can use this app").
 */
const FALLBACK_SUBJECT = {
  apps: 'this app',
  prompts: 'this prompt',
  skills: 'this skill',
  tools: 'this tool',
  workflows: 'this workflow'
};

const FALLBACK_SUBJECT_PLURAL = {
  apps: 'apps',
  prompts: 'prompts',
  skills: 'skills',
  tools: 'tools',
  workflows: 'workflows'
};

/**
 * ContentAccessSection - which groups can use one piece of content.
 *
 * Shown on the app, prompt, skill, tool and workflow editors. Groups that
 * already have access are listed as removable chips; a search box below
 * finds the remaining groups to grant — the same search-and-add pattern used
 * elsewhere in the admin area (e.g. `ResourceSelector`, `GroupMultiSelect`).
 * This keeps the card usable when there are many groups (issue #2377): a
 * full admin sees every group, a content admin only the groups they belong
 * to and the groups that inherit from those (issue #2365). Each grant/revoke
 * is saved on its own, since it edits `groups.json` rather than the content
 * being edited.
 *
 * A group that holds a wildcard for the type is shown as a locked chip: a
 * single item cannot be withdrawn from `["*"]` here. A group that would get
 * the content through a parent group says so in the search results.
 *
 * @param {object} props
 * @param {'apps'|'prompts'|'skills'|'tools'|'workflows'} props.resourceType - Permission list the content lives in
 * @param {string} props.resourceId - The content's id
 * @param {boolean} [props.isNew=false] - The content has not been saved yet; nothing to grant
 * @param {string} [props.className] - Extra classes for the outer card
 */
function ContentAccessSection({ resourceType, resourceId, isNew = false, className = '' }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const subject = t(
    `admin.contentAccess.subject.${resourceType}`,
    FALLBACK_SUBJECT[resourceType] || resourceType
  );
  const subjectPlural = t(
    `admin.contentAccess.subjectPlural.${resourceType}`,
    FALLBACK_SUBJECT_PLURAL[resourceType] || resourceType
  );

  const canLoad = !isNew && Boolean(resourceId);

  const load = useCallback(async () => {
    if (!canLoad) return;
    setLoading(true);
    setLoadError(null);
    try {
      setAccess(await fetchContentAccess(resourceType, resourceId));
    } catch (err) {
      setLoadError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [canLoad, resourceType, resourceId]);

  useEffect(() => {
    load();
  }, [load]);

  const applyChange = async (groupId, change) => {
    setPending(prev => new Set(prev).add(groupId));
    setSaveError(null);
    try {
      setAccess(await updateContentAccess(resourceType, resourceId, change));
    } catch (err) {
      setSaveError(getAdminApiErrorMessage(err));
    } finally {
      setPending(prev => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
  };

  const grantGroup = group => {
    if (group.wildcard || group.granted || pending.has(group.id)) return;
    setSearchTerm('');
    setActiveIndex(-1);
    applyChange(group.id, { grant: [group.id] });
  };

  const revokeGroup = group => {
    if (group.wildcard || pending.has(group.id)) return;
    applyChange(group.id, { revoke: [group.id] });
  };

  const groups = useMemo(() => (Array.isArray(access?.groups) ? access.groups : []), [access]);

  // Groups already granted (directly or via wildcard) are chips; the rest
  // are the pool the search box below picks from.
  const grantedGroups = useMemo(
    () => groups.filter(group => group.granted || group.wildcard),
    [groups]
  );
  const availableGroups = useMemo(
    () => groups.filter(group => !group.granted && !group.wildcard),
    [groups]
  );
  const filteredAvailable = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return availableGroups;
    return availableGroups.filter(
      group => group.id.toLowerCase().includes(term) || group.name.toLowerCase().includes(term)
    );
  }, [availableGroups, searchTerm]);

  const handleSelectOption = group => {
    grantGroup(group);
    inputRef.current?.focus();
  };

  const handleKeyDown = e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowDropdown(true);
      setActiveIndex(prev =>
        filteredAvailable.length === 0 ? -1 : (prev + 1) % filteredAvailable.length
      );
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev =>
        filteredAvailable.length === 0
          ? -1
          : (prev - 1 + filteredAvailable.length) % filteredAvailable.length
      );
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && filteredAvailable[activeIndex]) {
        handleSelectOption(filteredAvailable[activeIndex]);
      }
      return;
    }
    if (e.key === 'Escape') {
      setShowDropdown(false);
      setActiveIndex(-1);
    }
  };

  const description =
    resourceType === 'tools'
      ? t(
          'admin.contentAccess.descriptionTools',
          "Choose which groups may call this tool directly over the MCP and A2A gateways. Changes are saved immediately. In chat, an app's own tool list decides what the model may call."
        )
      : t(
          'admin.contentAccess.description',
          'Choose which groups can use {{subject}}. Changes are saved immediately.',
          { subject }
        );

  const renderBody = () => {
    if (!canLoad) {
      return (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.contentAccess.saveFirst',
            'Save {{subject}} first. Afterwards you can choose which groups may use it.',
            { subject }
          )}
        </p>
      );
    }

    if (loading && !access) {
      return (
        <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
          <Icon name="refresh" className="h-4 w-4 mr-2 animate-spin" />
          {t('admin.contentAccess.loading', 'Loading groups…')}
        </div>
      );
    }

    if (loadError) {
      return (
        <div className="text-sm text-red-700 dark:text-red-300">
          <p>
            {t('admin.contentAccess.loadError', 'Group access could not be loaded.')} {loadError}
          </p>
          <button
            type="button"
            onClick={load}
            className="mt-2 text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
          >
            {t('admin.contentAccess.retry', 'Retry')}
          </button>
        </div>
      );
    }

    if (!access) return null;

    const membershipScope = access.scope === 'membership';

    if (groups.length === 0) {
      return (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {membershipScope
            ? t(
                'admin.contentAccess.noManageableGroups',
                'You are not a member of any group whose access you may manage. Ask an administrator to add you to the groups you should manage content for.'
              )
            : t('admin.contentAccess.noGroups', 'No groups are defined yet.')}
        </p>
      );
    }

    const listboxId = 'content-access-listbox';

    return (
      <div className="space-y-3">
        {membershipScope && (
          <p className="flex items-start text-xs text-gray-500 dark:text-gray-400">
            <Icon name="information-circle" className="h-4 w-4 mr-1.5 shrink-0" />
            <span>
              {t(
                'admin.contentAccess.scopeNote',
                'You can change access for the groups you belong to and for the groups that inherit from them.'
              )}
            </span>
          </p>
        )}

        {/* Groups that already have access, as removable chips */}
        <div className="min-h-8">
          {grantedGroups.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {grantedGroups.map(group => {
                const isPending = pending.has(group.id);
                return (
                  <span
                    key={group.id}
                    title={
                      group.wildcard
                        ? t(
                            'admin.contentAccess.wildcardHint',
                            'Can use all {{subjectPlural}} through a wildcard. To withdraw a single one, an administrator replaces the wildcard with an explicit list in the group settings.',
                            { subjectPlural }
                          )
                        : group.description || undefined
                    }
                    className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                      group.wildcard
                        ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300'
                        : 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300'
                    }`}
                  >
                    <Icon name={group.wildcard ? 'lock' : 'users'} size="xs" className="mr-1" />
                    {group.name}
                    {group.name !== group.id && (
                      <span className="ml-1 font-mono text-xs opacity-75">{group.id}</span>
                    )}
                    {isPending && (
                      <Icon
                        name="refresh"
                        size="xs"
                        className="ml-2 animate-spin"
                        aria-label={t('admin.contentAccess.saving', 'Saving…')}
                      />
                    )}
                    {!group.wildcard && !isPending && (
                      <button
                        type="button"
                        onClick={() => revokeGroup(group)}
                        className="ml-2 text-current hover:text-red-600 dark:hover:text-red-400 focus:outline-hidden"
                        aria-label={t('admin.contentAccess.revoke', 'Remove {{name}}', {
                          name: group.name
                        })}
                      >
                        <Icon name="x" size="sm" />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 italic">
              {t('admin.contentAccess.noneGranted', 'No groups can use {{subject}} yet', {
                subject
              })}
            </p>
          )}
        </div>

        {/* Search / add */}
        <div className="relative">
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={showDropdown}
              aria-controls={showDropdown ? listboxId : undefined}
              aria-activedescendant={
                showDropdown && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined
              }
              aria-autocomplete="list"
              aria-label={t('admin.contentAccess.searchLabel', 'Search groups to grant access')}
              autoComplete="off"
              value={searchTerm}
              onChange={e => {
                setSearchTerm(e.target.value);
                setShowDropdown(true);
                setActiveIndex(-1);
              }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setShowDropdown(false)}
              onKeyDown={handleKeyDown}
              placeholder={t(
                'admin.contentAccess.searchPlaceholder',
                'Search groups to grant access…'
              )}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm placeholder-gray-400 dark:placeholder-gray-500"
            />
            <Icon
              name="search"
              size="sm"
              className="absolute right-3 top-2.5 text-gray-400 dark:text-gray-500 pointer-events-none"
            />
          </div>

          {showDropdown && (
            <div
              id={listboxId}
              role="listbox"
              className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg max-h-60 rounded-md py-1 text-base ring-1 ring-black/5 dark:ring-gray-700/5 overflow-auto focus:outline-hidden sm:text-sm"
            >
              {filteredAvailable.length > 0 ? (
                filteredAvailable.map((group, index) => {
                  const active = index === activeIndex;
                  const isPending = pending.has(group.id);
                  const inheritedFrom = Array.isArray(group.inheritedFrom)
                    ? group.inheritedFrom
                    : [];
                  return (
                    <button
                      key={group.id}
                      id={`${listboxId}-opt-${index}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={isPending}
                      onMouseDown={e => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => handleSelectOption(group)}
                      className={`w-full text-left px-4 py-2 focus:outline-hidden disabled:opacity-50 ${
                        active ? 'bg-gray-100 dark:bg-gray-700' : ''
                      }`}
                    >
                      <div className="flex items-center">
                        <Icon
                          name={isPending ? 'refresh' : 'plus'}
                          size="sm"
                          className={`mr-2 shrink-0 ${
                            isPending
                              ? 'animate-spin text-gray-400 dark:text-gray-500'
                              : 'text-green-600 dark:text-green-400'
                          }`}
                        />
                        <span className="text-gray-900 dark:text-gray-100">{group.name}</span>
                        {group.name !== group.id && (
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                            {group.id}
                          </span>
                        )}
                      </div>
                      {group.description && (
                        <p className="mt-0.5 ml-6 text-xs text-gray-500 dark:text-gray-400 truncate">
                          {group.description}
                        </p>
                      )}
                      {inheritedFrom.length > 0 && (
                        <p className="mt-0.5 ml-6 text-xs text-gray-400 dark:text-gray-500">
                          {t(
                            'admin.contentAccess.inheritedHint',
                            'Also inherited from: {{groups}}',
                            { groups: inheritedFrom.join(', ') }
                          )}
                        </p>
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {searchTerm
                    ? t('admin.contentAccess.noMatches', 'No matching groups')
                    : t(
                        'admin.contentAccess.allGranted',
                        'Every group you can manage already has access'
                      )}
                </div>
              )}
            </div>
          )}
        </div>

        {saveError && (
          <p className="text-sm text-red-700 dark:text-red-300" role="alert">
            {t('admin.contentAccess.updateError', 'Access could not be updated.')} {saveError}
          </p>
        )}
      </div>
    );
  };

  return (
    <div
      className={`bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6 ${className}`.trim()}
      data-testid="content-access-section"
    >
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.contentAccess.title', 'Group access')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">{renderBody()}</div>
      </div>
    </div>
  );
}

export default ContentAccessSection;
