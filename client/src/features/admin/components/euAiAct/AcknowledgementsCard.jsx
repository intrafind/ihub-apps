// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import useAiAcknowledgementAdmin from '../../hooks/useAiAcknowledgementAdmin';
import AiAcknowledgementActions from '../AiAcknowledgementActions';
import EuAiActCard from './EuAiActCard';
import PausedNote from './PausedNote';

function Figure({ label, value, children }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-4">
      <dt className="text-xs text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
        {value}
        {children}
      </dd>
    </div>
  );
}

/**
 * Card 2: counts and the actions of the users page (request again, remove all,
 * CSV). The actions and their confirmations are the shared hook and menu, so
 * the two pages cannot drift. Counts cover registered users only.
 */
export default function AcknowledgementsCard({ acknowledgements, onChanged, paused = false }) {
  const { t } = useTranslation();
  const admin = useAiAcknowledgementAdmin({ onChanged });
  const counts = acknowledgements?.counts;
  // Master switch off: the counts stay (the data is kept) and the export works; the
  // delete and reset actions are disabled. The feature's own off state is different.
  const enabled = paused ? acknowledgements?.configuredEnabled : acknowledgements?.enabled;

  return (
    <EuAiActCard
      id="acknowledgements"
      title={t('admin.euAiAct.ack.title', 'Acknowledgements')}
      description={t(
        'admin.euAiAct.ack.description',
        'Users confirm a short AI-use statement before their first message. Counts cover registered users; anonymous visitors are only in the audit log.'
      )}
      actions={
        <>
          <Link
            to="/admin/users"
            className="text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
          >
            {t('admin.euAiAct.ack.openUsers', 'Open users list')}
          </Link>
          {(enabled || paused) && (
            <AiAcknowledgementActions admin={admin} confirmedCount={counts?.acknowledged ?? 0} />
          )}
        </>
      }
    >
      {paused && <PausedNote />}
      {!acknowledgements ? null : !enabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="neutral" icon={<Icon name="minus-circle" size="sm" />}>
            {t('admin.euAiAct.ack.off', 'Acknowledgement is switched off')}
          </Badge>
          <a
            href="#ai-acknowledgement"
            className="text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline"
          >
            {t('admin.euAiAct.fix.openAdvanced', 'Open settings')}
          </a>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Figure
              label={t('admin.euAiAct.ack.acknowledged', 'Acknowledged')}
              value={counts.acknowledged}
            />
            <Figure label={t('admin.euAiAct.ack.pending', 'Pending')} value={counts.pending}>
              {counts.pending > 0 && (
                <Badge tone="warning" icon={<Icon name="clock" size="sm" />}>
                  {t('admin.euAiAct.ack.pendingBadge', 'Not yet confirmed')}
                </Badge>
              )}
            </Figure>
            <Figure label={t('admin.euAiAct.ack.total', 'Total')} value={counts.total} />
          </dl>
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            {acknowledgements.enforced
              ? t('admin.euAiAct.ack.modeEnforced', 'Enforced, version {{version}}.', {
                  version: acknowledgements.requiredVersion
                })
              : t(
                  'admin.euAiAct.ack.modeAskOnly',
                  'Users are asked but not blocked (not enforced), version {{version}}.',
                  { version: acknowledgements.requiredVersion }
                )}{' '}
            {t(
              'admin.euAiAct.ack.pendingDefinition',
              'Pending: users below the required version, including those never asked.'
            )}
          </p>
        </>
      )}
      <div role="status" aria-live="polite" className="mt-3">
        {admin.message && (
          <p
            className={`text-sm ${
              admin.message.type === 'error'
                ? 'text-red-700 dark:text-red-300'
                : 'text-green-800 dark:text-green-300'
            }`}
          >
            {admin.message.text}
          </p>
        )}
      </div>
    </EuAiActCard>
  );
}
