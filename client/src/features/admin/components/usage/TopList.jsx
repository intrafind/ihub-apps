// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { EmptyState } from './UsageUi';
import { formatCompact, formatNumber } from './usageFormat';

/** Top-N rows as horizontal bars (tokens, with requests beside). */
export default function TopList({ rows, emptyTitle, labelOf = row => row.key, testId }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (!rows?.length) return <EmptyState title={emptyTitle} />;
  const max = Math.max(1, ...rows.map(r => r.totalTokens || 0));
  return (
    <ol className="space-y-3" data-testid={testId}>
      {rows.map(row => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-gray-800 dark:text-gray-200">
              {labelOf(row)}
            </span>
            <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
              {t('admin.usage.reports.top.value', '{{tokens}} tokens · {{requests}} req.', {
                tokens: formatCompact(row.totalTokens, lang),
                requests: formatNumber(row.requests, lang)
              })}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{ width: `${((row.totalTokens || 0) / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
