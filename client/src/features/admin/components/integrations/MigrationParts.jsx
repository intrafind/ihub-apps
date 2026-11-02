// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import Icon from '../../../../shared/components/Icon';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { Pill } from './IntegrationPills';
import {
  MIGRATION_ACTION,
  backupsOf,
  changeParts,
  defaultBackupOf,
  migrationLogNewestFirst,
  revertability
} from './migrationState';

/**
 * The shared pieces of the migration UI (versioning concept §4): the change
 * counts as a sentence part, warnings, collisions and validation problems,
 * the migration log, the action buttons, their confirmation dialog and the
 * outcome of an action. `InstallationMigrationPanel` (installation page),
 * `InstallationTile` (Installed tab) and the marketplace update dialog build
 * on them; the rules behind them are in `migrationState.js`.
 *
 * @module features/admin/components/integrations/MigrationParts
 */

/** Codes of the errors that mean "nothing was written, try again". */
const RETRY_CODES = new Set(['MIGRATION_LOCKED', 'MIGRATION_LOCK_LOST', 'MIGRATION_CONFLICT']);

/** The pill tone of a log entry's result. */
const RESULT_TONES = {
  migrated: 'green',
  stamped: 'blue',
  failed: 'red',
  rolledBack: 'red',
  restored: 'blue',
  adopted: 'blue',
  reverted: 'blue',
  skipped: 'gray'
};

/**
 * A date and time of the migration log in the admin's language, or the raw
 * value when it is not a date.
 *
 * @param {string|undefined} at - an ISO timestamp
 * @param {string} lang - the UI language
 * @returns {string}
 */
