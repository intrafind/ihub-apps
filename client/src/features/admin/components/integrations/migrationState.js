// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The migration state of an installation as the admin UI reads it (versioning
 * concept §3 and §4, `docs/integrations.md` → *Migrations*). Pure functions
 * over what `GET /api/admin/integrations/installed[/:id]` returns:
 *
 * - `status`: `migrationPending` | `migrationFailed` | `needsReview` | null,
 *   with `statusReason` (server text, English);
 * - `migration`: `{ pending, blocked, downgrade, from, to, migrations, summary,
 *   warnings, collisions, errors, backups, defaultBackup }` or null;
 * - `migrationLog`: the last 10 runs, oldest first.
 *
 * The components (`IntegrationPills`, `InstallationMigrationPanel`,
 * `MigrationLog`, the tiles) only render what these functions decide, so the
 * rules (which action a state offers, when the editor is read-only) live in
 * one place.
 *
 * @module features/admin/components/integrations/migrationState
 */

/** The migration states of an installation (`instance.status`). */
export const MIGRATION_STATUS = Object.freeze({
  PENDING: 'migrationPending',
  FAILED: 'migrationFailed',
  REVIEW: 'needsReview'
});

/** The actions the admin can take on a migration state. */
export const MIGRATION_ACTION = Object.freeze({
  /** `POST …/_migrate` on a pending installation ("Migrate now"). */
  MIGRATE: 'migrate',
  /** `POST …/_migrate` on a failed installation ("Re-run migration"). */
  RERUN: 'rerun',
  /** `POST …/_restore` with the default backup ("Restore backup"). */
  RESTORE: 'restore',
  /** `POST …/_adopt` ("Adopt current version"). */
  ADOPT: 'adopt',
  /** `DELETE …/installed/:id` ("Uninstall"), the page's own remove flow. */
  UNINSTALL: 'uninstall'
});

/** Actions that change or remove stored data the admin cannot get back by retrying: asked first. */
const CONFIRMED_ACTIONS = new Set([
  MIGRATION_ACTION.RESTORE,
  MIGRATION_ACTION.ADOPT,
  MIGRATION_ACTION.UNINSTALL
]);

/** Log entry results, as `migrationLog[].result` records them. */
export const LOG_RESULTS = Object.freeze([
  'migrated',
  'stamped',
  'failed',
  'rolledBack',
  'restored',
  'adopted',
  'skipped'
]);

/**
 * Whether a value is one of the three migration states.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isMigrationStatus(status) {
  return Object.values(MIGRATION_STATUS).includes(status);
}

/**
 * The pill tone of a migration state: red for a failed migration, amber for
 * a pending one and for one that needs a review, null without a state.
 *
 * @param {string|null|undefined} status
 * @returns {'red'|'amber'|null}
 */
export function migrationStatusTone(status) {
  if (status === MIGRATION_STATUS.FAILED) return 'red';
  if (status === MIGRATION_STATUS.PENDING || status === MIGRATION_STATUS.REVIEW) return 'amber';
  return null;
}

/**
 * The backup `POST …/_restore` takes without a body (`migration.defaultBackup`),
 * with its details from `migration.backups` when listed.
 *
 * @param {Object} instance - an installation of the admin API
 * @returns {{ id: string, representedVersion?: string, createdAt?: string, kind?: string, hasDefinition?: boolean }|null}
 */
export function defaultBackupOf(instance) {
  const id = instance?.migration?.defaultBackup;
  if (!id) return null;
  const listed = (instance.migration.backups || []).find(backup => backup?.id === id);
  return listed || { id };
}

/**
 * The actions a migration state offers (concept §3):
 *
 * - `migrationPending`: Migrate now;
 * - `migrationFailed`: Re-run migration, Restore backup, Uninstall;
 * - `needsReview`: Restore backup, Adopt current version, Uninstall.
 *
 * Restore backup is offered only while the server names a default backup
 * (without one `_restore` answers `404 BACKUP_NOT_FOUND`); Uninstall never
 * for an always-installed built-in (`locked`), which cannot be removed.
 *
 * @param {Object} instance - an installation of the admin API
 * @returns {string[]} values of {@link MIGRATION_ACTION}, in button order
 */
export function migrationActionsFor(instance) {
  const status = instance?.status;
  const restore = defaultBackupOf(instance) ? [MIGRATION_ACTION.RESTORE] : [];
  const uninstall = instance?.locked ? [] : [MIGRATION_ACTION.UNINSTALL];
  switch (status) {
    case MIGRATION_STATUS.PENDING:
      return [MIGRATION_ACTION.MIGRATE];
    case MIGRATION_STATUS.FAILED:
      return [MIGRATION_ACTION.RERUN, ...restore, ...uninstall];
    case MIGRATION_STATUS.REVIEW:
      return [...restore, MIGRATION_ACTION.ADOPT, ...uninstall];
    default:
      return [];
  }
}

