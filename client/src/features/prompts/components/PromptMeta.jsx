import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const SCOPE_STYLES = {
  global:
    'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600',
  mine: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/40 border-emerald-200 dark:border-emerald-800',
  shared:
    'text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-900/40 border-sky-200 dark:border-sky-800'
};

const SCOPE_ICONS = { global: 'globe', mine: 'user', shared: 'users' };

/**
 * Global / Mine / Shared, and for a shared prompt who it came from.
 *
 * @param {Object} props
 * @param {Object} props.prompt - A prompt as `/api/prompts` lists it.
 * @param {boolean} [props.showOwner=true] - Name the owner of a shared prompt.
 */
export function PromptScopeBadge({ prompt, showOwner = true }) {
  const { t } = useTranslation();
  const scope = prompt?.scope || 'global';
  const label =
    scope === 'mine'
      ? prompt.shared
        ? t('prompts.scope.mineShared', 'Mine · shared')
        : t('prompts.scope.mine', 'Mine')
      : scope === 'shared'
        ? t('prompts.scope.shared', 'Shared')
        : t('prompts.scope.global', 'Global');
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-full border ${SCOPE_STYLES[scope] || SCOPE_STYLES.global}`}
      title={
        scope === 'shared' && prompt.owner?.name
          ? t('prompts.scope.sharedBy', {
              defaultValue: 'Shared by {{name}}',
              name: prompt.owner.name
            })
          : undefined
      }
    >
      <Icon name={SCOPE_ICONS[scope] || 'globe'} size="sm" className="w-3 h-3" />
      {label}
      {showOwner && scope === 'shared' && prompt.owner?.name && (
        <span className="opacity-80">· {prompt.owner.name}</span>
      )}
    </span>
  );
}

/**
 * Who created a prompt and who changed it last, and when.
 *
 * @param {Object} props
 * @param {Object} props.prompt - A prompt as `/api/prompts` lists it.
 */
export function PromptAttribution({ prompt }) {
  const { t, i18n } = useTranslation();
  const format = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(i18n.language);
  };
  const created = format(prompt?.createdAt);
  const updated = format(prompt?.updatedAt);
  if (!prompt?.createdBy && !created && !updated) return null;
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400">
      {prompt.createdBy || created
        ? t('prompts.meta.created', {
            defaultValue: 'Created by {{name}} on {{date}}',
            name: prompt.createdBy || t('prompts.meta.unknown', 'unknown'),
            date: created || '—'
          })
        : null}
      {updated && updated !== created && (
        <>
          {' · '}
          {t('prompts.meta.updated', {
            defaultValue: 'last changed by {{name}} on {{date}}',
            name: prompt.updatedBy || t('prompts.meta.unknown', 'unknown'),
            date: updated
          })}
        </>
      )}
      {prompt.readOnly && (
        <>
          {' · '}
          {t('prompts.meta.readOnly', 'read-only: its owner is no longer active')}
        </>
      )}
    </p>
  );
}
