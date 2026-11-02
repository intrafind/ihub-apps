// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import { INBOUND_INTEGRATIONS, inboundStatus } from './inboundChannels';

const STATUS_STYLES = {
  connected:
    'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
  available:
    'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700'
};

/** The status pill of an inbound card: switched on, or available. */
function StatusPill({ status }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
        STATUS_STYLES[status] ?? STATUS_STYLES.available
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
      {status === 'connected'
        ? t('admin.integrations.inbound.status.on', 'On')
        : t('admin.integrations.inbound.status.available', 'Available')}
    </span>
  );
}

/**
 * The Inbound tab: the channels through which other software reaches iHub
 * (Outlook add-in, browser extension, Microsoft 365 Copilot, Nextcloud
 * embed, MCP gateway). Each card links to its configuration page and shows
 * whether it is switched on; the look is the card of the former integrations
 * hub page.
 *
 * @param {Object} props
 * @param {Object|null} props.platform - `platform.json`; null shows every card as available
 */
function InboundIntegrations({ platform }) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.integrations.inbound.description',
          'What connects to iHub: other applications that embed iHub or call its apps. Each one is configured on its own page.'
        )}
      </p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {INBOUND_INTEGRATIONS.map(entry => (
          <li key={entry.id} data-testid="inbound-card" data-inbound={entry.id}>
            <Link
              to={entry.href}
              className="block h-full rounded-lg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              <div className="h-full bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 p-5 transition-all active:scale-[0.99]">
                <div className="flex items-start justify-between mb-3">
                  <div className={`p-2 rounded-lg ${entry.color}`} aria-hidden="true">
                    <Icon name={entry.icon} className="w-5 h-5" />
                  </div>
                  <StatusPill status={inboundStatus(entry, platform)} />
                </div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                  {t(entry.titleKey, entry.titleDefault)}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
                  {t(entry.descriptionKey, entry.descriptionDefault)}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default InboundIntegrations;
