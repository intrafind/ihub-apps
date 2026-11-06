// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import IntegrationLogo from './IntegrationLogo';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './integrationButtons';
import { fetchRequestableIntegrations, requestIntegration } from '../../../api/userIntegrationsApi';

/** Longest reason the server takes. */
export const MAX_REASON_LENGTH = 500;
/** From this many entries on, the list gets a search box. */
const SEARCH_FROM = 6;
/** Cards shown before "Show all"; a search shows every match. */
const COLLAPSED_COUNT = 6;

const FIELD =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-400';

const PILL = 'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium';
const PILL_REQUESTED = `${PILL} bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200`;
const PILL_APPROVED = `${PILL} bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200`;
const PILL_DECLINED = `${PILL} bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200`;

/** Whether the user's request still waits for an admin (or the install). */
export function isRequested(item) {
  return item?.request?.status === 'open' || item?.request?.status === 'approved';
}

function matches(item, query) {
  if (!query) return true;
  return [item.name, item.description, item.publisher, item.definition, ...(item.categories || [])]
    .filter(text => typeof text === 'string')
    .some(text => text.toLowerCase().includes(query));
}

/**
 * The state of the user's request, as a pill: _Requested_, _Approved_
 * (an admin is setting it up) or _Declined_.
 */
function RequestState({ request }) {
  const { t } = useTranslation();
  if (!request) return null;
  if (request.status === 'open') {
    return (
      <span className={PILL_REQUESTED} data-testid="request-state">
        <Icon name="clock" className="h-3.5 w-3.5" />
        {t('integrations.requests.state.requested', 'Requested')}
      </span>
    );
  }
  if (request.status === 'approved') {
    return (
      <span className={PILL_APPROVED} data-testid="request-state">
        <Icon name="check" className="h-3.5 w-3.5" />
        {t('integrations.requests.state.approved', 'Approved, being set up')}
      </span>
    );
  }
  if (request.status === 'declined') {
    return (
      <span className={PILL_DECLINED} data-testid="request-state">
        {t('integrations.requests.state.declined', 'Declined')}
      </span>
    );
  }
  return null;
}

/**
 * "Not available yet" on Settings → Integrations (#2926): the catalog
 * integrations the user's groups cannot use yet, read-only, with **Request**, as a compact card grid like the
 * marketplace: the first few cards, then **Show all**.
 * Requesting asks for an optional reason; afterwards the row shows
 * _Requested_ until an admin decides (_Approved, being set up_ or _Declined_,
 * with the admin's note). A declined integration can be asked for again.
 *
 * Loads its own list (`GET /api/integrations/requests`); renders nothing while
 * it loads, when it cannot be read, or when the catalog holds nothing more.
 *
 * @param {Object} props
 * @param {(message: {type: 'success'|'error', text: string}) => void} props.onMessage
 */
