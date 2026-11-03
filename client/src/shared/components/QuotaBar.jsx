// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { formatReset, formatTokens } from '../utils/usageFormat';

const BAR = {
  ok: 'bg-indigo-500',
  warn: 'bg-amber-500',
  full: 'bg-red-500'
};

/** ok below 80 %, warn from 80 %, full at the limit. */
export function quotaLevel(used, limit) {
  if (limit === null || limit === undefined) return 'ok';
  if (limit <= 0 || used >= limit) return 'full';
  return used / limit >= 0.8 ? 'warn' : 'ok';
}

/**
 * One usage limit as a bar: label, "used / limit", a bar that turns amber
 * from 80 % and red at the limit, and when it resets.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {number} props.used
 * @param {number|null} props.limit - null for unlimited (no bar)
 * @param {string} [props.resetAt] - ISO time of the next reset
 * @param {string} [props.hint] - e.g. where the limit comes from
 * @param {(value: number) => string} [props.format] - Default: token counts
 * @param {'sm'|'md'} [props.size]
 * @param {string} [props.className]
 */
function QuotaBar({ label, used, limit, resetAt, hint, format, size = 'md', className = '' }) {
  const { t, i18n } = useTranslation();
  const fmt = format || (v => formatTokens(v, i18n.language));
  const unlimited = limit === null || limit === undefined;
  const level = quotaLevel(used, limit);
  const percent = unlimited ? 0 : limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const value = unlimited
    ? t('usage.usedUnlimited', '{{used}} used · unlimited', { used: fmt(used) })
    : t('usage.usedOf', '{{used}} of {{limit}}', { used: fmt(used), limit: fmt(limit) });

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`truncate ${size === 'sm' ? 'text-xs' : 'text-sm'} font-medium text-gray-800 dark:text-gray-200`}
        >
          {label}
        </span>
        <span
          className={`shrink-0 tabular-nums ${size === 'sm' ? 'text-xs' : 'text-sm'} ${
            level === 'full'
              ? 'text-red-600 dark:text-red-400'
              : level === 'warn'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-gray-600 dark:text-gray-400'
          }`}
        >
          {value}
          {!unlimited && (
            <span className="ml-1 text-gray-500 dark:text-gray-500">({Math.round(percent)}%)</span>
          )}
        </span>
      </div>
      {!unlimited && (
        <div
          className={`mt-1.5 ${size === 'sm' ? 'h-1.5' : 'h-2'} rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden`}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={value}
        >
          <div
            className={`h-full rounded-full transition-all ${BAR[level]}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {(resetAt || hint) && (
        <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-gray-500 dark:text-gray-400">
          {resetAt && <span>{formatReset(resetAt, t, i18n.language)}</span>}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  );
}

export default QuotaBar;
