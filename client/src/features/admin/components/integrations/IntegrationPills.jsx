// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Badge from '../../../../shared/components/Badge';
import StatusDot from '../../../../shared/components/StatusDot';
import { MIGRATION_STATUS, migrationStatusTone } from './migrationState';

/**
 * The Badge tone of a migration state's tone (`migrationStatusTone`, which
 * also picks the frame colour of the migration panel): failed red, pending
 * and needs review amber.
 */
const MIGRATION_BADGE_TONES = { red: 'danger', amber: 'warning' };

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
    <Badge tone={MIGRATION_BADGE_TONES[tone]}>
      <span data-testid="migration-status">{migrationStatusLabel(status, t)}</span>
    </Badge>
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

/**
 * The live status as a {@link StatusDot} status and a {@link Badge} tone:
 * unreachable `error` (red), connected or signed in per user `ok` (green),
 * else `off` (gray).
 *
 * @param {Object} status - the installation's live status
 * @returns {{dot: 'ok'|'error'|'off', tone: 'success'|'danger'|'neutral'}}
 */
function liveStatusStyle(status) {
  if (status.unhealthy) return { dot: 'error', tone: 'danger' };
  if (status.connected || status.perUser) return { dot: 'ok', tone: 'success' };
  return { dot: 'off', tone: 'neutral' };
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

/** The Badge tone of the LDAP transport: plain text red, unknown gray, protected blue. */
function transportTone(transport) {
  if (transport === 'plaintext') return 'danger';
  if (transport === 'unknown') return 'neutral';
  return 'info';
}

/**
 * Every badge of an installation, as on its tile and in its page header:
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
  const live = item.liveStatus ? liveStatusStyle(item.liveStatus) : null;
  return (
    <>
      <Badge tone={enabled ? 'success' : 'warning'}>
        {enabled
          ? t('admin.integrationCatalog.status.enabled', 'Enabled')
          : t('admin.integrationCatalog.status.disabled', 'Disabled')}
      </Badge>
      {item.locked && (
        <Badge tone="info">
          {t('admin.integrationCatalog.status.alwaysInstalled', 'Always installed')}
        </Badge>
      )}
      {item.definitionMissing && (
        <Badge tone="danger">
          {t('admin.integrationCatalog.status.definitionMissing', 'Definition missing')}
        </Badge>
      )}
      {item.definitionVersion && (
        <Badge
          tone="neutral"
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
        </Badge>
      )}
      <MigrationStatusPill status={item.status} />
      {item.incompatible && (
        <Badge tone="danger" title={item.incompatibleReason || undefined}>
          {t('admin.integrationCatalog.status.incompatible', 'Incompatible')}
        </Badge>
      )}
      {item.updateAvailable && item.latestVersion && (
        <Link
          to={marketplaceLinkFor(item.definition)}
          className={`inline-flex rounded-full focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${linkClassName}`}
          data-testid="update-badge"
        >
          <Badge
            tone="warning"
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
          </Badge>
        </Link>
      )}
      {item.auth?.mode && item.auth.mode !== 'none' && (
        <Badge tone="info">
          {t(`admin.integrationCatalog.authModes.short.${item.auth.mode}`, item.auth.mode)}
        </Badge>
      )}
      {live && enabled && (
        <Badge tone={live.tone}>
          <StatusDot
            status={live.dot}
            size="sm"
            showLabel
            labelClassName=""
            data-testid="live-status"
            label={`${statusLabel(item.liveStatus, t)}${
              typeof item.liveStatus.toolCount === 'number'
                ? ` · ${t('admin.integrationCatalog.status.toolCount', '{{count}} tools', { count: item.liveStatus.toolCount })}`
                : ''
            }`}
          />
        </Badge>
      )}
      {item.liveStatus?.transport && enabled && (
        // People directories: how the LDAP connection is protected.
        <Badge tone={transportTone(item.liveStatus.transport)}>
          {t(
            `admin.integrationCatalog.transport.${item.liveStatus.transport}`,
            item.liveStatus.transport
          )}
        </Badge>
      )}
      {item.liveStatus?.external && (
        <Badge tone="warning">{t('admin.integrationCatalog.status.external', 'External')}</Badge>
      )}
    </>
  );
}
