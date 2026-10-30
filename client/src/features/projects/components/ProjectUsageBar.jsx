// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { formatBytes } from '../../admin/utils/systemResourcesFormat';
import { isIFinderProject, projectUsage } from '../utils/projectView';

const BAR_COLORS = {
  ok: 'bg-indigo-500',
  warn: 'bg-amber-500',
  full: 'bg-red-500'
};

/**
 * One quota as a labelled bar.
 *
 * @param {{label: string, value: string, state: {ratio: number, level: string, limit: number|null}}} props
 * @returns {JSX.Element}
 */
function QuotaBar({ label, value, state }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
        <span>{label}</span>
        <span className={state.level === 'full' ? 'text-red-600 dark:text-red-400' : ''}>
          {value}
        </span>
      </div>
      {state.limit !== null && (
        <div
          className="mt-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.ratio * 100)}
        >
          <div
            className={`h-full ${BAR_COLORS[state.level]}`}
            style={{ width: `${Math.round(state.ratio * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A project's usage against the quotas (spec 1 §9.4): items and bytes, each
 * as a bar that turns amber near the limit and red at it.
 *
 * @param {Object} props
 * @param {Object} props.project - With `usage` (and `items`).
 * @param {Object|null} props.config - `_config` with `limits`.
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
function ProjectUsageBar({ project, config, className = '' }) {
  const { t } = useTranslation();
  const usage = projectUsage(project, config);
  const itemsValue =
    usage.items.limit !== null
      ? t('projects.usage.itemsOf', '{{used}} of {{limit}}', usage.items)
      : String(usage.items.used);
  const bytesValue =
    usage.bytes.limit !== null
      ? t('projects.usage.bytesOf', '{{used}} of {{limit}}', {
          used: formatBytes(usage.bytes.used),
          limit: formatBytes(usage.bytes.limit)
        })
      : formatBytes(usage.bytes.used);
  // A smart collection holds ids, not files: one bar, its documents against
  // iFinder's cap, and no storage.
  if (isIFinderProject(project)) {
    return (
      <div className={`grid grid-cols-1 gap-3 ${className}`} data-testid="project-usage">
        <QuotaBar
          label={t('projects.usage.documents', 'Documents')}
          value={itemsValue}
          state={usage.items}
        />
      </div>
    );
  }
  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${className}`}
      data-testid="project-usage"
    >
      <QuotaBar label={t('projects.usage.items', 'Items')} value={itemsValue} state={usage.items} />
      <QuotaBar
        label={t('projects.usage.storage', 'Storage')}
        value={bytesValue}
        state={usage.bytes}
      />
    </div>
  );
}

export default ProjectUsageBar;
