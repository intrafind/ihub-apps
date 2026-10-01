import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Marks a system skill: delivered with iHub and read-only for admins.
 */
function SystemSkillBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200"
      title={t(
        'admin.skills.systemTooltip',
        'Delivered with iHub. It cannot be changed or deleted.'
      )}
    >
      <Icon name="lock-closed" className="h-3 w-3" />
      {t('admin.skills.system', 'System')}
    </span>
  );
}

export default SystemSkillBadge;
