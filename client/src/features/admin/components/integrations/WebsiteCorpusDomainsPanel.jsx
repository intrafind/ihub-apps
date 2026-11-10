// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';
import AdminLoadError from '../AdminLoadError';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';
import {
  addWebsiteCorpusDomain,
  approveWebsiteCorpusDomain,
  declineWebsiteCorpusDomain,
  fetchWebsiteCorpusDomains,
  removeWebsiteCorpusDomain
} from '../../../../api/websiteCorpusAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import { announceWebsiteCorpusDomainCount } from '../../hooks/useIntegrationRequestCount';

/** Longest note the server takes. */
const MAX_NOTE_LENGTH = 500;

const CARD =
  'rounded-lg border border-gray-200 bg-white p-4 shadow-xs dark:border-gray-700 dark:bg-gray-800';

function formatDate(value, language) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(language);
  } catch {
    return String(value);
  }
}

/**
 * Internal websites for the Website Corpus, in the **Requests** tab of
 * Admin → Integrations.
 *
 * The SSRF guard refuses company-internal addresses. A user whose crawl was
 * refused asks for the host; here an admin approves or declines it, adds a host
 * directly (a wildcard such as `*.corp.example` is allowed), or withdraws an
 * approval. An approval lets the Website Corpus reach that host only: the
 * platform-wide `ssrf.allowedHosts` is not touched.
 *
 * Loads its own data from `GET /api/admin/website-corpus/domains`.
 */
