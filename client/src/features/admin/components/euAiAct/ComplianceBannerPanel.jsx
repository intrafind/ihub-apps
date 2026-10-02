import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { dismissComplianceWarning } from '../../../../api/aiTransparencyAdminApi';
import { useComplianceBanner } from '../../hooks/useComplianceBanner';
import { pickBannerWarnings } from '../../utils/euAiAct';
import { SeverityBadge } from './ComplianceBadges';
import JustificationDialog from './JustificationDialog';

/**
 * The visible part of the admin compliance banner. Loaded lazily by
 * `ComplianceBanner`, which has already checked that the user is an admin.
 *
 * Fetches `GET /admin/ai-transparency/banner` and renders nothing while there
 * are no active (undismissed) warnings, or when the request fails — the
 * banner must never break the page it sits on. Lists the first few warnings
 * (errors first) with "Dismiss…" for the dismissible ones and links to the
 * EU AI Act page for the rest.
 *
 * Uses `role="region"` with a label rather than `role="alert"`: the banner is
 * persistent page content, not an interruption.
 *
 * @param {Object} props
 * @param {string} [props.className] - Extra classes for the banner box.
 */
function ComplianceBannerPanel({ className = '' }) {
  const { t } = useTranslation();
  const headingId = useId();
  const { banner, reload } = useComplianceBanner({ enabled: true });
  const [dismissTarget, setDismissTarget] = useState(null);

  const warnings = Array.isArray(banner?.warnings) ? banner.warnings : [];
  if (warnings.length === 0) return null;

  const { shown, hiddenCount } = pickBannerWarnings(warnings);
  const hasErrors = warnings.some(w => w.severity === 'error');
  const tone = hasErrors
    ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
    : 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20';
  const iconTone = hasErrors
    ? 'text-red-600 dark:text-red-400'
    : 'text-amber-600 dark:text-amber-400';

  const handleDismiss = async reason => {
    await dismissComplianceWarning(dismissTarget.id, reason);
    await reload();
  };

  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className={`rounded-lg border px-4 py-3 text-left ${tone} ${className}`}
    >
      <div className="flex items-start gap-3">
        <ExclamationTriangleIcon
          className={`h-5 w-5 shrink-0 mt-0.5 ${iconTone}`}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          {/* A paragraph, not a heading: on the start page the banner sits above
              the page's h1, and it must not break the heading order. */}
          <p id={headingId} className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {banner?.conforming === false
              ? t(
                  'admin.euAiAct.banner.titleNonConforming',
                  'EU AI Act: this installation does not conform'
                )
              : t('admin.euAiAct.banner.title', 'EU AI Act: compliance warnings')}
            <span className="ml-2 font-normal text-gray-600 dark:text-gray-300">
              {t('admin.euAiAct.banner.count', '(open warnings: {{count}})', {
                count: warnings.length
              })}
            </span>
          </p>

          <ul className="mt-2 space-y-2">
            {shown.map(warning => (
              <li key={warning.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <SeverityBadge severity={warning.severity} />
                <span className="text-sm text-gray-800 dark:text-gray-100 min-w-0 break-words">
                  {warning.message}
                </span>
                {warning.dismissible && (
                  <button
                    type="button"
                    onClick={() => setDismissTarget(warning)}
                    className="text-xs font-medium text-gray-700 dark:text-gray-200 underline hover:no-underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm"
                  >
                    {t('admin.euAiAct.banner.dismiss', 'Dismiss…')}
                    <span className="sr-only">: {warning.message}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>

          {hiddenCount > 0 && (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {t('admin.euAiAct.banner.more', 'More warnings on the EU AI Act page: {{count}}', {
                count: hiddenCount
              })}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              to="/admin/eu-ai-act"
              className="text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm"
            >
              {t('admin.euAiAct.banner.open', 'Open EU AI Act page')}
            </Link>
            <span className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.euAiAct.banner.adminsOnly', 'Only administrators see this notice.')}
            </span>
          </div>
        </div>
      </div>

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

export default ComplianceBannerPanel;