/**
 * Whether an action is asked for in a confirmation dialog first: Restore
 * backup, Adopt current version and Uninstall replace or remove what is
 * stored. Migrate and Re-run are not: they take a backup themselves and a
 * failure changes nothing stored.
 *
 * @param {string} action - a {@link MIGRATION_ACTION} value
 * @returns {boolean}
 */
export function needsConfirmation(action) {
  return CONFIRMED_ACTIONS.has(action);
}

/**
 * Whether the installation's settings are read-only because `PUT
 * …/installed/:id` refuses them: a failed migration (`409 MIGRATION_FAILED`),
 * one that needs a review (`409 NEEDS_REVIEW`), and a pending one with a
 * migration between the versions (`409 MIGRATION_PENDING`). A pending
 * installation with no migration between saves normally (the save stamps the
 * new version); while the server could not describe the pending migration
 * (`migration` null) the editor stays read-only, the safe side.
 *
 * @param {Object} instance - an installation of the admin API
 * @returns {boolean}
 */
export function isSettingsReadOnly(instance) {
  switch (instance?.status) {
    case MIGRATION_STATUS.FAILED:
    case MIGRATION_STATUS.REVIEW:
      return true;
    case MIGRATION_STATUS.PENDING:
      return instance.migration?.blocked !== false;
    default:
      return false;
  }
}

/**
 * The planned or recorded changes as `{ kind, count }` parts, without the
 * empty ones: install values, actions of the policy, app bindings.
 *
 * @param {{ values?: number, actions?: number, apps?: number }|null|undefined} summary
 * @returns {Array<{ kind: 'values'|'actions'|'apps', count: number }>}
 */
export function changeParts(summary) {
  if (!summary || typeof summary !== 'object') return [];
  return ['values', 'actions', 'apps']
    .map(kind => ({ kind, count: Number(summary[kind]) || 0 }))
    .filter(part => part.count > 0);
}

/**
 * The migration log newest first (the server keeps it oldest first).
 *
 * @param {Array<Object>|undefined} log - `instance.migrationLog`
 * @returns {Array<Object>}
 */
export function migrationLogNewestFirst(log) {
  return Array.isArray(log) ? [...log].reverse() : [];
}

/**
 * What a successful migration action answered, for the outcome message.
 *
 * @param {string} action - a {@link MIGRATION_ACTION} value
 * @param {Object} instance - the installation the action ran on (before)
 * @param {Object} data - the response body (`{ result?, logEntry, backup?, instance }`)
 * @returns {{ ok: true, action: string, instanceId: string, label: string, result: string, logEntry: Object|null, backup: Object|null, instance: Object|null }}
 */
export function outcomeFromResponse(action, instance, data) {
  let result = data?.result || null;
  if (!result) {
    if (action === MIGRATION_ACTION.RESTORE) result = 'restored';
    else if (action === MIGRATION_ACTION.ADOPT) result = 'adopted';
    else result = data?.logEntry?.result || 'migrated';
  }
  return {
    ok: true,
    action,
    instanceId: instance.id,
    label: instance.label || instance.id,
    result,
    logEntry: data?.logEntry || null,
    backup: data?.backup || null,
    instance: data?.instance || null
  };
}

/**
 * What a failed migration action answered, for the outcome message: the
 * error `code` and the server's `reason`, the log entry of a failed
 * migration and its `details` (`collisions` and `errors` of
 * `MIGRATION_FAILED`, the list of problems of `ADOPT_INVALID`).
 *
 * @param {string} action - a {@link MIGRATION_ACTION} value
 * @param {Object} instance - the installation the action ran on
 * @param {Error & { response?: { status?: number, data?: Object } }} error - the request error
 * @returns {{ ok: false, action: string, instanceId: string, label: string, status: number|null, code: string|null, reason: string, logEntry: Object|null, problems: Array<{ message: string }> }}
 */
export function outcomeFromError(action, instance, error) {
  const data = error?.response?.data || {};
  return {
    ok: false,
    action,
    instanceId: instance.id,
    label: instance.label || instance.id,
    status: error?.response?.status ?? null,
    code: data.code || null,
    reason: data.reason || data.error || error?.message || '',
    logEntry: data.logEntry || null,
    problems: problemsOf(data)
  };
}

/**
 * The single problems an error lists: the collisions and validation errors
 * of a failed migration, or the problems of an adopt that did not fit.
 *
 * @param {Object} data - the error body
 * @returns {Array<{ message: string }>}
 */
function problemsOf(data) {
  const details = data?.details;
  const list = Array.isArray(details)
    ? details
    : [...(details?.collisions || []), ...(details?.errors || [])];
  return list
    .map(problem =>
      typeof problem === 'string' ? { message: problem } : { ...problem, message: problem?.message }
    )
    .filter(problem => typeof problem.message === 'string' && problem.message);
}