export default function WebsiteCorpusDomainsPanel() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null); // { tone: 'ok'|'error', text }
  const [notes, setNotes] = useState({});
  const [host, setHost] = useState('');
  const [hostNote, setHostNote] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await fetchWebsiteCorpusDomains();
      setData(result);
      setFailed(false);
      announceWebsiteCorpusDomainCount(result?.openCount || 0);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Run one change, then reload; the outcome goes to the live region. */
  const run = async (id, action, success) => {
    setBusy(id);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: 'ok', text: success });
      await load();
    } catch (error) {
      setMessage({ tone: 'error', text: getAdminApiErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const noteOf = id => notes[id]?.trim() || undefined;
  const setNote = (id, value) => setNotes(previous => ({ ...previous, [id]: value }));

  const items = data?.items || [];
  const open = items.filter(entry => entry.status === 'requested');
  const decided = items.filter(entry => entry.status !== 'requested');

  const addHost = async event => {
    event.preventDefault();
    const name = host.trim();
    if (!name) return;
    await run(
      'add',
      () => addWebsiteCorpusDomain(name, { note: hostNote.trim() || undefined }),
      t('admin.websiteCorpusDomains.added', '{{host}} is allowed now.', { host: name })
    );
    setHost('');
    setHostNote('');
  };

  const requesters = entry =>
    entry.requesters.map(request => request.name || request.userId).join(', ');

  return (
    <section aria-labelledby="website-corpus-domains" className="mt-10 space-y-4">
      <div>
        <h2
          id="website-corpus-domains"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.websiteCorpusDomains.title', 'Internal websites for the Website Corpus')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.websiteCorpusDomains.description',
            'The server refuses company-internal addresses. Users whose crawl was refused can ask for the host here. An approval lets the Website Corpus reach that host only; other tools keep the public-addresses-only rule. Loopback, link-local and cloud metadata addresses can never be allowed.'
          )}
        </p>
      </div>

      <div role="status" aria-live="polite" className="min-h-[1.25rem] text-sm">
        {message && (
          <p
            className={
              message.tone === 'error'
                ? 'text-red-700 dark:text-red-400'
                : 'text-green-700 dark:text-green-400'
            }
          >
            {message.text}
          </p>
        )}
      </div>

      {failed && (
        <AdminLoadError
          message={t(
            'admin.websiteCorpusDomains.loadFailed',
            'The internal websites could not be loaded.'
          )}
          framed={false}
        />
      )}
      {!data && !failed && (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      )}

      {data && (
        <>
          <div>
            <h3 className="mb-2 text-base font-medium text-gray-900 dark:text-gray-100">
              {t('admin.websiteCorpusDomains.openTitle', 'Open requests ({{count}})', {
                count: open.length
              })}
            </h3>
            {open.length === 0 ? (
              <p
                className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400"
                data-testid="no-open-domain-requests"
              >
                {t('admin.websiteCorpusDomains.none', 'No open requests.')}
              </p>
            ) : (
              <ul className="space-y-3">
                {open.map(entry => (
                  <li key={entry.id} className={CARD} data-testid="domain-request">
                    <div className="flex flex-col gap-3">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {entry.host}
                        </p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                          {t(
                            'admin.websiteCorpusDomains.requestedBy',
                            'Requested by {{names}} on {{date}}',
                            {
                              names: requesters(entry),
                              date: formatDate(entry.createdAt, i18n.language)
                            }
                          )}
                        </p>
                        <ul className="mt-2 space-y-1 text-sm text-gray-700 dark:text-gray-300">
                          {entry.requesters
                            .filter(request => request.reason)
                            .map(request => (
                              <li key={request.userId}>
                                <span className="font-medium">
                                  {request.name || request.userId}:
                                </span>{' '}
                                {request.reason}
                              </li>
                            ))}
                        </ul>
                      </div>
                      <div>
                        <label htmlFor={`note-${entry.id}`} className={LABEL_CLASS}>
                          {t(
                            'admin.websiteCorpusDomains.noteLabel',
                            'Note for the requesters (optional)'
                          )}
                        </label>
                        <input
                          id={`note-${entry.id}`}
                          type="text"
                          maxLength={MAX_NOTE_LENGTH}
                          value={notes[entry.id] || ''}
                          onChange={event => setNote(entry.id, event.target.value)}
                          className={INPUT_CLASS}
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={PRIMARY_BUTTON_CLASS}
                          disabled={busy === entry.id}
                          onClick={() =>
                            run(
                              entry.id,
                              () =>
                                approveWebsiteCorpusDomain(entry.id, { note: noteOf(entry.id) }),
                              t('admin.websiteCorpusDomains.approved', '{{host}} is approved.', {
                                host: entry.host
                              })
                            )
                          }
                        >
                          {t('admin.websiteCorpusDomains.approveNamed', 'Approve {{host}}', {
                            host: entry.host
                          })}
                        </button>
                        <button
                          type="button"
                          className={SECONDARY_BUTTON_CLASS}
                          disabled={busy === entry.id}
                          onClick={() =>
                            run(
                              entry.id,
                              () =>
                                declineWebsiteCorpusDomain(entry.id, { note: noteOf(entry.id) }),
                              t('admin.websiteCorpusDomains.declined', '{{host}} is declined.', {
                                host: entry.host
                              })
                            )
                          }
                        >
                          {t('admin.websiteCorpusDomains.declineNamed', 'Decline {{host}}', {
                            host: entry.host
                          })}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-base font-medium text-gray-900 dark:text-gray-100">
              {t('admin.websiteCorpusDomains.decidedTitle', 'Approved and declined ({{count}})', {
                count: decided.length
              })}
            </h3>
            {decided.length === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('admin.websiteCorpusDomains.noneDecided', 'No hosts yet.')}
              </p>
            ) : (
              <ul className="space-y-2">
                {decided.map(entry => (
                  <li
                    key={entry.id}
                    className={`${CARD} flex flex-wrap items-center justify-between gap-3`}
                    data-testid="domain-decided"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-sm text-gray-900 dark:text-gray-100">
                          {entry.host}
                        </span>
                        {entry.status === 'approved' ? (
                          <Badge tone="success">
                            {t('admin.websiteCorpusDomains.status.approved', 'Approved')}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">
                            {t('admin.websiteCorpusDomains.status.declined', 'Declined')}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                        {t('admin.websiteCorpusDomains.decidedBy', '{{name}} on {{date}}', {
                          name: entry.decidedBy?.name || entry.decidedBy?.id || '',
                          date: formatDate(entry.decidedAt, i18n.language)
                        })}
                        {entry.note ? ` · ${entry.note}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {entry.status === 'declined' && (
                        <button
                          type="button"
                          className={SECONDARY_BUTTON_CLASS}
                          disabled={busy === entry.id}
                          onClick={() =>
                            run(
                              entry.id,
                              () => approveWebsiteCorpusDomain(entry.id),
                              t('admin.websiteCorpusDomains.approved', '{{host}} is approved.', {
                                host: entry.host
                              })
                            )
                          }
                        >
                          {t('admin.websiteCorpusDomains.approveNamed', 'Approve {{host}}', {
                            host: entry.host
                          })}
                        </button>
                      )}
                      <button
                        type="button"
                        className={SECONDARY_BUTTON_CLASS}
                        disabled={busy === entry.id}
                        onClick={() =>
                          run(
                            entry.id,
                            () => removeWebsiteCorpusDomain(entry.id),
                            t('admin.websiteCorpusDomains.removed', '{{host}} is removed.', {
                              host: entry.host
                            })
                          )
                        }
                      >
                        {entry.status === 'approved'
                          ? t('admin.websiteCorpusDomains.withdrawNamed', 'Withdraw {{host}}', {
                              host: entry.host
                            })
                          : t('admin.websiteCorpusDomains.removeNamed', 'Remove {{host}}', {
                              host: entry.host
                            })}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form onSubmit={addHost} className={`${CARD} space-y-3`}>
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              {t('admin.websiteCorpusDomains.addTitle', 'Allow a host without a request')}
            </h3>
            <div>
              <label htmlFor="website-corpus-add-host" className={LABEL_CLASS}>
                {t('admin.websiteCorpusDomains.hostLabel', 'Host')}
              </label>
              <input
                id="website-corpus-add-host"
                type="text"
                value={host}
                onChange={event => setHost(event.target.value)}
                className={INPUT_CLASS}
                placeholder="wiki.corp.example"
                aria-describedby="website-corpus-add-host-help"
              />
              <p
                id="website-corpus-add-host-help"
                className="mt-1 text-xs text-gray-600 dark:text-gray-400"
              >
                {t(
                  'admin.websiteCorpusDomains.hostHelp',
                  'A host name or address, or a wildcard such as *.corp.example for every host below a domain.'
                )}
              </p>
            </div>
            <div>
              <label htmlFor="website-corpus-add-note" className={LABEL_CLASS}>
                {t('admin.websiteCorpusDomains.addNoteLabel', 'Note (optional)')}
              </label>
              <input
                id="website-corpus-add-note"
                type="text"
                maxLength={MAX_NOTE_LENGTH}
                value={hostNote}
                onChange={event => setHostNote(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <button
              type="submit"
              className={PRIMARY_BUTTON_CLASS}
              disabled={busy === 'add' || !host.trim()}
            >
              {t('admin.websiteCorpusDomains.add', 'Allow host')}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