export function formatMigrationDate(at, lang) {
  const date = new Date(at);
  if (!at || Number.isNaN(date.getTime())) return at || '';
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * The planned or recorded changes as one sentence part, e.g. "2 install
 * values, 1 action and 1 app binding"; null when nothing changes.
 *
 * @param {{ values?: number, actions?: number, apps?: number }|null|undefined} summary
 * @param {Function} t - the translation function
 * @param {string} lang - the UI language (for the list's "and")
 * @returns {string|null}
 */
export function formatChanges(summary, t, lang) {
  const parts = changeParts(summary).map(({ kind, count }) => {
    switch (kind) {
      case 'values':
        return t('admin.integrations.migration.changes.values', '{{count}} install values', {
          count
        });
      case 'actions':
        return t('admin.integrations.migration.changes.actions', '{{count}} actions', { count });
      default:
        return t('admin.integrations.migration.changes.apps', '{{count}} app bindings', { count });
    }
  });
  if (parts.length === 0) return null;
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}

/**
 * One warning of a migration plan or log entry as a sentence: a removed
 * action an app was bound to, or a type binding that names a renamed or
 * removed action or scope (type bindings are never rewritten). Any other
 * warning shows the server's message.
 *
 * @param {{ code?: string, appId?: string, action?: string, scope?: string, key?: string, message?: string }} warning
 * @param {Function} t
 * @param {(appId: string) => string} [appName] - an app's display name
 * @returns {string}
 */
export function migrationWarningText(warning, t, appName = id => id) {
  const app = warning.appId ? appName(warning.appId) : '';
  switch (warning.code) {
    case 'ACTION_REMOVED_FROM_APP':
      return t(
        'admin.integrations.migration.warnings.actionRemoved',
        'The action “{{action}}” is removed from the app “{{app}}” (binding {{key}}); the app no longer offers it.',
        { action: warning.action, app, key: warning.key }
      );
    case 'TYPE_BINDING_NOT_REWRITTEN':
      return warning.scope
        ? t(
            'admin.integrations.migration.warnings.typeBindingScope',
            'The app “{{app}}” sets the scope “{{scope}}” in its type binding {{key}}, which is shared with other definitions and not rewritten: edit the app.',
            { scope: warning.scope, app, key: warning.key }
          )
        : t(
            'admin.integrations.migration.warnings.typeBindingAction',
            'The app “{{app}}” names the action “{{action}}” in its type binding {{key}}, which is shared with other definitions and not rewritten: edit the app.',
            { action: warning.action, app, key: warning.key }
          );
    case 'MODULE_STEP_NOT_PLANNED':
      return t(
        'admin.integrations.migration.warnings.moduleNotPlanned',
        'The migration runs the code module {{module}}; what it changes is known only when it runs and is not counted here.',
        { module: warning.key }
      );
    default:
      return warning.message || warning.code || '';
  }
}

/**
 * The warnings of a migration plan or log entry, each with a link to the app
 * it names.
 *
 * @param {Object} props
 * @param {Array<Object>} props.warnings
 * @param {(appId: string) => string} [props.appName]
 * @param {string} [props.testId]
 */
export function MigrationWarningList({ warnings, appName, testId = 'migration-warnings' }) {
  const { t } = useTranslation();
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm text-amber-900 dark:text-amber-200" data-testid={testId}>
      {warnings.map(warning => (
        <li
          key={`${warning.code}|${warning.appId}|${warning.key}|${warning.message}`}
          className="flex gap-2"
        >
          <Icon name="exclamation-triangle" size="sm" className="mt-0.5 shrink-0" />
          <span>
            {migrationWarningText(warning, t, appName)}
            {warning.appId && (
              <>
                {' '}
                <Link
                  to={`/admin/apps/${encodeURIComponent(warning.appId)}`}
                  className="underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {t('admin.integrations.migration.warnings.openApp', 'Open the app')}
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Collisions of a plan, validation errors of its result or the problems of
 * an adopt that does not fit: the server's messages, which name the keys,
 * actions and apps concerned.
 *
 * @param {Object} props
 * @param {Array<{ message: string }>} props.problems
 * @param {string} [props.testId]
 */
export function MigrationProblemList({ problems, testId = 'migration-problems' }) {
  if (!Array.isArray(problems) || problems.length === 0) return null;
  return (
    <ul className="list-disc pl-5 space-y-0.5 text-sm" data-testid={testId}>
      {problems.map(problem => (
        <li key={`${problem.key || ''}|${problem.message}`} className="break-words">
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

/** A version for the log, or "no version" when the entry has none. */
function versionText(version, t) {
  return version ? `v${version}` : t('admin.integrations.migration.log.noVersion', 'no version');
}

/**
 * The name of a log entry's result.
 *
 * @param {string} result
 * @param {Function} t
 * @returns {string}
 */
export function logResultLabel(result, t) {
  switch (result) {
    case 'migrated':
      return t('admin.integrations.migration.log.results.migrated', 'Migrated');
    case 'stamped':
      return t('admin.integrations.migration.log.results.stamped', 'Version recorded');
    case 'failed':
      return t('admin.integrations.migration.log.results.failed', 'Failed');
    case 'rolledBack':
      return t('admin.integrations.migration.log.results.rolledBack', 'Rolled back');
    case 'restored':
      return t('admin.integrations.migration.log.results.restored', 'Backup restored');
    case 'adopted':
      return t('admin.integrations.migration.log.results.adopted', 'Version adopted');
    case 'reverted':
      return t('admin.integrations.migration.log.results.reverted', 'Reverted');
    case 'skipped':
      return t('admin.integrations.migration.log.results.skipped', 'Skipped');
    default:
      return result || '';
  }
}

/** What started a run, as the log names it. */
function triggerLabel(trigger, t) {
  switch (trigger) {
    case 'manual':
      return t('admin.integrations.migration.log.triggers.manual', 'run by hand');
    case 'marketplace':
      return t('admin.integrations.migration.log.triggers.marketplace', 'marketplace update');
    case 'startup':
      return t('admin.integrations.migration.log.triggers.startup', 'server start');
    case 'recovery':
      return t('admin.integrations.migration.log.triggers.recovery', 'recovery at start');
    case 'restore':
      return t('admin.integrations.migration.log.triggers.restore', 'restore');
    case 'downgrade':
      return t('admin.integrations.migration.log.triggers.downgrade', 'downgrade');
    case 'adopt':
      return t('admin.integrations.migration.log.triggers.adopt', 'adopt');
    case 'revert':
      return t('admin.integrations.migration.log.triggers.revert', 'revert');
    default:
      return trigger || '';
  }
}

/**
 * One run of the migration log: from → to, result, when, by whom and how it
 * started; the changes, the migrations, the reason, the warnings, the backup
 * and (folded) the steps.
 *
 * @param {Object} props
 * @param {Object} props.entry - a `migrationLog` entry
 * @param {(appId: string) => string} [props.appName]
 * @param {'h3'|'h4'|'p'} [props.headingLevel='h3'] - `p` where the entry is no section
 *   of the page (the outcome message above the tabs)
 */
export function MigrationLogEntry({ entry, appName, headingLevel = 'h3' }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const Heading = headingLevel;
  const changes = formatChanges(entry.changes, t, lang);
  const steps = Array.isArray(entry.steps) ? entry.steps : [];
  const migrations = Array.isArray(entry.migrations) ? entry.migrations : [];
  return (
    <div className="space-y-1.5" data-testid="migration-log-entry">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Heading className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          <span className="font-mono">
            {t('admin.integrations.migration.log.fromTo', '{{from}} → {{to}}', {
              from: versionText(entry.from, t),
              to: versionText(entry.to, t)
            })}
          </span>
        </Heading>
        <Pill tone={RESULT_TONES[entry.result] || 'gray'}>{logResultLabel(entry.result, t)}</Pill>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {entry.at && <time dateTime={entry.at}>{formatMigrationDate(entry.at, lang)}</time>}
        {entry.by && (
          <>
            {' · '}
            {t('admin.integrations.migration.log.by', 'by {{by}}', { by: entry.by })}
          </>
        )}
        {entry.trigger && (
          <>
            {' · '}
            {triggerLabel(entry.trigger, t)}
          </>
        )}
      </p>
      {changes && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('admin.integrations.migration.log.changes', 'Changed {{changes}}.', { changes })}
        </p>
      )}
      {migrations.length > 0 && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('admin.integrations.migration.log.migrations', 'Migrations: {{list}}', {
            list: migrations.join(', ')
          })}
        </p>
      )}
      {entry.reason && (
        <p
          className={`text-sm break-words ${
            entry.result === 'failed' || entry.result === 'rolledBack'
              ? 'text-red-700 dark:text-red-400'
              : 'text-gray-700 dark:text-gray-300'
          }`}
        >
          {t('admin.integrations.migration.log.reason', 'Reason: {{reason}}', {
            reason: entry.reason
          })}
        </p>
      )}
      <MigrationWarningList
        warnings={entry.warnings}
        appName={appName}
        testId="migration-log-warnings"
      />
      {steps.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-700 dark:text-gray-300 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500">
            {t('admin.integrations.migration.log.steps', '{{count}} steps', {
              count: steps.length
            })}
          </summary>
          <ol className="mt-1 list-decimal pl-6 space-y-0.5 font-mono text-xs text-gray-700 dark:text-gray-300">
            {steps.map((step, index) => (
              // A fixed, ordered list of the run's steps: the position is the identity.
              // eslint-disable-next-line @eslint-react/no-array-index-key
              <li key={index} className="break-words">
                {step}
              </li>
            ))}
          </ol>
        </details>
      )}
      {entry.backup && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('admin.integrations.migration.log.backup', 'Backup: {{backup}}', {
            backup: entry.backup
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The migration log of an installation (the last 10 runs), newest first.
 *
 * @param {Object} props
 * @param {Array<Object>} props.log - `instance.migrationLog` (oldest first)
 * @param {(appId: string) => string} [props.appName]
 */
export function MigrationLog({ log, appName }) {
  const { t } = useTranslation();
  const entries = migrationLogNewestFirst(log);
  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('admin.integrations.migration.log.empty', 'No migration has run for this installation.')}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-gray-200 dark:divide-gray-700" data-testid="migration-log">
      {entries.map(entry => (
        <li
          key={`${entry.at}|${entry.result}|${entry.from}|${entry.to}`}
          className="py-3 first:pt-0 last:pb-0"
        >
          <MigrationLogEntry entry={entry} appName={appName} />
        </li>
      ))}
    </ol>
  );
}

/**
 * The visible name of an action button.
 *
 * @param {string} action - a `MIGRATION_ACTION` value
 * @param {Function} t
 * @returns {string}
 */
export function migrationActionLabel(action, t) {
  switch (action) {
    case MIGRATION_ACTION.MIGRATE:
      return t('admin.integrations.migration.actions.migrate', 'Migrate now');
    case MIGRATION_ACTION.RERUN:
      return t('admin.integrations.migration.actions.rerun', 'Re-run migration');
    case MIGRATION_ACTION.RESTORE:
      return t('admin.integrations.migration.actions.restore', 'Restore backup');
    case MIGRATION_ACTION.ADOPT:
      return t('admin.integrations.migration.actions.adopt', 'Adopt current version');
    case MIGRATION_ACTION.REVERT:
      return t('admin.integrations.migration.actions.revert', 'Revert to this version');
    default:
      return t('admin.integrations.migration.actions.uninstall', 'Uninstall');
  }
}

const ACTION_ICONS = {
  [MIGRATION_ACTION.MIGRATE]: 'arrow-path',
  [MIGRATION_ACTION.RERUN]: 'arrow-path',
  [MIGRATION_ACTION.RESTORE]: 'clock',
  [MIGRATION_ACTION.ADOPT]: 'check',
  [MIGRATION_ACTION.REVERT]: 'clock',
  [MIGRATION_ACTION.UNINSTALL]: 'trash'
};

/** The class of an action's button: Migrate / Re-run primary, Uninstall destructive. */
function buttonClassFor(action, { buttonClassName, primaryClassName, dangerClassName }) {
  if (action === MIGRATION_ACTION.UNINSTALL) return dangerClassName;
  if (action === MIGRATION_ACTION.MIGRATE || action === MIGRATION_ACTION.RERUN) {
    return primaryClassName;
  }
  return buttonClassName;
}

/**
 * The buttons of the actions a migration state offers (`migrationActionsFor`).
 * Each is a real button with its action as visible text; with `labelWithName`
 * its accessible name adds the installation (a list of tiles has many
 * "Migrate now" buttons).
 *
 * @param {Object} props
 * @param {string[]} props.actions - from `migrationActionsFor`
 * @param {Object} props.instance
 * @param {(action: string, instance: Object) => void} props.onRequest
 * @param {boolean} [props.busy] - an action of this installation runs
 * @param {boolean} [props.labelWithName=false]
 * @param {string} [props.buttonClassName] - the class of a non-destructive button
 * @param {string} [props.primaryClassName] - the class of Migrate now / Re-run migration
 * @param {string} [props.dangerClassName] - the class of Uninstall
 */
export function MigrationActionButtons({
  actions,
  instance,
  onRequest,
  busy = false,
  labelWithName = false,
  buttonClassName = SECONDARY_BUTTON_CLASS,
  primaryClassName = buttonClassName,
  dangerClassName = buttonClassName
}) {
  const { t } = useTranslation();
  if (!actions || actions.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-2"
      data-testid="migration-actions"
      aria-busy={busy || undefined}
    >
      {actions.map(action => {
        const label = migrationActionLabel(action, t);
        return (
          <button
            key={action}
            type="button"
            className={buttonClassFor(action, {
              buttonClassName,
              primaryClassName,
              dangerClassName
            })}
            onClick={() => onRequest(action, instance)}
            disabled={busy}
            aria-label={
              labelWithName
                ? t(
                    'admin.integrations.migration.actions.forInstallation',
                    '{{action}}: {{label}}',
                    {
                      action: label,
                      label: instance.label || instance.id
                    }
                  )
                : undefined
            }
            data-action={action}
          >
            <Icon name={ACTION_ICONS[action]} size="sm" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** A backup as the picker lists it: version, kind and date. */
function backupOptionText(backup, t, lang) {
  return t('admin.integrations.migration.backups.option', 'v{{version}} · {{kind}} · {{date}}', {
    version: backup.representedVersion || '?',
    kind: backupKindLabel(backup.kind, t),
    date: formatMigrationDate(backup.createdAt, lang) || '?'
  });
}

/**
 * The name of a backup's kind.
 *
 * @param {string|undefined} kind - `pre-migration`, `boundary`, `pre-restore`
 * @param {Function} t
 * @returns {string}
 */
export function backupKindLabel(kind, t) {
  switch (kind) {
    case 'boundary':
      return t('admin.integrations.migration.backups.kinds.boundary', 'between two migrations');
    case 'pre-restore':
      return t('admin.integrations.migration.backups.kinds.preRestore', 'before a restore');
    default:
      return t('admin.integrations.migration.backups.kinds.preMigration', 'before a migration');
  }
}

/**
 * The backup picker of the Restore and Revert confirmation.
 *
 * @param {Object} props
 * @param {Object} props.instance
 * @param {string|null} props.value - the backup picked
 * @param {(id: string) => void} props.onChange
 * @param {(backup: Object) => boolean} [props.filter] - which backups to offer (Revert: only those it can go back to)
 */
function BackupPicker({ instance, value, onChange, filter = () => true }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const list = backupsOf(instance).filter(filter);
  if (list.length < 2 || !onChange) return null;
  return (
    <div className="mt-3">
      <label
        htmlFor="migration-backup-picker"
        className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
      >
        {t('admin.integrations.migration.backups.pick', 'Backup')}
      </label>
      <select
        id="migration-backup-picker"
        data-testid="migration-backup-picker"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
      >
        {list.map(backup => (
          <option key={backup.id} value={backup.id}>
            {backupOptionText(backup, t, lang)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The confirmation of Restore backup, Revert and Adopt current version
 * (Uninstall uses the page's own remove dialog): what is replaced, and from
 * where. Restore and Revert offer a picker of the installation's backups
 * when there is more than one.
 *
 * @param {Object} props
 * @param {{ action: string, instance: Object, backup?: string|null }|null} props.pending
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @param {(id: string) => void} [props.onSelectBackup] - the picker changed the backup
 */
export function MigrationConfirmDialog({ pending, onConfirm, onCancel, onSelectBackup }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const instance = pending?.instance;
  const label = instance?.label || instance?.id || '';
  const picked =
    backupsOf(instance).find(backup => backup.id === pending?.backup) ||
    (pending?.backup ? { id: pending.backup } : null);
  let title = '';
  let message = null;
  let confirmLabel = '';
  if (pending?.action === MIGRATION_ACTION.REVERT) {
    const backup = picked || {};
    title = t(
      'admin.integrations.migration.confirm.revert.title',
      'Revert {{label}} to v{{version}}?',
      { label, version: backup.representedVersion || '?' }
    );
    confirmLabel = t('admin.integrations.migration.actions.revert', 'Revert to this version');
    message = (
      <>
        <p>
          {t(
            'admin.integrations.migration.confirm.revert.message',
            'The installation’s values, its action policy, the bindings of its apps and its marketplace entry go back to the backup {{backup}} (v{{version}}, taken {{date}}). What changed since then is replaced; iHub backs up the current state first, so you can revert forward again.',
            {
              backup: backup.id,
              version: backup.representedVersion || '?',
              date: formatMigrationDate(backup.createdAt, lang) || '?'
            }
          )}
        </p>
        {backup.hasDefinition && (
          <p className="mt-2">
            {t(
              'admin.integrations.migration.confirm.revert.definition',
              'The definition goes back to v{{version}} too. Other installations of the same definition follow it: each gets its own backup of v{{version}} restored, or needs a review.',
              { version: backup.representedVersion || '?' }
            )}
          </p>
        )}
        <BackupPicker
          instance={instance}
          value={pending?.backup}
          onChange={onSelectBackup}
          filter={candidate => revertability(instance, candidate).ok}
        />
      </>
    );
  } else if (pending?.action === MIGRATION_ACTION.RESTORE) {
    const backup = picked || defaultBackupOf(instance) || {};
    title = t(
      'admin.integrations.migration.confirm.restore.title',
      'Restore a backup of {{label}}?',
      {
        label
      }
    );
    confirmLabel = t('admin.integrations.migration.actions.restore', 'Restore backup');
    message = (
      <>
        <p>
          {t(
            'admin.integrations.migration.confirm.restore.message',
            'The installation’s values, its action policy and the bindings of its apps go back to the backup {{backup}} (v{{version}}, taken {{date}}). What changed since then is replaced; iHub backs up the current state first.',
            {
              backup: backup.id,
              version: backup.representedVersion || '?',
              date: formatMigrationDate(backup.createdAt, lang) || '?'
            }
          )}
        </p>
        {backup.hasDefinition && (
          <p className="mt-2">
            {t(
              'admin.integrations.migration.confirm.restore.definition',
              'The backup also holds the definition of v{{version}}; when the loaded definition is another version, it is put back too.',
              { version: backup.representedVersion || '?' }
            )}
          </p>
        )}
        <BackupPicker instance={instance} value={pending?.backup} onChange={onSelectBackup} />
      </>
    );
  } else if (pending?.action === MIGRATION_ACTION.ADOPT) {
    const version = instance?.currentVersion || instance?.migration?.to || '?';
    title = t(
      'admin.integrations.migration.confirm.adopt.title',
      'Adopt v{{version}} for {{label}}?',
      {
        version,
        label
      }
    );
    confirmLabel = t('admin.integrations.migration.confirm.adopt.confirm', 'Adopt version');
    message = (
      <p>
        {t(
          'admin.integrations.migration.confirm.adopt.message',
          'You confirm that the stored values already fit {{definition}} v{{version}}. iHub checks them like the result of a migration and only then records the version; no value is changed. Values that do not fit are listed and nothing is recorded.',
          { definition: instance?.definitionName || instance?.definition || '', version }
        )}
      </p>
    );
  }
  return (
    <ConfirmDialog
      isOpen={Boolean(pending)}
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      denyLabel={t('common.cancel', 'Cancel')}
      danger
      onConfirm={onConfirm}
      onDeny={onCancel}
    />
  );
}

/**
 * The sentence of a successful action's outcome.
 *
 * @param {Object} outcome - from `outcomeFromResponse`
 * @param {Function} t
 * @returns {string}
 */
function successText(outcome, t) {
  const entry = outcome.logEntry || {};
  const to = entry.to || outcome.instance?.definitionVersion || '?';
  switch (outcome.result) {
    case 'migrated':
      return t(
        'admin.integrations.migration.outcome.migrated',
        '{{label}} was migrated from v{{from}} to v{{to}}.',
        { label: outcome.label, from: entry.from || '?', to }
      );
    case 'stamped':
      return t(
        'admin.integrations.migration.outcome.stamped',
        '{{label}} now records v{{to}}; no migration had to run.',
        { label: outcome.label, to }
      );
    case 'current':
      return t(
        'admin.integrations.migration.outcome.current',
        '{{label}} is already at v{{to}}; nothing had to run.',
        { label: outcome.label, to }
      );
    case 'restored':
      return t(
        'admin.integrations.migration.outcome.restored',
        'The backup {{backup}} of {{label}} was restored; it is at v{{to}} again.',
        { label: outcome.label, backup: outcome.backup?.id || entry.backup || '', to }
      );
    case 'adopted':
      return t('admin.integrations.migration.outcome.adopted', '{{label}} now records v{{to}}.', {
        label: outcome.label,
        to
      });
    case 'reverted':
      return t(
        'admin.integrations.migration.outcome.reverted',
        '{{label}} was reverted to the backup {{backup}}; it is at v{{to}} now.',
        { label: outcome.label, backup: outcome.backup?.id || entry.backup || '', to }
      );
    default:
      return logResultLabel(outcome.result, t);
  }
}

/**
 * The lead sentence of a failed action's outcome.
 *
 * @param {Object} outcome - from `outcomeFromError`
 * @param {Function} t
 * @returns {string}
 */
function failureText(outcome, t) {
  switch (outcome.action) {
    case MIGRATION_ACTION.RESTORE:
      return t(
        'admin.integrations.migration.outcome.restoreFailed',
        'The backup of {{label}} could not be restored.',
        { label: outcome.label }
      );
    case MIGRATION_ACTION.ADOPT:
      return t(
        'admin.integrations.migration.outcome.adoptFailed',
        'The current version could not be adopted for {{label}}.',
        { label: outcome.label }
      );
    case MIGRATION_ACTION.REVERT:
      return t(
        'admin.integrations.migration.outcome.revertFailed',
        '{{label}} could not be reverted; nothing was changed.',
        { label: outcome.label }
      );
    default:
      return t(
        'admin.integrations.migration.outcome.migrateFailed',
        'The migration of {{label}} failed.',
        { label: outcome.label }
      );
  }
}

/**
 * The outcome of a migration action: the log entry it wrote, or the error
 * with the server's reason and the problems it lists. Success is a polite
 * status message, failure an alert; both stay until dismissed, since the
 * state they describe may already be gone after the reload.
 *
 * @param {Object} props
 * @param {Object} props.outcome - from `outcomeFromResponse` / `outcomeFromError`
 * @param {() => void} props.onDismiss
 * @param {boolean} [props.linkToInstallation=false] - add a link to the installation's page
 * @param {(appId: string) => string} [props.appName]
 */
export function MigrationOutcome({ outcome, onDismiss, linkToInstallation = false, appName }) {
  const { t } = useTranslation();
  if (!outcome) return null;
  const retry = !outcome.ok && RETRY_CODES.has(outcome.code);
  const body = (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0 space-y-2">
        <p className="font-medium">
          {outcome.ok ? successText(outcome, t) : failureText(outcome, t)}
        </p>
        {!outcome.ok && outcome.reason && (
          <p className="break-words" data-testid="migration-outcome-reason">
            {t('admin.integrations.migration.log.reason', 'Reason: {{reason}}', {
              reason: outcome.reason
            })}
            {outcome.code && (
              <>
                {' '}
                <span className="font-mono text-xs">({outcome.code})</span>
              </>
            )}
          </p>
        )}
        {retry && (
          <p>
            {t(
              'admin.integrations.migration.outcome.retry',
              'Nothing was written. Try again in a moment.'
            )}
          </p>
        )}
        {!outcome.ok && <MigrationProblemList problems={outcome.problems} />}
        {outcome.logEntry && (
          <div className="rounded-md bg-white/70 dark:bg-gray-900/40 p-2 text-gray-900 dark:text-gray-100">
            <MigrationLogEntry entry={outcome.logEntry} appName={appName} headingLevel="p" />
          </div>
        )}
        {linkToInstallation && (
          <Link
            to={`/admin/integrations/${encodeURIComponent(outcome.instanceId)}`}
            className="inline-flex underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('admin.integrations.migration.outcome.open', 'Open {{label}}', {
              label: outcome.label
            })}
          </Link>
        )}
      </div>
      <button
        type="button"
        className={SECONDARY_BUTTON_CLASS}
        onClick={onDismiss}
        aria-label={t('admin.integrations.migration.outcome.dismiss', 'Dismiss')}
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
  if (outcome.ok) {
    return (
      <output className={`block ${CALLOUT_CLASS.success}`} data-testid="migration-outcome">
        {body}
      </output>
    );
  }
  return (
    <div className={CALLOUT_CLASS.danger} role="alert" data-testid="migration-outcome">
      {body}
    </div>
  );
}
