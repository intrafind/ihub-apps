// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import {
  DANGER_BUTTON_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';
import { Pill } from './IntegrationPills';

/** Longest note the server takes. */
const MAX_NOTE_LENGTH = 500;

const CARD =
  'rounded-lg border border-gray-200 bg-white p-4 shadow-xs dark:border-gray-700 dark:bg-gray-800';

/** Whether a request still waits for a decision or the install. */
export function isStandingRequest(request) {
  return request?.status === 'open' || request?.status === 'approved';
}

function formatDate(value, language) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(language);
  } catch {
    return String(value);
  }
}

function StatusPill({ status }) {
  const { t } = useTranslation();
  switch (status) {
    case 'open':
      return <Pill tone="blue">{t('admin.integrations.requests.status.open', 'Open')}</Pill>;
    case 'approved':
      return (
        <Pill tone="green">
          {t('admin.integrations.requests.status.approved', 'Approved, not installed yet')}
        </Pill>
      );
    case 'declined':
      return (
        <Pill tone="gray">{t('admin.integrations.requests.status.declined', 'Declined')}</Pill>
      );
    case 'fulfilled':
      return (
        <Pill tone="green">{t('admin.integrations.requests.status.fulfilled', 'Installed')}</Pill>
      );
    default:
      return <Pill>{status}</Pill>;
  }
}

/**
 * The **Requests** tab of Admin → Integrations (#2926): what users asked for.
 *
 * - **Open requests**: the definition, who asked, when and why. **Approve**
 *   opens the install wizard (an approved request keeps an **Install** button
 *   until it is installed); **Decline** and **Decline and hide** ask for an
 *   optional note to the requester first. When the definition is already
 *   installed, the row says so and links the installation: granting the
 *   requester's groups is often all that is needed.
 * - **Closed requests**: declined and installed ones, folded.
 * - **Hidden from users**: definitions declined and hidden, with **Show again**.
 *
 * @param {Object} props
 * @param {Object[]} props.requests - From `GET /api/admin/integrations/requests`
 * @param {Object[]} props.hidden
 * @param {string|null} [props.busyId] - A request or definition being changed
 * @param {(request: Object) => void} props.onApprove
 * @param {(request: Object, options: {note: string, hide: boolean}) => void} props.onDecline
 * @param {(definition: string) => void} props.onShow
 */
