import { useCallback, useEffect, useState } from 'react';
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
 * Shown on the app, prompt, skill, tool and workflow editors. Every row is a
 * group the current admin may change: a full admin sees every group, a
 * content admin only the groups they belong to and the groups that inherit
 * from those (issue #2365). Ticking a group grants the content to it, unticking
 * withdraws it — each click is saved on its own, since it edits `groups.json`
 * rather than the content being edited.
 *
 * A group that holds a wildcard for the type is shown ticked and locked: a
 * single item cannot be withdrawn from `["*"]` here. A group that gets the
 * content through a parent group says so beneath its name.
 *
 * @param {object} props
 * @param {'apps'|'prompts'|'skills'|'tools'|'workflows'} props.resourceType - Permission list the content lives in
 * @param {string} props.resourceId - The content's id
 * @param {boolean} [props.isNew=false] - The content has not been saved yet; nothing to grant
 * @param {string} [props.className] - Extra classes for the outer card
 */
function ContentAccessSection({ resourceType, resourceId, isNew = false, className = '' }) {
  const { t } = useTranslation();
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [pending, setPending] = useState(() => new Set());

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

  const toggle = async group => {
    if (group.wildcard || pending.has(group.id)) return;
    const change = group.granted ? { revoke: [group.id] } : { grant: [group.id] };
    setPending(prev => new Set(prev).add(group.id));
    setSaveError(null);
    try {
      setAccess(await updateContentAccess(resourceType, resourceId, change));
    } catch (err) {
      setSaveError(getAdminApiErrorMessage(err));
    } finally {
      setPending(prev => {
        const next = new Set(prev);
        next.delete(group.id);
        return next;
      });
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

    const groups = Array.isArray(access.groups) ? access.groups : [];
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
        <ul className="divide-y divide-gray-200 dark:divide-gray-700 rounded-md border border-gray-200 dark:border-gray-700">
          {groups.map(group => {
            const inputId = `content-access-${resourceType}-${group.id}`;
            const hintId = `${inputId}-hint`;
            const isPending = pending.has(group.id);
            const inheritedFrom = Array.isArray(group.inheritedFrom) ? group.inheritedFrom : [];
            const hasHint = group.wildcard || inheritedFrom.length > 0;
            return (
              <li key={group.id} className="flex items-start gap-3 px-4 py-3">
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  checked={Boolean(group.granted || group.wildcard)}
                  disabled={group.wildcard || isPending}
                  aria-describedby={hasHint ? hintId : undefined}
                  aria-label={t('admin.contentAccess.granted', '{{name}} can use {{subject}}', {
                    name: group.name,
                    subject
                  })}
                  onChange={() => toggle(group)}
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={inputId}
                    className="text-sm font-medium text-gray-900 dark:text-gray-100"
                  >
                    {group.name}
                  </label>
                  {group.name !== group.id && (
                    <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {group.id}
                    </span>
                  )}
                  {group.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">{group.description}</p>
                  )}
                  {hasHint && (
                    <p id={hintId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {group.wildcard
                        ? t(
                            'admin.contentAccess.wildcardHint',
                            'Can use all {{subjectPlural}} through a wildcard. To withdraw a single one, an administrator replaces the wildcard with an explicit list in the group settings.',
                            { subjectPlural }
                          )
                        : t(
                            'admin.contentAccess.inheritedHint',
                            'Also inherited from: {{groups}}',
                            {
                              groups: inheritedFrom.join(', ')
                            }
                          )}
                    </p>
                  )}
                </div>
                {isPending && (
                  <Icon
                    name="refresh"
                    className="mt-1 h-4 w-4 shrink-0 animate-spin text-gray-400"
                    aria-label={t('admin.contentAccess.saving', 'Saving…')}
                  />
                )}
              </li>
            );
          })}
        </ul>
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
        <div className="mt-5 md:mt-0 md:col-span-2">{renderBody()}</div>
      </div>
    </div>
  );
}

export default ContentAccessSection;
