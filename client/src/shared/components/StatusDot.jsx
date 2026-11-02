// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/**
 * Dot style and default label per status. The light-mode colours are the 600
 * shades, the dark-mode ones the 400 shades, so each dot keeps 3:1 against
 * the surface it sits on (WCAG 1.4.11). `off` is a hollow ring rather than a
 * grey fill, so it differs from the other states by shape too.
 */
const STATUSES = {
  ok: {
    dot: 'bg-green-600 dark:bg-green-400',
    labelKey: 'components.statusDot.ok',
    fallback: 'OK'
  },
  warn: {
    dot: 'bg-amber-600 dark:bg-amber-400',
    labelKey: 'components.statusDot.warn',
    fallback: 'Warning'
  },
  degraded: {
    dot: 'bg-orange-600 dark:bg-orange-400',
    labelKey: 'components.statusDot.degraded',
    fallback: 'Degraded'
  },
  error: {
    dot: 'bg-red-600 dark:bg-red-400',
    labelKey: 'components.statusDot.error',
    fallback: 'Error'
  },
  off: {
    dot: 'border-2 border-gray-500 bg-transparent dark:border-gray-400',
    labelKey: 'components.statusDot.off',
    fallback: 'Off'
  }
};

const SIZES = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5'
};

/** The statuses a StatusDot accepts. */
export const STATUS_DOT_STATUSES = Object.keys(STATUSES);

/**
 * StatusDot — a coloured dot for the health of something (an integration, a
 * connection, a server), with its meaning always in text as well.
 *
 * The status is never shown by colour alone: the text is rendered next to the
 * dot (`showLabel`) or as visually hidden text that screen readers announce,
 * and the dot carries the same text as a tooltip. Use `showLabel` wherever no
 * other visible text states the status (WCAG 1.4.1, Use of Color).
 *
 * @param {Object} props
 * @param {'ok'|'warn'|'degraded'|'error'|'off'} props.status - The status to show.
 *   An unknown value is drawn like `off` and labelled with the value itself.
 * @param {React.ReactNode} [props.label] - Text for the status; defaults to the
 *   translated status name (`components.statusDot.<status>`). Pass a more
 *   specific text where there is one ("Connected as you", "Token expired").
 * @param {boolean} [props.showLabel=false] - Show the text next to the dot
 *   instead of hiding it visually.
 * @param {'sm'|'md'} [props.size='md'] - Dot diameter, 8px or 10px.
 * @param {string} [props.className] - Extra classes for the wrapper.
 * @returns {JSX.Element}
 *
 * @example
 * <StatusDot status="degraded" label={t('integrations.status.slow', 'Responding slowly')} showLabel />
 */
function StatusDot({ status, label, showLabel = false, size = 'md', className = '', ...rest }) {
  const { t } = useTranslation();
  const known = STATUSES[status];
  const style = known || STATUSES.off;
  const text = label ?? (known ? t(known.labelKey, known.fallback) : String(status ?? ''));
  const tooltip = typeof text === 'string' ? text : undefined;

  return (
    <span
      {...rest}
      data-status={known ? status : 'unknown'}
      className={`inline-flex items-center gap-1.5 ${className}`}
    >
      <span
        aria-hidden="true"
        title={showLabel ? undefined : tooltip}
        className={`inline-block shrink-0 rounded-full ${SIZES[size] || SIZES.md} ${style.dot}`}
      />
      <span className={showLabel ? 'text-sm text-gray-700 dark:text-gray-300' : 'sr-only'}>
        {text}
      </span>
    </span>
  );
}

export default StatusDot;
