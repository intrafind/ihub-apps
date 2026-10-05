import { useTranslation } from 'react-i18next';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MinusCircleIcon,
  XCircleIcon
} from '@heroicons/react/24/outline';

/**
 * Status badges of the EU AI Act page. Every badge carries an icon AND a text
 * label, so the status never depends on colour alone (WCAG 1.4.1).
 *
 * @module features/admin/components/euAiAct/ComplianceBadges
 */

const TONES = {
  success:
    'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800',
  warning:
    'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800',
  error:
    'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800',
  neutral:
    'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600',
  info: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
};

const TONE_ICONS = {
  success: CheckCircleIcon,
  warning: ExclamationTriangleIcon,
  error: XCircleIcon,
  neutral: MinusCircleIcon,
  info: InformationCircleIcon
};

/**
 * Generic pill with icon + text.
 *
 * @param {Object} props
 * @param {'success'|'warning'|'error'|'neutral'|'info'} props.tone
 * @param {React.ReactNode} props.children - The visible label.
 * @param {'sm'|'md'} [props.size='sm']
 * @param {string} [props.title] - Optional tooltip with more detail.
 * @param {string} [props.className]
 */
export function CompliancePill({ tone, children, size = 'sm', title, className = '' }) {
  const Icon = TONE_ICONS[tone] || TONE_ICONS.neutral;
  const sizeClass = size === 'md' ? 'px-3 py-1 text-sm gap-1.5' : 'px-2 py-0.5 text-xs gap-1';
  const iconClass = size === 'md' ? 'h-5 w-5' : 'h-4 w-4';
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium whitespace-nowrap ${sizeClass} ${
        TONES[tone] || TONES.neutral
      } ${className}`}
      title={title}
    >
      <Icon className={`${iconClass} shrink-0`} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/**
 * "Conforming" (green) / "Non-conforming" (red). An acknowledged gap is still
 * non-conforming, so callers pass the server's `conforming` flag unchanged.
 *
 * @param {Object} props
 * @param {boolean} props.conforming
 * @param {'sm'|'md'} [props.size='sm']
 */
export function ConformancePill({ conforming, size = 'sm' }) {
  const { t } = useTranslation();
  return conforming ? (
    <CompliancePill tone="success" size={size}>
      {t('admin.euAiAct.status.conforming', 'Conforming')}
    </CompliancePill>
  ) : (
    <CompliancePill tone="error" size={size}>
      {t('admin.euAiAct.status.nonConforming', 'Non-conforming')}
    </CompliancePill>
  );
}

/**
 * Traffic light of one checklist item: ok / warning / error.
 *
 * @param {Object} props
 * @param {'ok'|'warning'|'error'} props.status
 */
export function CheckStatusBadge({ status }) {
  const { t } = useTranslation();
  if (status === 'ok') {
    return (
      <CompliancePill tone="success">{t('admin.euAiAct.checkStatus.ok', 'OK')}</CompliancePill>
    );
  }
  if (status === 'warning') {
    return (
      <CompliancePill tone="warning">
        {t('admin.euAiAct.checkStatus.warning', 'Warning')}
      </CompliancePill>
    );
  }
  return (
    <CompliancePill tone="error">{t('admin.euAiAct.checkStatus.error', 'Error')}</CompliancePill>
  );
}

/**
 * Severity of a compliance warning.
 *
 * @param {Object} props
 * @param {'error'|'warning'} props.severity
 */
export function SeverityBadge({ severity }) {
  const { t } = useTranslation();
  return severity === 'error' ? (
    <CompliancePill tone="error">{t('admin.euAiAct.severity.error', 'Error')}</CompliancePill>
  ) : (
    <CompliancePill tone="warning">{t('admin.euAiAct.severity.warning', 'Warning')}</CompliancePill>
  );
}
