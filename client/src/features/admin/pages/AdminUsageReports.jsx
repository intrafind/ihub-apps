// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchAdminUsageMeta, updateAdminUsageTrackingMode } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';
import UsageQuotasPanel from '../components/UsageQuotasPanel';
import RangeControl from '../components/usage/RangeControl';
import UsageOverview from '../components/usage/UsageOverview';
import BreakdownTable from '../components/usage/BreakdownTable';
import ReliabilityPanel from '../components/usage/ReliabilityPanel';
import RequestLog from '../components/usage/RequestLog';
import useUsageReportState from '../components/usage/useUsageReportState';

const MODES = ['anonymous', 'pseudonymous', 'identified'];

/** Tracking mode switch: who a usage record names. */
function TrackingMode() {
  const { t } = useTranslation();
  const [mode, setMode] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchAdminUsageMeta()
      .then(meta => setMode(meta?.trackingMode || 'pseudonymous'))
      .catch(() => {});
  }, []);

  if (!mode) return null;
  const descriptions = {
    anonymous: t(
      'admin.usage.reports.mode.anonymousDesc',
      'Users and conversations are recorded as irreversible fingerprints.'
    ),
    pseudonymous: t(
      'admin.usage.reports.mode.pseudonymousDesc',
      'Each conversation is recorded as its own user; no user ids are stored.'
    ),
    identified: t('admin.usage.reports.mode.identifiedDesc', 'Records name the real user id.')
  };
  return (
    <div className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400 sm:items-end">
      <label className="flex items-center gap-2">
        {t('admin.usage.reports.mode.label', 'Tracking mode')}
        <select
          value={mode}
          disabled={saving}
          onChange={async e => {
            const next = e.target.value;
            setSaving(true);
            try {
              await updateAdminUsageTrackingMode(next);
              setMode(next);
            } catch (err) {
              console.error('Failed to update tracking mode', err);
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        >
          {MODES.map(m => (
            <option key={m} value={m}>
              {t(`admin.usage.trackingModes.${m}`, m)}
            </option>
          ))}
        </select>
      </label>
      <span className="max-w-xs sm:text-right">{descriptions[mode]}</span>
    </div>
  );
}

/**
 * Usage reports: every tab reads the same pipeline (daily rollups plus a live
 * "today") over one time range kept in the URL.
 */
function AdminUsageReports() {
  const { t } = useTranslation();
  const state = useUsageReportState();

  const tabs = [
    ['overview', t('admin.usage.tabs.overview', 'Overview'), 'chart'],
    ['breakdown', t('admin.usage.tabs.breakdown', 'Breakdown'), 'table-cells'],
    ['reliability', t('admin.usage.tabs.reliability', 'Reliability'), 'exclamation-triangle'],
    ['requests', t('admin.usage.tabs.requests', 'Requests'), 'list'],
    ['limits', t('admin.usage.tabs.limits', 'Limits & quotas'), 'chart-bar']
  ];
  const showRange = state.tab !== 'limits';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900" data-testid="admin-usage-reports">
      <div className="border-b border-gray-200 bg-white shadow-xs dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.usage.title', 'Usage Reports')}
              </h1>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t(
                  'admin.usage.reports.subtitle',
                  'Requests and tokens of every model call — chats, agents, workflows, scheduled tasks and the API.'
                )}{' '}
                <Link
                  to="/admin/feedback"
                  className="text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {t('admin.usage.reviewFeedback', 'Review feedback')} →
                </Link>
              </p>
            </div>
            <TrackingMode />
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="-mb-px flex space-x-6 overflow-x-auto" role="tablist">
            {tabs.map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={state.tab === id}
                onClick={() => state.update({ tab: id })}
                className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-1 py-3 text-sm font-medium ${
                  state.tab === id
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-300'
                }`}
              >
                <Icon name={icon} size="sm" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {showRange && (
          <RangeControl key={`${state.range}|${state.from}|${state.to}`} state={state} />
        )}
        {state.tab === 'overview' && <UsageOverview state={state} />}
        {state.tab === 'breakdown' && <BreakdownTable state={state} />}
        {state.tab === 'reliability' && <ReliabilityPanel state={state} />}
        {state.tab === 'requests' && <RequestLog state={state} />}
        {state.tab === 'limits' && <UsageQuotasPanel />}
      </div>
    </div>
  );
}

export default AdminUsageReports;
