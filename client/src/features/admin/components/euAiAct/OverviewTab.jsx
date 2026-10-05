import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  dismissComplianceWarning,
  restoreComplianceWarning
} from '../../../../api/aiTransparencyAdminApi';
import {
  CHECKLIST_LABEL_FALLBACKS,
  countChecklist,
  findOutdatedDismissal,
  splitWarnings
} from '../../utils/euAiAct';
import { CheckStatusBadge, SeverityBadge } from './ComplianceBadges';
import JustificationDialog from './JustificationDialog';
import RecordSummary from './RecordSummary';

const CARD =
  'bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Overview tab of the EU AI Act page: the conformance checklist (traffic light
 * per item, each with a link to where it is fixed), the active warnings with
 * "Dismiss…" for the dismissible ones, and the dismissed warnings with
 * "Restore".
 *
 * A dismissal only hides a warning from the start-page / admin-overview
 * banner for the state it was made for. It never changes the checklist or
 * the conformance status — the UI says so wherever dismissing is offered.
 *
 * @param {Object} props
 * @param {Object} props.status - `GET /admin/ai-transparency/status` response.
 * @param {() => Promise<unknown>} props.reload - Re-fetches the status.
 */
function OverviewTab({ status, reload }) {
  const { t } = useTranslation();
  const [dismissTarget, setDismissTarget] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  const [message, setMessage] = useState(null);

  const checklist = Array.isArray(status?.checklist) ? status.checklist : [];
  const counts = countChecklist(checklist);
  const { active, dismissed } = splitWarnings(status);
  const dismissalRecords = status?.records?.dismissals || [];

  const handleDismiss = async reason => {
    await dismissComplianceWarning(dismissTarget.id, reason);
    setMessage({
      type: 'success',
      text: t(
        'admin.euAiAct.overview.dismissed',
        'Warning dismissed. It no longer shows in the banner; the conformance status is unchanged.'
      )
    });
    await reload();
  };

  const handleRestore = async warning => {
    setRestoringId(warning.id);
    setMessage(null);
    try {
      await restoreComplianceWarning(warning.id);
      setMessage({
        type: 'success',
        text: t(
          'admin.euAiAct.overview.restored',
          'Warning restored. It shows in the banner again.'
        )
      });
      await reload();
    } catch (err) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(err) });
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Result of the last action, announced politely. */}
      <div aria-live="polite" role="status">
        {message && (
          <p
            className={`rounded-md border px-4 py-3 text-sm ${
              message.type === 'success'
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}
          >
            {message.text}
          </p>
        )}
      </div>

      {/* Checklist */}
      <section aria-labelledby="euaiact-checklist-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2
            id="euaiact-checklist-heading"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.euAiAct.overview.checklistTitle', 'Conformance checklist')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.euAiAct.overview.checklistSummary',
              'OK: {{ok}} of {{total}} · Warnings: {{warning}} · Errors: {{error}}',
              counts
            )}
          </p>
        </div>
        {checklist.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('admin.euAiAct.overview.checklistEmpty', 'No checklist items reported.')}
          </p>
        ) : (
          <ul className={`${CARD} divide-y divide-gray-200 dark:divide-gray-700`}>
            {checklist.map(item => {
              const label = t(
                `admin.euAiAct.checklist.${item.id}`,
                CHECKLIST_LABEL_FALLBACKS[item.id] || item.id
              );
              return (
                <li
                  key={item.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 sm:px-6 py-4"
                >
                  <div className="sm:w-28 shrink-0">
                    <CheckStatusBadge status={item.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
                    {item.detail && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5 break-words">
                        {item.detail}
                      </p>
                    )}
                  </div>
                  {item.fix && (
                    <Link
                      to={item.fix}
                      className="shrink-0 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm"
                    >
                      {item.status === 'ok'
                        ? t('admin.euAiAct.overview.configure', 'Configure')
                        : t('admin.euAiAct.overview.fix', 'Fix')}
                      <span className="sr-only">: {label}</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Active warnings */}
      <section aria-labelledby="euaiact-warnings-heading">
        <h2
          id="euaiact-warnings-heading"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1"
        >
          {t('admin.euAiAct.overview.warningsTitle', 'Warnings')}
        </h2>
        <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400 mb-3">
          <InformationCircleIcon className="h-5 w-5 shrink-0 text-blue-500" aria-hidden="true" />
          <span>
            {t(
              'admin.euAiAct.overview.dismissExplainer',
              'Admins see these warnings in a banner on the start page and the admin overview. Warnings about models, certificates and apps can be dismissed with a justification. A dismissal only hides the banner entry — it does not change the conformance status, and the warning comes back when the situation changes.'
            )}
          </span>
        </p>
        {active.length === 0 ? (
          <p className={`${CARD} px-6 py-4 text-sm text-gray-600 dark:text-gray-400`}>
            {t('admin.euAiAct.overview.noWarnings', 'There are no active warnings.')}
          </p>
        ) : (
          <ul className={`${CARD} divide-y divide-gray-200 dark:divide-gray-700`}>
            {active.map(warning => {
              const outdated = findOutdatedDismissal(warning, dismissalRecords);
              return (
                <li
                  key={warning.id}
                  className="flex flex-col sm:flex-row sm:items-start gap-3 px-4 sm:px-6 py-4"
                >
                  <div className="sm:w-28 shrink-0">
                    <SeverityBadge severity={warning.severity} />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm text-gray-900 dark:text-gray-100 break-words">
                      {warning.message}
                    </p>
                    {outdated && (
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        {t(
                          'admin.euAiAct.overview.outdatedDismissal',
                          'Dismissed earlier, but the situation has changed since, so the warning is back.'
                        )}
                      </p>
                    )}
                    {!warning.dismissible && (
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        {t(
                          'admin.euAiAct.overview.notDismissible',
                          'This warning cannot be dismissed. It disappears once the problem is fixed.'
                        )}
                      </p>
                    )}
                  </div>
                  {warning.dismissible && (
                    <button
                      type="button"
                      className={`${SECONDARY_BUTTON} shrink-0`}
                      onClick={() => {
                        setMessage(null);
                        setDismissTarget(warning);
                      }}
                    >
                      {t('admin.euAiAct.overview.dismiss', 'Dismiss…')}
                      <span className="sr-only">: {warning.message}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Dismissed warnings */}
      <section aria-labelledby="euaiact-dismissed-heading">
        <h2
          id="euaiact-dismissed-heading"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1"
        >
          {t('admin.euAiAct.overview.dismissedTitle', 'Dismissed warnings')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          {t(
            'admin.euAiAct.overview.dismissedDescription',
            'Hidden from the banner only. They still count in the checklist and appear in the compliance report.'
          )}
        </p>
        {dismissed.length === 0 ? (
          <p className={`${CARD} px-6 py-4 text-sm text-gray-600 dark:text-gray-400`}>
            {t('admin.euAiAct.overview.noDismissed', 'No warnings are dismissed.')}
          </p>
        ) : (
          <ul className={`${CARD} divide-y divide-gray-200 dark:divide-gray-700`}>
            {dismissed.map(warning => (
              <li
                key={warning.id}
                className="flex flex-col sm:flex-row sm:items-start gap-3 px-4 sm:px-6 py-4"
              >
                <div className="sm:w-28 shrink-0">
                  <SeverityBadge severity={warning.severity} />
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
                    {warning.message}
                  </p>
                  <RecordSummary
                    record={warning.dismissal}
                    reasonLabel={t('admin.euAiAct.record.justification', 'Justification')}
                  />
                </div>
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} shrink-0`}
                  onClick={() => handleRestore(warning)}
                  disabled={restoringId === warning.id}
                >
                  {restoringId === warning.id
                    ? t('admin.euAiAct.overview.restoring', 'Restoring…')
                    : t('admin.euAiAct.overview.restore', 'Restore')}
                  <span className="sr-only">: {warning.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <JustificationDialog
        open={Boolean(dismissTarget)}
        title={t('admin.euAiAct.dismissDialog.title', 'Dismiss warning')}
        description={
          <>
            <p className="font-medium text-gray-900 dark:text-gray-100">{dismissTarget?.message}</p>
            <p>
              {t(
                'admin.euAiAct.dismissDialog.description',
                'The warning is hidden from the banner for the current situation only. The conformance status does not change, and the warning comes back if the situation changes (for example when another unmarked model is enabled).'
              )}
            </p>
          </>
        }
        label={t('admin.euAiAct.dialog.justification', 'Justification')}
        submitLabel={t('admin.euAiAct.dismissDialog.submit', 'Dismiss warning')}
        onSubmit={handleDismiss}
        onClose={() => setDismissTarget(null)}
      />
    </div>
  );
}

export default OverviewTab;