export default function RequestableIntegrations({ onMessage }) {
  const { t } = useTranslation();
  const baseId = useId();
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(null); // definition id with the reason form open
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRequestableIntegrations()
      .then(list => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const normalized = query.trim().toLowerCase();
  const shown = useMemo(
    () => (items || []).filter(item => matches(item, normalized)),
    [items, normalized]
  );

  if (!items || items.length === 0) return null;

  // A search shows every match; otherwise the grid stays short until expanded.
  const collapsible = !normalized && shown.length > COLLAPSED_COUNT;
  const visible = collapsible && !expanded ? shown.slice(0, COLLAPSED_COUNT) : shown;

  const openForm = item => {
    setComposing(item.definition);
    setReason('');
  };

  const send = async item => {
    setBusy(item.definition);
    try {
      const request = await requestIntegration(item.definition, reason);
      setItems(list =>
        list.map(entry => (entry.definition === item.definition ? { ...entry, request } : entry))
      );
      setComposing(null);
      onMessage({
        type: 'success',
        text: t(
          'integrations.requests.sent',
          'Request for {{name}} sent. An administrator decides.',
          { name: item.name }
        )
      });
    } catch (error) {
      const code = error?.response?.data?.code;
      if (code === 'REQUEST_EXISTS') {
        // Already asked (another tab): show it as requested.
        setItems(list =>
          list.map(entry =>
            entry.definition === item.definition
              ? { ...entry, request: { ...(entry.request || {}), status: 'open' } }
              : entry
          )
        );
        setComposing(null);
      }
      onMessage({
        type: 'error',
        text:
          code === 'REQUEST_EXISTS'
            ? t('integrations.requests.alreadyRequested', 'You have already requested {{name}}.', {
                name: item.name
              })
            : t('integrations.requests.failed', 'Could not request {{name}}: {{message}}', {
                name: item.name,
                message: error?.response?.data?.detail || error?.message || ''
              })
      });
    } finally {
      setBusy(null);
    }
  };

  const headingId = `${baseId}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4"
      data-testid="requestable-integrations"
    >
      <div>
        <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('integrations.requests.title', 'Not available yet ({{count}})', {
            count: items.length
          })}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'integrations.requests.description',
            'Integrations in the catalog that your administrator has not made available to you. Request one and an administrator decides.'
          )}
        </p>
      </div>

      {items.length >= SEARCH_FROM && (
        <div className="relative" role="search">
          <label htmlFor={`${baseId}-search`} className="sr-only">
            {t('integrations.requests.search', 'Search the catalog')}
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
      )}

      {shown.length === 0 ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
          {t('integrations.requests.noMatches', 'Nothing in the catalog matches.')}
        </p>
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map(item => {
              const requested = isRequested(item);
              const formOpen = composing === item.definition;
              const reasonId = `${baseId}-${item.definition}-reason`;
              const declined = item.request?.status === 'declined';
              return (
                <li
                  key={item.definition}
                  className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-600"
                  data-testid="requestable-row"
                  data-definition={item.definition}
                >
                  <div className="flex items-start gap-3">
                    <IntegrationLogo
                      entry={{ id: item.definition, name: item.name, icon: item.icon }}
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words text-base font-semibold text-gray-900 dark:text-gray-100">
                        {item.name}
                      </h3>
                      {item.publisher && (
                        <p className="break-words text-xs text-gray-600 dark:text-gray-400">
                          {t('integrations.requests.publisher', 'by {{publisher}}', {
                            publisher: item.publisher
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                  {item.description && (
                    <p className="mt-3 break-words text-sm text-gray-600 dark:text-gray-400">
                      {item.description}
                    </p>
                  )}
                  {declined && item.request.note && (
                    <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('integrations.requests.adminNote', 'Administrator: {{note}}', {
                        note: item.request.note
                      })}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
                    <RequestState request={item.request} />
                    {!requested && !formOpen && (
                      <button
                        type="button"
                        className={`${PRIMARY_BUTTON} ml-auto`}
                        disabled={busy === item.definition}
                        onClick={() => openForm(item)}
                        aria-label={
                          declined
                            ? t(
                                'integrations.requests.requestAgainNamed',
                                'Request {{name}} again',
                                {
                                  name: item.name
                                }
                              )
                            : t('integrations.requests.requestNamed', 'Request {{name}}', {
                                name: item.name
                              })
                        }
                      >
                        {declined
                          ? t('integrations.requests.requestAgain', 'Request again')
                          : t('integrations.requests.request', 'Request')}
                      </button>
                    )}
                  </div>
                  {formOpen && (
                    <form
                      className="mt-3 space-y-2"
                      onSubmit={event => {
                        event.preventDefault();
                        void send(item);
                      }}
                    >
                      <label
                        htmlFor={reasonId}
                        className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                      >
                        {t('integrations.requests.reasonLabel', 'Why do you need it? (optional)')}
                      </label>
                      <textarea
                        id={reasonId}
                        rows={2}
                        maxLength={MAX_REASON_LENGTH}
                        value={reason}
                        onChange={event => setReason(event.target.value)}
                        aria-describedby={`${reasonId}-count`}
                        className={FIELD}
                      />
                      <p
                        id={`${reasonId}-count`}
                        className="text-xs text-gray-600 dark:text-gray-400"
                      >
                        {t('integrations.requests.reasonCount', '{{count}} of {{max}} characters', {
                          count: reason.length,
                          max: MAX_REASON_LENGTH
                        })}
                      </p>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          onClick={() => setComposing(null)}
                        >
                          {t('common.cancel', 'Cancel')}
                        </button>
                        <button
                          type="submit"
                          className={PRIMARY_BUTTON}
                          disabled={busy === item.definition}
                        >
                          {t('integrations.requests.send', 'Send request')}
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>

          {collapsible && (
            <div className="flex justify-center">
              <button
                type="button"
                className={SECONDARY_BUTTON}
                aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}
              >
                {expanded
                  ? t('integrations.requests.showFewer', 'Show fewer')
                  : t('integrations.requests.showAll', 'Show all {{count}}', {
                      count: shown.length
                    })}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
