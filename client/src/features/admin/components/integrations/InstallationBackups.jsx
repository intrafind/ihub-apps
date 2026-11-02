// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { SECONDARY_BUTTON_CLASS } from '../formStyles';
import { Pill } from './IntegrationPills';
import { backupKindLabel, formatMigrationDate } from './MigrationParts';
import { MIGRATION_ACTION, backupsOf, revertability } from './migrationState';

/**
 * The backups of an installation on its page (versioning phase 3, "Revert"):
 * every backup the definition migration runner kept — before a migration,
 * at each migration boundary of a multi-step update, before a restore —
 * newest first, each with the version it represents, when and why it was
 * taken, and a **Revert to this version** button. A backup of another version
 * than the loaded definition can be reverted to only when it holds that
 * version's definition folder; otherwise the button is disabled and says why.
 *
 * The button calls `onRequest(MIGRATION_ACTION.REVERT, instance, { backup })`
 * (`useMigrationActions`), which asks for confirmation first.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation (`GET …/installed/:id` → `instance`)
 * @param {(action: string, instance: Object, options: { backup: string }) => void} props.onRequest
 * @param {boolean} [props.busy] - an action of this installation runs
 * @param {string} [props.cardClassName]
 * @param {string} [props.titleClassName]
 */
function InstallationBackups({ instance, onRequest, busy = false, cardClassName, titleClassName }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const list = backupsOf(instance);
  if (list.length === 0) return null;
  const loaded = instance.currentVersion || instance.migration?.to || null;
  return (
    <section
      className={cardClassName}
      aria-labelledby="installation-backups-title"
      data-testid="installation-backups"
    >
      <h2 id="installation-backups-title" className={titleClassName}>
        {t('admin.integrations.migration.backups.title', 'Backups')}
        <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
          ({list.length})
        </span>
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
        {t(
          'admin.integrations.migration.backups.help',
          'iHub keeps a backup before every migration and at every version a multi-step update passes. Reverting puts back the definition of that version, the installation’s values and action policy, the bindings of its apps and its marketplace entry together.'
        )}
      </p>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {list.map(backup => {
          const check = revertability(instance, backup);
          const isLoaded = backup.representedVersion === loaded;
          return (
            <li
              key={backup.id}
              className="py-3 flex flex-wrap items-start gap-3"
              data-testid="installation-backup"
              data-backup={backup.id}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex flex-wrap items-center gap-2">
                  <span>v{backup.representedVersion}</span>
                  <Pill tone="gray">{backupKindLabel(backup.kind, t)}</Pill>
                  {backup.hasDefinition && (
                    <Pill tone="blue">
                      {t('admin.integrations.migration.backups.withDefinition', 'with definition')}
                    </Pill>
                  )}
                  {isLoaded && (
                    <Pill tone="green">
                      {t('admin.integrations.migration.backups.loaded', 'loaded version')}
                    </Pill>
                  )}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-400 break-all">
                  {t('admin.integrations.migration.backups.taken', 'Taken {{date}} by {{by}}', {
                    date: formatMigrationDate(backup.createdAt, lang) || '?',
                    by: backup.createdBy || '?'
                  })}
                  {' · '}
                  <span className="font-mono">{backup.id}</span>
                </p>
                {!check.ok && (
                  <p
                    className="text-xs text-amber-800 dark:text-amber-200 mt-1"
                    id={`backup-${backup.id}-why`}
                  >
                    {t(
                      'admin.integrations.migration.backups.definitionMissing',
                      'Cannot be reverted to while v{{loaded}} is loaded: this backup does not hold the definition of v{{version}}.',
                      { loaded: loaded || '?', version: backup.representedVersion }
                    )}
                  </p>
                )}
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON_CLASS}
                disabled={busy || !check.ok}
                aria-describedby={check.ok ? undefined : `backup-${backup.id}-why`}
                aria-label={t(
                  'admin.integrations.migration.backups.revertTo',
                  'Revert to v{{version}} ({{date}})',
                  {
                    version: backup.representedVersion,
                    date: formatMigrationDate(backup.createdAt, lang) || '?'
                  }
                )}
                onClick={() => onRequest(MIGRATION_ACTION.REVERT, instance, { backup: backup.id })}
                data-action={MIGRATION_ACTION.REVERT}
              >
                <Icon name="clock" size="sm" />
                {t('admin.integrations.migration.actions.revert', 'Revert to this version')}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default InstallationBackups;