export default function IntegrationRequestsPanel({
  requests,
  hidden,
  busyId = null,
  onApprove,
  onDecline,
  onShow
}) {
  const { t, i18n } = useTranslation();
  const [declining, setDeclining] = useState(null); // { request, hide }
  const [note, setNote] = useState('');

  const standing = requests.filter(isStandingRequest);
  const closed = requests.filter(request => !isStandingRequest(request));

  const askDecline = (request, hide) => {
    setNote('');
    setDeclining({ request, hide });
  };

  const requesterOf = request => request.requester?.name || request.requester?.id || '';

  return (
    <div className="space-y-8">
      <section aria-labelledby="integration-requests-open">
        <h2
          id="integration-requests-open"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.integrations.requests.openTitle', 'Open requests ({{count}})', {
            count: standing.length
          })}
        </h2>
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.integrations.requests.description',
            'Users asked for these catalog integrations. Approve opens the install wizard; a request closes by itself once the integration is installed and the requester’s groups may use it.'
          )}
        </p>
        {standing.length === 0 ? (
          <p
            className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400"
            data-testid="no-open-requests"
          >
            {t('admin.integrations.requests.none', 'No open requests.')}
          </p>
        ) : (
          <ul className="space-y-3">
            {standing.map(request => (
              <li
                key={request.id}
                className={CARD}
                data-testid="integration-request"
                data-request={request.id}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                      {request.definitionName}
                      <span className="ml-2 font-mono text-xs font-normal text-gray-600 dark:text-gray-400">
                        {request.definition}
                      </span>
                    </h3>
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      {t(
                        'admin.integrations.requests.requestedBy',
                        'Requested by {{name}} on {{date}}',
                        {
                          name: requesterOf(request),
                          date: formatDate(request.createdAt, i18n.language)
                        }
                      )}
                    </p>
                    {request.reason && (
                      <blockquote className="mt-2 border-l-2 border-gray-300 pl-3 text-sm text-gray-700 italic dark:border-gray-600 dark:text-gray-300">
                        {request.reason}
                      </blockquote>
                    )}
                    {request.installedInstances?.length > 0 && (
                      <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                        {t(
                          'admin.integrations.requests.alreadyInstalled',
                          'Already installed, but not for this user’s groups. Granting their groups access closes the request:'
                        )}{' '}
                        {request.installedInstances.map((id, index) => (
                          <span key={id}>
                            {index > 0 && ', '}
                            <Link
                              to={`/admin/integrations/${encodeURIComponent(id)}`}
                              className="font-mono text-indigo-700 underline hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200"
                            >
                              {id}
                            </Link>
                          </span>
                        ))}
                      </p>
                    )}
                    {!request.definitionAvailable && (
                      <p className="mt-2 text-sm text-red-700 dark:text-red-300">
                        {t(
                          'admin.integrations.requests.definitionGone',
                          'This integration is no longer in the catalog.'
                        )}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
                    <StatusPill status={request.status} />
                    <button
                      type="button"
                      className={PRIMARY_BUTTON_CLASS}
                      disabled={busyId === request.id || !request.definitionAvailable}
                      onClick={() => onApprove(request)}
                      aria-label={
                        request.status === 'approved'
                          ? t('admin.integrations.requests.installNamed', 'Install {{name}}', {
                              name: request.definitionName
                            })
                          : t(
                              'admin.integrations.requests.approveNamed',
                              'Approve the request of {{user}} for {{name}}',
                              { user: requesterOf(request), name: request.definitionName }
                            )
                      }
                    >
                      {request.status === 'approved'
                        ? t('admin.integrations.requests.install', 'Install')
                        : t('admin.integrations.requests.approve', 'Approve')}
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON_CLASS}
                      disabled={busyId === request.id}
                      onClick={() => askDecline(request, false)}
                      aria-label={t(
                        'admin.integrations.requests.declineNamed',
                        'Decline the request of {{user}} for {{name}}',
                        { user: requesterOf(request), name: request.definitionName }
                      )}
                    >
                      {t('admin.integrations.requests.decline', 'Decline')}
                    </button>
                    <button
                      type="button"
                      className={DANGER_BUTTON_CLASS}
                      disabled={busyId === request.id}
                      onClick={() => askDecline(request, true)}
                      aria-label={t(
                        'admin.integrations.requests.declineHideNamed',
                        'Decline the request of {{user}} for {{name}} and hide it',
                        { user: requesterOf(request), name: request.definitionName }
                      )}
                    >
                      {t('admin.integrations.requests.declineHide', 'Decline and hide')}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section aria-labelledby="integration-requests-closed">
          <details>
            <summary className="cursor-pointer rounded-sm text-base font-semibold text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-100">
              <h2 id="integration-requests-closed" className="inline">
                {t('admin.integrations.requests.closedTitle', 'Closed requests ({{count}})', {
                  count: closed.length
                })}
              </h2>
            </summary>
            <ul className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {closed.map(request => (
                <li
                  key={request.id}
                  className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  data-testid="closed-request"
                >
                  <div className="min-w-0 text-gray-800 dark:text-gray-200">
                    <span className="font-medium">{request.definitionName}</span>
                    {' · '}
                    {requesterOf(request)}
                    {request.note && (
                      <span className="text-gray-600 dark:text-gray-400"> · “{request.note}”</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-gray-600 dark:text-gray-400">
                    <StatusPill status={request.status} />
                    <span>{formatDate(request.closedAt || request.updatedAt, i18n.language)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {hidden.length > 0 && (
        <section aria-labelledby="integration-requests-hidden">
          <h2
            id="integration-requests-hidden"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.integrations.requests.hiddenTitle', 'Hidden from users ({{count}})', {
              count: hidden.length
            })}
          </h2>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.integrations.requests.hiddenDescription',
              'Users do not see these in “Not available yet” and cannot request them.'
            )}
          </p>
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            {hidden.map(entry => (
              <li
                key={entry.definition}
                className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                data-testid="hidden-definition"
              >
                <div className="min-w-0 text-gray-800 dark:text-gray-200">
                  <span className="font-medium">{entry.name}</span>{' '}
                  <span className="font-mono text-xs text-gray-600 dark:text-gray-400">
                    {entry.definition}
                  </span>
                  <span className="block text-xs text-gray-600 dark:text-gray-400">
                    {t('admin.integrations.requests.hiddenBy', 'Hidden by {{name}} on {{date}}', {
                      name: entry.hiddenBy?.name || entry.hiddenBy?.id || '',
                      date: formatDate(entry.hiddenAt, i18n.language)
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS}
                  disabled={busyId === entry.definition}
                  onClick={() => onShow(entry.definition)}
                  aria-label={t('admin.integrations.requests.showNamed', 'Show {{name}} again', {
                    name: entry.name
                  })}
                >
                  {t('admin.integrations.requests.show', 'Show again')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        isOpen={Boolean(declining)}
        title={
          declining?.hide
            ? t('admin.integrations.requests.declineHideTitle', 'Decline and hide {{name}}?', {
                name: declining?.request.definitionName
              })
            : t('admin.integrations.requests.declineTitle', 'Decline the request for {{name}}?', {
                name: declining?.request.definitionName
              })
        }
        message={
          <div className="space-y-3">
            <p>
              {declining?.hide
                ? t(
                    'admin.integrations.requests.declineHideMessage',
                    'No user sees {{name}} in “Not available yet” any more, and the other open requests for it are declined too. You can show it again later.',
                    { name: declining?.request.definitionName }
                  )
                : t(
                    'admin.integrations.requests.declineMessage',
                    '{{user}} sees the request as declined and may ask again.',
                    { user: declining ? requesterOf(declining.request) : '' }
                  )}
            </p>
            <div>
              <label htmlFor="integration-request-note" className={LABEL_CLASS}>
                {t('admin.integrations.requests.noteLabel', 'Note to the requester (optional)')}
              </label>
              <textarea
                id="integration-request-note"
                rows={3}
                maxLength={MAX_NOTE_LENGTH}
                value={note}
                onChange={event => setNote(event.target.value)}
                className={INPUT_CLASS}
              />
              <p className={HELP_CLASS}>
                {t(
                  'admin.integrations.requests.noteHelp',
                  'Shown to the user next to the declined request.'
                )}
              </p>
            </div>
          </div>
        }
        confirmLabel={
          declining?.hide
            ? t('admin.integrations.requests.declineHide', 'Decline and hide')
            : t('admin.integrations.requests.decline', 'Decline')
        }
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={() => {
          const current = declining;
          setDeclining(null);
          if (current) onDecline(current.request, { note: note.trim(), hide: current.hide });
        }}
        onDeny={() => setDeclining(null)}
      />
    </div>
  );
}
