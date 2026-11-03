// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Drawer from '../../../shared/components/Drawer';
import Badge from '../../../shared/components/Badge';
import StatusDot from '../../../shared/components/StatusDot';
import IntegrationLogo from './IntegrationLogo';
import { DANGER_BUTTON, PRIMARY_BUTTON } from './integrationButtons';
import { permissionsByEffect } from '../../integrations/connect/integrationInfo';
import {
  EFFECT_TONES,
  accessExpires,
  canDisconnect,
  capabilityLabel,
  formatDate,
  primaryActionOf,
  relativeTime,
  statusDotOf,
  statusText
} from '../integrationStatus';

/** A heading of one section of the drawer. */
function SectionHeading({ children }) {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
      {children}
    </h3>
  );
}

/**
 * The detail of one integration (Settings → Integrations): who iHub acts as
 * and since when, when access ends, when it was last used, what it can do
 * (each action with its effect), the permissions the user granted in plain
 * words, and the apps that use it. The footer offers Connect / Reconnect /
 * Disconnect for a personal sign-in.
 *
 * @param {Object} props
 * @param {Object|null} props.entry - The entry shown; null closes the drawer
 * @param {boolean} [props.busy]
 * @param {() => void} props.onClose
 * @param {(entry: Object, options: {reconnect: boolean}) => void} props.onConnect
 * @param {(entry: Object) => void} props.onDisconnect
 */
