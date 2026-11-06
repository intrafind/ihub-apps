// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';
import Drawer from '../../../shared/components/Drawer';
import { describeAuditEntryGroups, otherAuditEntryDetails } from '../utils/auditEntryGroups';
import { getAuditActorLink, getAuditResourceLink } from '../utils/auditLinks';

function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toLocaleString();
}

function GroupChips({ groups, tone = 'default', emptyLabel }) {
  if (!groups || groups.length === 0) {
    return <p className="text-sm italic text-gray-500 dark:text-gray-400">{emptyLabel}</p>;
  }
  const toneClass =
    tone === 'mapped'
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800'
      : 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600';
  return (
    <ul className="flex flex-wrap gap-1.5">
      {groups.map(group => (
        <li
          key={group}
          className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium break-all ${toneClass}`}
        >
          {group}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {hint && <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-1.5">
      <dt className="text-sm text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="col-span-2 text-sm text-gray-900 dark:text-gray-100 break-all">
        {children ?? '-'}
      </dd>
    </div>
  );
}

/** Groups from the identity provider, each with the iHub groups it mapped to. */
function ExternalGroupsTable({ groups, t }) {
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              {t('admin.auditLog.details.providerGroup', 'Provider group')}
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              {t('admin.auditLog.details.mapsTo', 'Maps to')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {groups.map(group => (
            <tr key={group.name}>
              <td className="px-3 py-2 align-top font-mono text-xs text-gray-900 dark:text-gray-100 break-all">
                {group.name}
              </td>
              <td className="px-3 py-2 align-top">
                {group.mappedTo.length > 0 ? (
                  <GroupChips groups={group.mappedTo} tone="mapped" />
                ) : (
                  <span className="text-xs italic text-gray-500 dark:text-gray-400">
                    {t('admin.auditLog.details.notMapped', 'Not mapped')}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupsSection({ groups, t }) {
  const none = t('admin.auditLog.details.noGroups', 'None');
  return (
    <div className="space-y-5">
      <Section
        title={t('admin.auditLog.details.effectiveGroups', 'Effective groups')}
        hint={t(
          'admin.auditLog.details.effectiveGroupsHint',
          'The groups the user had for this action.'
        )}
      >
        <GroupChips groups={groups.effective} emptyLabel={none} />
      </Section>

      {groups.hasSources && (
        <>
          <Section
            title={t('admin.auditLog.details.providerGroups', 'Groups from the identity provider')}
            hint={
              groups.externalTotal > 0
                ? t(
                    'admin.auditLog.details.providerGroupsCount',
                    '{{total}} received, {{mapped}} mapped to iHub groups',
                    { total: groups.externalTotal, mapped: groups.mappedCount }
                  )
                : undefined
            }
          >
            {groups.external.length > 0 ? (
              <>
                <ExternalGroupsTable groups={groups.external} t={t} />
                {groups.externalTotal > groups.external.length && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.auditLog.details.providerGroupsTruncated',
                      'Showing the first {{shown}} of {{total}} groups.',
                      { shown: groups.external.length, total: groups.externalTotal }
                    )}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm italic text-gray-500 dark:text-gray-400">
                {t(
                  'admin.auditLog.details.noProviderGroups',
                  'The identity provider sent no groups.'
                )}
              </p>
            )}
          </Section>

          <Section
            title={t('admin.auditLog.details.manualGroups', 'Assigned manually')}
            hint={t(
              'admin.auditLog.details.manualGroupsHint',
              'Groups an admin assigned to the user under Users.'
            )}
          >
            <GroupChips groups={groups.manual} emptyLabel={none} />
          </Section>

          {groups.automatic.length > 0 && (
            <Section
              title={t('admin.auditLog.details.automaticGroups', 'Added automatically')}
              hint={t(
                'admin.auditLog.details.automaticGroupsHint',
                'Groups every signed-in user or every user of this provider receives.'
              )}
            >
              <GroupChips groups={groups.automatic} emptyLabel={none} />
            </Section>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.auditLog.details.groupsRecordedAtLogin',
              'Recorded at sign-in. Changes in the identity provider apply from the next sign-in.'
            )}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * AuditEntryDetailDrawer — everything one audit entry recorded, opened from a
 * row of the audit log. For a sign-in through an external identity provider it
 * also shows the groups the provider sent, what each mapped to, and the groups
 * assigned by hand.
 *
 * @param {Object} props
 * @param {Object|null} props.entry - The entry to show; the drawer is closed when null.
 * @param {() => void} props.onClose
 * @param {(field: string, value: string) => string} [props.valueLabel] - Translates
 *   closed vocabularies (action, result, source).
 */
function AuditEntryDetailDrawer({ entry, onClose, valueLabel = (_field, value) => value }) {
  const { t } = useTranslation();
  const groups = entry ? describeAuditEntryGroups(entry) : null;
  const otherDetails = entry ? otherAuditEntryDetails(entry) : null;
  const actorHref = entry ? getAuditActorLink(entry) : null;
  const resourceHref = entry ? getAuditResourceLink(entry) : null;
  const actorLabel = entry?.actor?.displayName ?? entry?.actor?.username ?? entry?.admin ?? '-';

  return (
    <Drawer
      isOpen={Boolean(entry)}
      onClose={onClose}
      title={t('admin.auditLog.details.title', 'Audit entry')}
      icon={<DocumentMagnifyingGlassIcon className="h-5 w-5 text-indigo-500" />}
      description={entry ? formatTimestamp(entry.ts) : undefined}
      size="lg"
      bodyClassName="px-5 py-4"
      data-testid="audit-entry-detail"
    >
      {entry && (
        <div className="space-y-6">
          {entry.summary && (
            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap wrap-break-word">
              {entry.summary}
            </p>
          )}

          <dl className="divide-y divide-gray-100 dark:divide-gray-800">
            <Field label={t('admin.auditLog.actorColumn', 'Actor')}>
              {actorHref ? (
                <Link
                  to={actorHref}
                  onClick={onClose}
                  className="text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {actorLabel}
                </Link>
              ) : (
                actorLabel
              )}
              {entry.actor?.id && entry.actor.id !== actorLabel && (
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {entry.actor.id}
                </span>
              )}
            </Field>
            <Field label={t('admin.auditLog.actionColumn', 'Action')}>
              {entry.action ? valueLabel('action', entry.action) : null}
            </Field>
            <Field label={t('admin.auditLog.resultColumn', 'Result')}>
              {valueLabel('result', entry.result ?? 'success')}
            </Field>
            <Field label={t('admin.auditLog.resourceColumn', 'Resource')}>
              {entry.resource || null}
              {entry.resourceId && (
                <span className="block text-xs">
                  {resourceHref ? (
                    <Link
                      to={resourceHref}
                      onClick={onClose}
                      className="text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      {entry.resourceId}
                    </Link>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400">{entry.resourceId}</span>
                  )}
                </span>
              )}
            </Field>
            <Field label={t('admin.auditLog.sourceColumn', 'Source')}>
              {entry.source ? valueLabel('source', entry.source) : null}
            </Field>
            {'ip' in entry && (
              <Field label={t('admin.auditLog.details.ip', 'IP address')}>{entry.ip || null}</Field>
            )}
            <Field label={t('admin.auditLog.details.requestId', 'Request ID')}>
              {entry.requestId ? (
                <span className="font-mono text-xs">{entry.requestId}</span>
              ) : null}
            </Field>
            <Field label={t('admin.auditLog.details.entryId', 'Entry ID')}>
              {entry.id ? <span className="font-mono text-xs">{entry.id}</span> : null}
            </Field>
          </dl>

          {groups && <GroupsSection groups={groups} t={t} />}

          {otherDetails && (
            <Section title={t('admin.auditLog.details.moreDetails', 'More details')}>
              <pre className="max-h-80 overflow-auto rounded-md bg-gray-50 dark:bg-gray-800 p-3 text-xs text-gray-800 dark:text-gray-200">
                {JSON.stringify(otherDetails, null, 2)}
              </pre>
            </Section>
          )}

          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
              {t('admin.auditLog.details.rawEntry', 'Raw entry (JSON)')}
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-gray-50 dark:bg-gray-800 p-3 text-xs text-gray-800 dark:text-gray-200">
              {JSON.stringify(entry, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </Drawer>
  );
}

export default AuditEntryDetailDrawer;
