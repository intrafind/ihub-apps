// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { DANGER_BUTTON_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { MigrationStatusPill } from './IntegrationPills';
import {
  MigrationActionButtons,
  MigrationProblemList,
  MigrationWarningList,
  formatChanges,
  formatMigrationDate
} from './MigrationParts';
import {
  MIGRATION_STATUS,
  defaultBackupOf,
  migrationActionsFor,
  migrationStatusTone
} from './migrationState';

const FRAME_CLASS = {
  red: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20',
  amber: 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20'
};
const SUBHEADING_CLASS = 'text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1';

/**
 * What the state means for the installation, in one or two sentences.
 *
 * @param {Object} instance
 * @param {Function} t
 * @returns {string}
 */
function stateExplanation(instance, t) {
  const migration = instance.migration || {};
  const from = migration.from || instance.definitionVersion || '?';
  const to = migration.to || instance.currentVersion || '?';
  const definition = instance.definitionName || instance.definition;
  switch (instance.status) {
    case MIGRATION_STATUS.PENDING:
      return migration.blocked === false
        ? t(
            'admin.integrations.migration.panel.pendingStamp',
            '{{definition}} v{{to}} is loaded; this installation records v{{from}}. No migration lies between the versions, so it keeps working: Migrate now (or the next save) records v{{to}}.',
            { definition, from, to }
          )
        : t(
            'admin.integrations.migration.panel.pending',
            '{{definition}} v{{to}} is loaded; this installation records v{{from}}. Until it is migrated it offers no actions and its settings cannot be saved.',
            { definition, from, to }
          );
    case MIGRATION_STATUS.FAILED:
      return t(
        'admin.integrations.migration.panel.failed',
        'The migration to v{{to}} failed and changed nothing: the values are still those of v{{from}}. The installation offers no actions until you re-run the migration, restore the backup or uninstall it.',
        { from, to }
      );
    case MIGRATION_STATUS.REVIEW:
      return migration.downgrade
        ? t(
            'admin.integrations.migration.panel.downgrade',
            'The loaded definition v{{to}} is older than this installation’s v{{from}} (a downgrade). Migrations only run forward, so the installation offers no actions until you restore the backup of v{{to}}, adopt v{{to}} or uninstall it.',
            { from, to }
          )
        : t(
            'admin.integrations.migration.panel.review',
            'iHub cannot tell which definition version the values of this installation were written for. It offers no actions until you restore a backup, adopt the loaded version v{{to}} or uninstall it.',
            { to }
          );
    default:
      return '';
  }
}

/**
 * What a pending migration changes, planned on the server without writing
 * (`migration.summary`, `warnings`, `collisions`, `errors`): shown before the
 * admin clicks Migrate now.
 *
 * @param {Object} props
 * @param {Object} props.instance
 * @param {(appId: string) => string} props.appName
 */
function PendingChanges({ instance, appName }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const migration = instance.migration;
  if (!migration || instance.status !== MIGRATION_STATUS.PENDING) return null;
  const migrations = migration.migrations || [];
  const changes = formatChanges(migration.summary, t, lang);
  const collisions = migration.collisions || [];
  const errors = migration.errors || [];
  let sentence = null;
  if (migrations.length > 0 && changes) {
    sentence = t(
      'admin.integrations.migration.panel.changes',
      'The migrations {{migrations}} change {{changes}}; a backup is made first.',
      { migrations: migrations.join(', '), changes }
    );
  } else if (migrations.length > 0 && migration.summary) {
    sentence = t(
      'admin.integrations.migration.panel.noChanges',
      'The migrations {{migrations}} change nothing this installation stores; a backup is made first.',
      { migrations: migrations.join(', ') }
    );
  } else if (migrations.length > 0) {
    sentence = t(
      'admin.integrations.migration.panel.notPlanned',
      'The migrations {{migrations}} run; what they change could not be planned in advance. A backup is made first.',
      { migrations: migrations.join(', ') }
    );
  }
  return (
    <div className="space-y-3" data-testid="migration-pending-changes">
      {sentence && <p className="text-sm text-gray-800 dark:text-gray-200">{sentence}</p>}
      {(migration.warnings || []).length > 0 && (
        <div>
          <h3 className={SUBHEADING_CLASS}>
            {t('admin.integrations.migration.panel.warningsTitle', 'Check after the migration')}
          </h3>
          <MigrationWarningList warnings={migration.warnings} appName={appName} />
        </div>
      )}
      {collisions.length > 0 && (
        <div className="text-red-800 dark:text-red-200" data-testid="migration-collisions">
          <h3 className={SUBHEADING_CLASS}>
            {t(
              'admin.integrations.migration.panel.collisionsTitle',
              'Collisions: the migration will fail'
            )}
          </h3>
          <p className="text-sm mb-1">
            {t(
              'admin.integrations.migration.panel.collisionsHelp',
              'A step would overwrite something that already exists. Remove the destination first (for example in the app), or the migration fails and changes nothing.'
            )}
          </p>
          <MigrationProblemList problems={collisions} testId="migration-collision-list" />
        </div>
      )}
      {errors.length > 0 && (
        <div className="text-red-800 dark:text-red-200" data-testid="migration-errors">
          <h3 className={SUBHEADING_CLASS}>
            {t(
              'admin.integrations.migration.panel.errorsTitle',
              'The result would not fit v{{to}}: the migration will fail',
              { to: migration.to || instance.currentVersion || '?' }
            )}
          </h3>
          <MigrationProblemList problems={errors} testId="migration-error-list" />
        </div>
      )}
    </div>
  );
}