export default function IntegrationDetailDrawer({
  entry,
  busy = false,
  onClose,
  onConnect,
  onDisconnect
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  if (!entry) return null;

  const connection = entry.connection || {};
  const name = entry.name || entry.id;
  const action = primaryActionOf(entry);
  const personal = connection.mode === 'personal';
  const permissions = permissionsByEffect(entry.actions);
  const apps = Array.isArray(entry.apps) ? entry.apps : [];
  const sharedWith = Array.isArray(connection.sharedWith) ? connection.sharedWith : [];

  /** The facts about the identity, each only when the server knows it. */
  const facts = [];
  if (connection.account) {
    facts.push({
      id: 'account',
      label: t('integrations.page.detail.account', 'Signed in as'),
      value: connection.account
    });
  }
  if (connection.connectedAt) {
    facts.push({
      id: 'connectedAt',
      label: t('integrations.page.detail.connectedAt', 'Connected since'),
      value: formatDate(connection.connectedAt, language)
    });
  }
  if (connection.status === 'connected') {
    facts.push({
      id: 'access',
      label: t('integrations.page.detail.access', 'Access'),
      value: accessExpires(connection)
        ? t('integrations.page.detail.expiresOn', 'Ends {{when}} ({{date}}); then connect again', {
            when: relativeTime(connection.expiresAt, language),
            date: formatDate(connection.expiresAt, language)
          })
        : connection.renewable
          ? t('integrations.page.detail.renews', 'Renewed automatically until you disconnect')
          : t('integrations.page.detail.untilDisconnect', 'Until you disconnect or it is revoked')
    });
  }
  if (personal && connection.status !== 'unavailable') {
    facts.push({
      id: 'lastUsed',
      label: t('integrations.page.detail.lastUsed', 'Last used'),
      value: connection.lastUsedAt
        ? formatDate(connection.lastUsedAt, language)
        : t('integrations.page.detail.neverUsed', 'Not used yet')
    });
  }
  if (connection.signInHost) {
    facts.push({
      id: 'signInHost',
      label: t('integrations.page.detail.signInHost', 'You sign in at'),
      value: connection.signInHost
    });
  }
  if (sharedWith.length > 0) {
    facts.push({
      id: 'sharedWith',
      label: t('integrations.page.detail.sharedWith', 'Shared with your group'),
      value: sharedWith.map(group => group.name || group.id).join(', ')
    });
  }

  const footer =
    action || canDisconnect(entry) ? (
      <div className="flex flex-wrap justify-end gap-2">
        {canDisconnect(entry) && (
          <button
            type="button"
            className={DANGER_BUTTON}
            disabled={busy}
            onClick={() => onDisconnect(entry)}
          >
            {t('integrations.page.disconnect', 'Disconnect')}
          </button>
        )}
        {(action === 'connect' || action === 'reconnect') && (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={busy}
            onClick={() => onConnect(entry, { reconnect: action === 'reconnect' })}
          >
            {action === 'reconnect'
              ? t('integrations.connect.reconnect', 'Reconnect')
              : t('integrations.connect.connect', 'Connect')}
          </button>
        )}
      </div>
    ) : null;

  return (
    <Drawer
      isOpen={Boolean(entry)}
      onClose={onClose}
      title={name}
      icon={<IntegrationLogo entry={entry} size="sm" />}
      description={entry.description || undefined}
      footer={footer}
      size="md"
      data-testid="integration-detail"
    >
      <div className="space-y-6 px-5 py-4">
        <section className="space-y-2">
          <SectionHeading>
            {t('integrations.page.detail.identity', 'How it runs for you')}
          </SectionHeading>
          <StatusDot
            status={statusDotOf(entry)}
            label={statusText(entry, t, { language })}
            showLabel
          />
          {facts.length > 0 && (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              {facts.map(fact => (
                <div key={fact.id} className="contents">
                  <dt className="text-gray-600 dark:text-gray-400">{fact.label}</dt>
                  <dd className="break-words text-gray-900 dark:text-gray-100">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="space-y-2">
          <SectionHeading>{t('integrations.page.detail.actions', 'What it can do')}</SectionHeading>
          {entry.actions?.length > 0 ? (
            <ul className="space-y-2">
              {entry.actions.map(action => (
                <li key={action.name} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {action.title || action.name}
                    </span>
                    <Badge tone={EFFECT_TONES[action.sideEffect] || 'neutral'}>
                      {t(
                        `integrations.connect.effects.${action.sideEffect || 'unknown'}`,
                        action.sideEffect || 'unknown'
                      )}
                    </Badge>
                  </div>
                  {action.description && (
                    <p className="text-gray-600 dark:text-gray-400">{action.description}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {entry.capabilities?.length > 0
                ? entry.capabilities.map(capability => capabilityLabel(capability, t)).join(', ')
                : t('integrations.page.detail.noActions', 'It offers no actions in chat.')}
            </p>
          )}
        </section>

        {personal &&
          (connection.status === 'connected' || connection.status === 'needs_reconnect') && (
            <section className="space-y-2">
              <SectionHeading>
                {t('integrations.page.detail.permissions', 'What you allowed')}
              </SectionHeading>
              {permissions.length > 0 ? (
                <ul className="space-y-1 text-sm text-gray-800 dark:text-gray-200">
                  {permissions.map(group => (
                    <li key={group.effect}>
                      {t('integrations.page.detail.permissionLine', '{{effect}}: {{actions}}', {
                        effect: t(`integrations.connect.effects.${group.effect}`, group.effect),
                        actions: group.titles.join(', ')
                      })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('integrations.page.detail.actAsYou', 'iHub acts as you in {{name}}.', {
                    name
                  })}
                </p>
              )}
              {connection.scopes?.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer rounded-sm text-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300">
                    {t('integrations.page.detail.scopes', 'Technical permissions ({{count}})', {
                      count: connection.scopes.length
                    })}
                  </summary>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {connection.scopes.map(scope => (
                      <li key={scope}>
                        <code className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                          {scope}
                        </code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}

        <section className="space-y-2">
          <SectionHeading>{t('integrations.page.detail.apps', 'Apps that use it')}</SectionHeading>
          {apps.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {apps.map(app => (
                <li key={app.id}>
                  <Link
                    to={`/apps/${encodeURIComponent(app.id)}`}
                    className="inline-flex rounded-md border border-gray-300 px-2.5 py-1 text-sm text-indigo-700 hover:bg-indigo-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-600 dark:text-indigo-300 dark:hover:bg-gray-800"
                  >
                    {app.name || app.id}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('integrations.page.detail.noApps', 'None of the apps you can open uses it yet.')}
            </p>
          )}
        </section>
      </div>
    </Drawer>
  );
}
