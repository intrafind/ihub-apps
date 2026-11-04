// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RANGES } from './useUsageReportState';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The one time-range control every tab shares: Today, 24h, 7d, 30d, 90d,
 * 12m or a custom span of UTC days; plus auto-refresh for the live ranges.
 */
export default function RangeControl({ state }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => ({
    from: state.from || today(),
    to: state.to || today()
  }));
  const [custom, setCustom] = useState(state.range === 'custom');

  const labels = {
    today: t('admin.usage.reports.range.today', 'Today'),
    '24h': t('admin.usage.reports.range.24h', '24 hours'),
    '7d': t('admin.usage.reports.range.7d', '7 days'),
    '30d': t('admin.usage.reports.range.30d', '30 days'),
    '90d': t('admin.usage.reports.range.90d', '90 days'),
    '12m': t('admin.usage.reports.range.12m', '12 months'),
    custom: t('admin.usage.reports.range.custom', 'Custom')
  };
  const live = state.range === 'today' || state.range === '24h';

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="usage-range-control">
      <div
        role="group"
        aria-label={t('admin.usage.reports.range.label', 'Time range')}
        className="inline-flex flex-wrap rounded-md border border-gray-300 bg-white p-0.5 dark:border-gray-600 dark:bg-gray-800"
      >
        {RANGES.map(id => {
          const active = id === 'custom' ? custom : !custom && state.range === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (id === 'custom') {
                  setCustom(true);
                  return;
                }
                setCustom(false);
                state.update({ range: id, from: null, to: null });
              }}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                active
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
            >
              {labels[id]}
            </button>
          );
        })}
      </div>
      {custom && (
        <form
          className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
          onSubmit={e => {
            e.preventDefault();
            if (draft.from && draft.to && draft.from <= draft.to) {
              state.update({ range: 'custom', from: draft.from, to: draft.to });
            }
          }}
        >
          <label className="flex items-center gap-1">
            {t('admin.usage.reports.range.from', 'From')}
            <input
              type="date"
              value={draft.from}
              max={draft.to}
              onChange={e => setDraft(d => ({ ...d, from: e.target.value }))}
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            />
          </label>
          <label className="flex items-center gap-1">
            {t('admin.usage.reports.range.to', 'To')}
            <input
              type="date"
              value={draft.to}
              min={draft.from}
              onChange={e => setDraft(d => ({ ...d, to: e.target.value }))}
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            />
          </label>
          <button
            type="submit"
            disabled={!draft.from || !draft.to || draft.from > draft.to}
            className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('admin.usage.reports.range.apply', 'Apply')}
          </button>
        </form>
      )}
      {live && !custom && (
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={state.auto}
            onChange={e => state.update({ auto: e.target.checked ? '1' : null })}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          {t('admin.usage.reports.autoRefresh', 'Auto-refresh')}
        </label>
      )}
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('admin.usage.reports.utcNote', 'Days are UTC days.')}
      </span>
    </div>
  );
}
