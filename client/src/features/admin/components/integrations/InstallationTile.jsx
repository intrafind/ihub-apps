// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import { InstallationStatusPills, MigrationStatusReason } from './IntegrationPills';
import { MigrationActionButtons } from './MigrationParts';
import { MIGRATION_ACTION, migrationActionsFor } from './migrationState';
import IntegrationFactList from './IntegrationFactList';
import { installationFacts } from './integrationFacts';
import { integrationGroup, integrationGroupOf } from './integrationGroups';

/** The path of an installation's page. */
export function installationPath(id, tab) {
  const base = `/admin/integrations/${encodeURIComponent(id)}`;
  return tab ? `${base}?tab=${tab}` : base;
}

/**
 * Compact icon buttons of the quick actions (the secondary / danger button
 * look of `formStyles`, smaller); `relative z-10` lifts them above the tile's
 * stretched link.
 */
const QUICK_BUTTON_BASE =
  'relative z-10 inline-flex items-center justify-center min-h-[32px] min-w-[32px] p-1.5 border shadow-xs rounded-md bg-white dark:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';
const QUICK_BUTTON = `${QUICK_BUTTON_BASE} border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 focus-visible:ring-blue-500`;
const QUICK_DANGER_BUTTON = `${QUICK_BUTTON_BASE} border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/40 focus-visible:ring-red-500`;
/** The migration actions of a tile: small text buttons, above the stretched link too. */
const MIGRATION_BUTTON =
  'relative z-10 inline-flex items-center gap-1 min-h-[32px] px-2.5 py-1 border border-gray-300 dark:border-gray-600 shadow-xs rounded-md bg-white dark:bg-gray-700 text-xs font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * One installation on the Installed tab: a card with everything an admin
 * needs at a glance — label, definition, the status pills, the key facts of
 * its values (never a secret), sign-in, groups — and the quick actions.
 *
 * The label is a link to the installation's page, stretched over the whole
 * card (clicking anywhere opens it; the focus ring frames the card). The
 * quick actions are separate buttons above it, each with an `aria-label`
 * naming the installation.
 *
 * An installation with a migration state shows its pill (red for a failed
 * migration, amber for pending and needs review), the reason as text and the
 * actions the state offers (Migrate now; Re-run migration, Restore backup;
 * Restore backup, Adopt current version). Uninstall is the Remove quick
 * action.
 *
 * @param {Object} props
 * @param {Object} props.item - an installation as `GET /api/admin/integrations/installed` lists it
 * @param {Object[]} props.installations - all installations (to name an `instance` value)
 * @param {string[]|null} [props.grantedTo] - the groups that grant it (`permissions.integrations`); null hides the line
 * @param {boolean} props.busy - an action on this installation is running
 * @param {(item: Object) => void} props.onTest
 * @param {(item: Object) => void} props.onToggle - enable / disable (asks first when apps bind it)
 * @param {(item: Object) => void} props.onRemove
 * @param {(item: Object) => void} props.onConnections - the connected users dialog
 * @param {(action: string, item: Object) => void} [props.onMigrationAction] - a migration
 *   action (`useMigrationActions().request`); without it the tile offers none
 */
