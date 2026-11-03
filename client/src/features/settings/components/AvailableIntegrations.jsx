// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import IntegrationRow from './IntegrationRow';
import IntegrationDetailDrawer from './IntegrationDetailDrawer';
import { disconnectUserIntegration, fetchUserIntegration } from '../../../api/userIntegrationsApi';
import {
  invalidateIntegrationInfo,
  startIntegrationConnect
} from '../../integrations/connect/integrationInfo';
import { currentReturnUrl } from '../../integrations/connect/connectResult';
import { STATUS_FILTERS, categoryOptions, filterIntegrations } from '../integrationStatus';

const FIELD =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-400';

/**
 * "Available to you": every integration the user's groups allow
 * (`GET /api/integrations`), one row each, with search, a category filter
 * and a "Needs attention" filter. A row opens its detail in a drawer.
 *
 * Connect and Reconnect start the one connect flow (the browser leaves for
 * the vendor and comes back to this page); Disconnect asks first, then
 * reloads that one entry, so the row changes without a page reload.
 *
 * @param {Object} props
 * @param {Object[]} props.entries - The listing
 * @param {(updater: (entries: Object[]) => Object[]) => void} props.onEntriesChange
 * @param {(message: {type: 'success'|'error', text: string}) => void} props.onMessage
 */
export default function AvailableIntegrations({ entries, onEntriesChange, onMessage }) {
  const { t, i18n } = useTranslation();
  const baseId = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState(STATUS_FILTERS.ALL);
  const [openId, setOpenId] = useState(null);
  const [pendingDisconnect, setPendingDisconnect] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const categories = useMemo(() => categoryOptions(entries, t), [entries, t]);
  const shown = useMemo(
    () => filterIntegrations(entries, { query, category, status }, t, { language: i18n.language }),
    [entries, query, category, status, t, i18n.language]
  );
  const filtering = Boolean(query.trim() || category || status !== STATUS_FILTERS.ALL);
  const openEntry = entries.find(entry => entry.id === openId) || null;
  const nameOf = entry => entry?.name || entry?.id || '';

  const handleConnect = async (entry, { reconnect = false } = {}) => {
    setBusyId(entry.id);
    try {
      await startIntegrationConnect(entry.id, { reconnect, returnUrl: currentReturnUrl() });
      // The browser is leaving for the sign-in; the busy state stays.
    } catch {
      setBusyId(null);
      onMessage({
        type: 'error',
        text: t(
          'integrations.connect.startFailed',
          'The sign-in to {{name}} could not be started.',
          {
            name: nameOf(entry)
          }
        )
      });
    }
  };

  const handleDisconnect = async entry => {
    setPendingDisconnect(null);
    if (!entry) return;
    setBusyId(entry.id);
    try {
      await disconnectUserIntegration(entry.id);
      invalidateIntegrationInfo(entry.id);
      // The server says what the row is now; without an answer it is not connected.
      const fresh = await fetchUserIntegration(entry.id).catch(() => null);
      onEntriesChange(list =>
        list.map(item =>
          item.id !== entry.id
            ? item
            : fresh || {
                ...item,
                connection: {
                  ...item.connection,
                  status: 'not_connected',
                  reason: 'not_connected',
                  account: null,
                  scopes: [],
                  connectedAt: null,
                  expiresAt: null,
                  renewable: null
                }
              }
        )
      );
      onMessage({
        type: 'success',
        text: t('integrations.page.disconnected', '{{name}} disconnected.', { name: nameOf(entry) })
      });
    } catch (error) {
      onMessage({
        type: 'error',
        text: t(
          'integrations.page.disconnectFailed',
          'Could not disconnect {{name}}: {{message}}',
          {
            name: nameOf(entry),
            message: error?.response?.data?.error || error?.message || ''
          }
        )
      });
    } finally {
      setBusyId(null);
    }
  };

  const headingId = `${baseId}-heading`;
  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('integrations.page.available.title', 'Available to you ({{count}})', {
            count: entries.length
          })}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'integrations.page.available.description',
            'Everything your groups allow, and who iHub acts as in each. Connect once; chats use it afterwards.'
          )}
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400">
          {t('integrations.page.available.empty', 'No integration is available to you yet.')}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row" role="search">
            <div className="relative flex-1">
              <label htmlFor={`${baseId}-search`} className="sr-only">
                {t('integrations.page.filters.search', 'Search integrations')}
              </label>
              <Icon
                name="search"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
              />
              <input
                id={`${baseId}-search`}
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('integrations.page.filters.searchPlaceholder', 'Search…')}
                className={`${FIELD} pl-8`}
              />
            </div>
            {categories.length > 0 && (
              <div className="sm:w-48">
                <label htmlFor={`${baseId}-category`} className="sr-only">
                  {t('integrations.page.filters.category', 'Category')}
                </label>
                <select
                  id={`${baseId}-category`}
                  value={category}
                  onChange={event => setCategory(event.target.value)}
                  className={FIELD}
                >
                  <option value="">
                    {t('integrations.page.filters.allCategories', 'All categories')}
                  </option>
                  {categories.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="sm:w-48">
              <label htmlFor={`${baseId}-status`} className="sr-only">
                {t('integrations.page.filters.status', 'Status')}
              </label>
              <select
                id={`${baseId}-status`}
                value={status}
                onChange={event => setStatus(event.target.value)}
                className={FIELD}
              >
                <option value={STATUS_FILTERS.ALL}>
                  {t('integrations.page.filters.allStatuses', 'All statuses')}
                </option>
                <option value={STATUS_FILTERS.ATTENTION}>
                  {t('integrations.page.filters.needsAttention', 'Needs attention')}
                </option>
              </select>
            </div>
          </div>

          <p
            role="status"
            className={filtering ? 'text-sm text-gray-600 dark:text-gray-400' : 'sr-only'}
          >
            {filtering
              ? shown.length === 0
                ? t('integrations.page.filters.noMatches', 'No integration matches the filters.')
                : t('integrations.page.filters.count', 'Showing {{shown}} of {{total}}', {
                    shown: shown.length,
                    total: entries.length
                  })
              : ''}
          </p>

          {shown.length > 0 && (
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {shown.map(entry => (
                <IntegrationRow
                  key={entry.id}
                  entry={entry}
                  busy={busyId === entry.id}
                  onOpen={item => setOpenId(item.id)}
                  onConnect={handleConnect}
                  onDisconnect={setPendingDisconnect}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {openEntry && (
        <IntegrationDetailDrawer
          entry={openEntry}
          busy={busyId === openEntry.id}
          onClose={() => setOpenId(null)}
          onConnect={handleConnect}
          onDisconnect={setPendingDisconnect}
        />
      )}

      <ConfirmDialog
        isOpen={!!pendingDisconnect}
        title={t('integrations.page.disconnectTitle', 'Disconnect {{name}}', {
          name: nameOf(pendingDisconnect)
        })}
        message={t(
          'integrations.page.disconnectConfirm',
          'iHub will no longer act as you in {{name}}. Chats that need it will ask you to connect again.',
          { name: nameOf(pendingDisconnect) }
        )}
        confirmLabel={t('integrations.page.disconnect', 'Disconnect')}
        danger
        onConfirm={() => handleDisconnect(pendingDisconnect)}
        onDeny={() => setPendingDisconnect(null)}
      />
    </section>
  );
}
