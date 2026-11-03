// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import StatusDot from '../../../shared/components/StatusDot';
import Icon from '../../../shared/components/Icon';
import IntegrationLogo from './IntegrationLogo';
import { DANGER_BUTTON, PRIMARY_BUTTON } from './integrationButtons';
import { capabilitySummary, primaryActionOf, statusDotOf, statusText } from '../integrationStatus';

/**
 * One integration on Settings → Integrations: logo, name (opens the detail),
 * who iHub acts as (the status line), what it can do, and the one action the
 * user can take — Connect, Reconnect or Disconnect. Integrations that run
 * with SSO, a service account, a shared key or no sign-in have no action.
 *
 * @param {Object} props
 * @param {Object} props.entry - An entry of `GET /api/integrations`
 * @param {boolean} [props.busy] - An action on this integration is running
 * @param {(entry: Object) => void} props.onOpen - Open the detail
 * @param {(entry: Object, options: {reconnect: boolean}) => void} props.onConnect
 * @param {(entry: Object) => void} props.onDisconnect
 */
export default function IntegrationRow({ entry, busy = false, onOpen, onConnect, onDisconnect }) {
  const { t, i18n } = useTranslation();
  const status = statusText(entry, t, { language: i18n.language });
  const action = primaryActionOf(entry);
  const summary = capabilitySummary(entry, t);
  const effects = (entry.effects || [])
    .map(effect => t(`integrations.connect.effects.${effect}`, effect))
    .join(' · ');

  return (
    <li
      className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center"
      data-testid="integration-row"
      data-integration={entry.id}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <IntegrationLogo entry={entry} />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            <button
              type="button"
              onClick={() => onOpen(entry)}
              aria-haspopup="dialog"
              className="inline-flex max-w-full items-center gap-1 rounded-sm text-left hover:text-indigo-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-indigo-300"
            >
              <span className="truncate">{entry.name || entry.id}</span>
              <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-gray-500" />
              <span className="sr-only">{t('integrations.page.showDetails', 'Show details')}</span>
            </button>
          </h3>
          <StatusDot
            status={statusDotOf(entry)}
            label={status}
            showLabel
            className="mt-0.5"
            data-testid="integration-status"
          />
          {(summary || effects) && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {summary}
              {summary && effects && (
                <span aria-hidden="true" className="mx-1.5">
                  ·
                </span>
              )}
              {effects && <span className="whitespace-nowrap">{effects}</span>}
            </p>
          )}
        </div>
      </div>
      {action && (
        <div className="flex shrink-0 justify-end sm:pl-4">
          {action === 'disconnect' ? (
            <button
              type="button"
              className={DANGER_BUTTON}
              disabled={busy}
              onClick={() => onDisconnect(entry)}
              aria-label={t('integrations.page.disconnectNamed', 'Disconnect {{name}}', {
                name: entry.name || entry.id
              })}
            >
              {t('integrations.page.disconnect', 'Disconnect')}
            </button>
          ) : (
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => onConnect(entry, { reconnect: action === 'reconnect' })}
              aria-label={
                action === 'reconnect'
                  ? t('integrations.page.reconnectNamed', 'Reconnect {{name}}', {
                      name: entry.name || entry.id
                    })
                  : t('integrations.page.connectNamed', 'Connect {{name}}', {
                      name: entry.name || entry.id
                    })
              }
            >
              {action === 'reconnect'
                ? t('integrations.connect.reconnect', 'Reconnect')
                : t('integrations.connect.connect', 'Connect')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