function InstallationTile({
  item,
  installations,
  grantedTo = null,
  busy,
  onTest,
  onToggle,
  onRemove,
  onConnections,
  onMigrationAction
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const group = integrationGroup(integrationGroupOf(item));
  const facts = installationFacts(item, { installations });
  const enabled = item.enabled !== false;
  const unusable = item.definitionMissing || item.incompatible;
  // Uninstall is the Remove quick action below.
  const migrationActions = onMigrationAction
    ? migrationActionsFor(item).filter(action => action !== MIGRATION_ACTION.UNINSTALL)
    : [];

  return (
    <li
      className={`relative flex flex-col bg-white dark:bg-gray-800 rounded-lg shadow-xs border hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-shadow p-5 ${
        enabled
          ? 'border-gray-200 dark:border-gray-700'
          : 'border-dashed border-gray-300 dark:border-gray-600'
      }`}
      data-testid="installation-tile"
      data-installation={item.id}
    >
      <div className="flex items-start gap-3">
        <div className={`shrink-0 p-2 rounded-lg ${group.accent}`} aria-hidden="true">
          <Icon name={group.icon} className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
            <Link
              to={installationPath(item.id)}
              className="after:absolute after:inset-0 after:rounded-lg focus:outline-hidden focus-visible:after:ring-2 focus-visible:after:ring-indigo-500 focus-visible:after:ring-offset-2 dark:focus-visible:after:ring-offset-gray-900 hover:text-indigo-700 dark:hover:text-indigo-300"
            >
              {item.label}
            </Link>
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
            {item.definitionName || item.definition}
            <span className="mx-1.5 text-gray-400" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-xs">{item.id}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <InstallationStatusPills item={item} linkClassName="relative z-10" />
      </div>

      {item.incompatible && item.incompatibleReason && (
        <p
          className="mt-2 text-xs text-red-700 dark:text-red-400"
          data-testid="incompatible-reason"
        >
          {t(
            'admin.integrationCatalog.incompatibleReason',
            'This installation offers no actions: its definition {{reason}}.',
            { reason: item.incompatibleReason }
          )}
        </p>
      )}

      <MigrationStatusReason item={item} className="mt-2 break-words" />
      {migrationActions.length > 0 && (
        <div className="mt-2">
          <MigrationActionButtons
            actions={migrationActions}
            instance={item}
            onRequest={onMigrationAction}
            busy={busy}
            labelWithName
            buttonClassName={MIGRATION_BUTTON}
          />
        </div>
      )}

      {facts.length > 0 && (
        <div className="mt-3">
          <IntegrationFactList facts={facts} />
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400 flex-1">
        {Array.isArray(grantedTo) &&
          (grantedTo.length > 0
            ? t('admin.integrationCatalog.groupsLine', 'Groups: {{groups}}', {
                groups: grantedTo.join(', ')
              })
            : t('admin.integrations.tile.noGroup', 'No group grants it yet'))}
      </p>

      <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-end gap-1.5">
        {item.perUser && (
          <button
            type="button"
            className={QUICK_BUTTON}
            onClick={() => onConnections(item)}
            aria-label={t(
              'admin.integrationCatalog.actions.connections',
              'Connected users of {{id}}',
              {
                id: item.id
              }
            )}
            title={t('admin.integrationCatalog.connections.title', 'Connected users')}
          >
            <Icon name="users" size="sm" />
          </button>
        )}
        <button
          type="button"
          className={QUICK_BUTTON}
          onClick={() => onTest(item)}
          disabled={busy || unusable}
          aria-label={t('admin.integrationCatalog.actions.test', 'Test {{id}}', { id: item.id })}
          title={t('admin.integrationCatalog.actions.testTitle', 'Test connection')}
        >
          <Icon name="play" size="sm" />
        </button>
        <button
          type="button"
          className={QUICK_BUTTON}
          onClick={() => navigate(installationPath(item.id, 'settings'))}
          disabled={unusable}
          aria-label={t('admin.integrationCatalog.actions.edit', 'Edit {{id}}', { id: item.id })}
          title={t('common.edit', 'Edit')}
        >
          <Icon name="pencil" size="sm" />
        </button>
        {!item.locked && (
          <button
            type="button"
            className={QUICK_BUTTON}
            onClick={() => onToggle(item)}
            disabled={busy}
            aria-pressed={enabled}
            aria-label={
              enabled
                ? t('admin.integrationCatalog.actions.disable', 'Disable {{id}}', { id: item.id })
                : t('admin.integrationCatalog.actions.enable', 'Enable {{id}}', { id: item.id })
            }
            title={
              enabled
                ? t('admin.integrationCatalog.status.disable', 'Disable')
                : t('admin.integrationCatalog.status.enable', 'Enable')
            }
          >
            <Icon name={enabled ? 'pause' : 'check'} size="sm" />
          </button>
        )}
        {!item.locked && (
          <button
            type="button"
            className={QUICK_DANGER_BUTTON}
            onClick={() => onRemove(item)}
            disabled={busy}
            aria-label={t('admin.integrationCatalog.actions.remove', 'Remove {{id}}', {
              id: item.id
            })}
            title={t('common.delete', 'Delete')}
          >
            <Icon name="trash" size="sm" />
          </button>
        )}
      </div>
    </li>
  );
}

export default InstallationTile;
