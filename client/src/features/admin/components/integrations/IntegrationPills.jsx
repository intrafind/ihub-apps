// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MIGRATION_STATUS, migrationStatusTone } from './migrationState';

const TONES = {
  green: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300',
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
};

/**
 * A small status pill of the integrations admin.
 *
 * @param {Object} props
 * @param {'green'|'yellow'|'amber'|'red'|'blue'|'orange'|'gray'} [props.tone='gray']
 * @param {string} [props.title] - tooltip
 * @param {React.ReactNode} props.children
 */
export function Pill({ tone = 'gray', title, children }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TONES[tone] || TONES.gray}`}
      title={title}
    >
      {children}
    </span>
  );
}

/** Where the marketplace shows the item of a definition, for the update badge. */
export function marketplaceLinkFor(definitionId) {
  return `/admin/marketplace?type=integration&q=${encodeURIComponent(String(definitionId).replace('/', '__'))}`;
}

/**
 * The name of a migration state, as its pill and the installation page show it.
 *
 * @param {string} status - `migrationPending`, `migrationFailed` or `needsReview`
 * @param {Function} t - the translation function
 * @returns {string}
 */
export function migrationStatusLabel(status, t) {
  switch (status) {
    case MIGRATION_STATUS.PENDING:
      return t('admin.integrations.migration.status.migrationPending', 'Migration pending');
    case MIGRATION_STATUS.FAILED:
      return t('admin.integrations.migration.status.migrationFailed', 'Migration failed');
    case MIGRATION_STATUS.REVIEW:
      return t('admin.integrations.migration.status.needsReview', 'Needs review');
    default:
      return status;
  }
}

/**
 * The pill of an installation's migration state: red for a failed migration,
 * amber for a pending one and one that needs a review. The reason is not a
 * tooltip here: the tile and the page show it as text next to the pill
 * ({@link MigrationStatusReason}).
 *
 * @param {Object} props
 * @param {string|null|undefined} props.status - `instance.status`
 */
export function MigrationStatusPill({ status }) {
  const { t } = useTranslation();
  const tone = migrationStatusTone(status);
  if (!tone) return null;
  return (
    <Pill tone={tone}>
      <span data-testid="migration-status">{migrationStatusLabel(status, t)}</span>
    </Pill>
  );
}

/**
 * The reason of an installation's migration state as visible text (the
 * server's `statusReason`), next to its pill.
 *
 * @param {Object} props
 * @param {Object} props.item - an installation of the admin API
 * @param {string} [props.className]
 */
export function MigrationStatusReason({ item, className = '' }) {
  const tone = migrationStatusTone(item?.status);
  if (!tone || !item.statusReason) return null;
  const color =
    tone === 'red' ? 'text-red-700 dark:text-red-400' : 'text-amber-800 dark:text-amber-300';
  return (
    <p className={`text-xs ${color} ${className}`} data-testid="migration-reason">
      {item.statusReason}
    </p>
  );
}

/** The tone of the live status pill: unreachable red, connected green, else gray. */
function statusTone(status) {
  if (status.unhealthy) return 'red';
  if (status.connected || status.perUser) return 'green';
  return 'gray';
}

/**
 * The text of the live status pill: unreachable, the number of connected
 * users (per-user sign-in), connected or not connected.
 *
 * @param {Object} status - the installation's live status
 * @param {Function} t - the translation function
 * @returns {string}
 */
function statusLabel(status, t) {
  if (status.unhealthy) return t('admin.integrationCatalog.status.unhealthy', 'Unreachable');
  if (status.perUser) {
    return t('admin.integrationCatalog.status.userConnections', '{{count}} connected users', {
      count: status.userConnections || 0
    });
  }
  if (status.connected) return t('admin.integrationCatalog.status.connected', 'Connected');
  return t('admin.integrationCatalog.status.notConnected', 'Not connected');
}

/** The tone of the LDAP transport pill: plain text red, unknown gray, protected blue. */
function transportTone(transport) {
  if (transport === 'plaintext') return 'red';
  if (transport === 'unknown') return 'gray';
  return 'blue';
}

/**
 * Every pill of an installation, as on its tile and in its page header:
 * enabled / disabled, always installed, definition missing, version (with
 * the version on disk as tooltip when it differs), the migration state
 * (pending, failed, needs review), incompatible, update
 * available (a link to the marketplace), the sign-in mode, the live status
 * (connected, unreachable, N connected users, tool count), the transport of
 * a directory and "External".
 *
 * @param {Object} props
 * @param {Object} props.item - an installation as the admin API lists it
 * @param {string} [props.linkClassName] - extra classes for the update link
 *   (a tile lifts it above its stretched link)
 */
export function InstallationStatusPills({ item, linkClassName = '' }) {
  const { t } = useTranslation();
  const enabled = item.enabled !== false;
  return (
    <>
      <Pill tone={enabled ? 'green' : 'yellow'}>
        {enabled
          ? t('admin.integrationCatalog.status.enabled', 'Enabled')
          : t('admin.integrationCatalog.status.disabled', 'Disabled')}
      </Pill>
      {item.locked && (
        <Pill tone="blue">
          {t('admin.integrationCatalog.status.alwaysInstalled', 'Always installed')}
        </Pill>
      )}
      {item.definitionMissing && (
        <Pill tone="red">
          {t('admin.integrationCatalog.status.definitionMissing', 'Definition missing')}
        </Pill>
      )}
      {item.definitionVersion && (
        <Pill
          tone="gray"
          title={
            item.currentVersion && item.currentVersion !== item.definitionVersion
              ? t(
                  'admin.integrationCatalog.status.definitionVersion',
                  'Definition on disk: v{{version}}',
                  { version: item.currentVersion }
                )
              : undefined
          }
        >
          <span className="font-mono" data-testid="installed-version">
            v{item.definitionVersion}
          </span>
        </Pill>
      )}
      <MigrationStatusPill status={item.status} />
      {item.incompatible && (
        <Pill tone="red" title={item.incompatibleReason || undefined}>
          {t('admin.integrationCatalog.status.incompatible', 'Incompatible')}
        </Pill>
      )}
      {item.updateAvailable && item.latestVersion && (
        <Link
          to={marketplaceLinkFor(item.definition)}
          className={`inline-flex rounded-full focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${linkClassName}`}
          data-testid="update-badge"
        >
          <Pill
            tone="orange"
            title={t(
              'admin.integrationCatalog.status.updateAvailableTitle',
              'Open the marketplace to update'
            )}
          >
            {t(
              'admin.integrationCatalog.status.updateAvailable',
              'Update to v{{version}} available',
              {
                version: item.latestVersion
              }
            )}
          </Pill>
        </Link>
      )}
      {item.auth?.mode && item.auth.mode !== 'none' && (
        <Pill tone="blue">
          {t(`admin.integrationCatalog.authModes.short.${item.auth.mode}`, item.auth.mode)}
        </Pill>
      )}
      {item.liveStatus && enabled && (
        <Pill tone={statusTone(item.liveStatus)}>
          <span data-testid="live-status">
            {statusLabel(item.liveStatus, t)}
            {typeof item.liveStatus.toolCount === 'number' &&
              ` · ${t('admin.integrationCatalog.status.toolCount', '{{count}} tools', { count: item.liveStatus.toolCount })}`}
          </span>
        </Pill>
      )}
      {item.liveStatus?.transport && enabled && (
        // People directories: how the LDAP connection is protected.
        <Pill tone={transportTone(item.liveStatus.transport)}>
          {t(
            `admin.integrationCatalog.transport.${item.liveStatus.transport}`,
            item.liveStatus.transport
          )}
        </Pill>
      )}
      {item.liveStatus?.external && (
        <Pill tone="yellow">{t('admin.integrationCatalog.status.external', 'External')}</Pill>
      )}
    </>
  );
}