/**
 * The backup Restore backup takes, or why there is none.
 *
 * @param {Object} props
 * @param {Object} props.instance
 */
function BackupLine({ instance }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  if (instance.status === MIGRATION_STATUS.PENDING) return null;
  const backup = defaultBackupOf(instance);
  return (
    <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="migration-backup">
      {backup
        ? t(
            'admin.integrations.migration.panel.backup',
            'Restore backup puts back {{backup}} (v{{version}}, taken {{date}}).',
            {
              backup: backup.id,
              version: backup.representedVersion || '?',
              date: formatMigrationDate(backup.createdAt, lang) || '?'
            }
          )
        : t(
            'admin.integrations.migration.panel.noBackup',
            'No backup of this installation matches its state, so there is nothing to restore.'
          )}
    </p>
  );
}

/**
 * The migration panel of an installation's page (versioning concept §4),
 * shown while the installation has a migration state:
 *
 * - `migrationPending`: what the pending migration changes (counts,
 *   warnings, collisions, validation problems) and **Migrate now**;
 * - `migrationFailed`: the reason, the backup and **Re-run migration**,
 *   **Restore backup**, **Uninstall**;
 * - `needsReview`: the reason, the backup (if one matches) and **Restore
 *   backup** (only with a matching backup), **Adopt current version**,
 *   **Uninstall**.
 *
 * The buttons call `onRequest(action, instance)` (`useMigrationActions`),
 * which asks first for Restore, Adopt and Uninstall.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation (`GET …/installed/:id` → `instance`)
 * @param {(action: string, instance: Object) => void} props.onRequest
 * @param {boolean} [props.busy] - an action of this installation runs
 * @param {(appId: string) => string} [props.appName] - an app's display name
 */
function InstallationMigrationPanel({ instance, onRequest, busy = false, appName = id => id }) {
  const { t } = useTranslation();
  const tone = migrationStatusTone(instance?.status);
  if (!tone) return null;
  const actions = migrationActionsFor(instance);
  return (
    <section
      className={`mb-6 rounded-lg border p-5 space-y-3 ${FRAME_CLASS[tone]}`}
      aria-labelledby="installation-migration-title"
      data-testid="migration-panel"
      data-status={instance.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="installation-migration-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.integrations.migration.panel.title', 'Definition migration')}
        </h2>
        <MigrationStatusPill status={instance.status} />
      </div>
      <p className="text-sm text-gray-800 dark:text-gray-200">{stateExplanation(instance, t)}</p>
      {instance.statusReason && (
        <p
          className="text-sm text-gray-700 dark:text-gray-300 break-words"
          data-testid="migration-reason"
        >
          {t('admin.integrations.migration.log.reason', 'Reason: {{reason}}', {
            reason: instance.statusReason
          })}
        </p>
      )}
      <PendingChanges instance={instance} appName={appName} />
      <BackupLine instance={instance} />
      <MigrationActionButtons
        actions={actions}
        instance={instance}
        onRequest={onRequest}
        busy={busy}
        buttonClassName={SECONDARY_BUTTON_CLASS}
        primaryClassName={PRIMARY_BUTTON_CLASS}
        dangerClassName={DANGER_BUTTON_CLASS}
      />
    </section>
  );
}

export default InstallationMigrationPanel;
