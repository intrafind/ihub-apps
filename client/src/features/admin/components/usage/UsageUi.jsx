// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

export const CARD =
  'bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700';

/** A titled card; `loading` shows a thin bar over the kept content. */
export function Panel({ title, subtitle, actions, loading, children, testId, className = '' }) {
  return (
    <section className={`${CARD} relative overflow-hidden ${className}`} data-testid={testId}>
      {loading && <LoadingBar />}
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="min-w-0">
            {title && (
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
            )}
            {subtitle && (
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Thin indeterminate bar at the top of a card while it reloads. */
export function LoadingBar() {
  const { t } = useTranslation();
  return (
    <div
      className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-indigo-100 dark:bg-indigo-900/40"
      role="status"
      aria-label={t('admin.usage.reports.loading', 'Loading…')}
    >
      <div className="h-full w-1/3 animate-pulse bg-indigo-500" />
    </div>
  );
}

/** What a view shows when the range has no data. */
export function EmptyState({ icon = 'chart-bar', title, children }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon name={icon} size="lg" className="text-gray-300 dark:text-gray-600" />
      <p className="mt-3 text-sm font-medium text-gray-700 dark:text-gray-300">{title}</p>
      {children && (
        <p className="mt-1 max-w-md text-xs text-gray-500 dark:text-gray-400">{children}</p>
      )}
    </div>
  );
}

/** Error banner for a failed load (the previous data, if any, stays visible). */
export function ErrorNote({ error }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
    >
      {error?.response?.data?.detail ||
        error?.message ||
        t('admin.usage.reports.loadFailed', 'Could not load usage data')}
    </div>
  );
}

/** Small segmented control. */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 dark:border-gray-600 dark:bg-gray-800"
    >
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            value === id
              ? 'bg-indigo-600 text-white'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Outline button used in panel headers. */
export function SmallButton({ children, onClick, disabled, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
    >
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </button>
  );
}
