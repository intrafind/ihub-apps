// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUsageCalls } from '../../../../api/usageReportsAdminApi';
import Icon from '../../../../shared/components/Icon';
import useFocusTrap from '../../../../shared/hooks/useFocusTrap';
import { EmptyState, ErrorNote, Panel, SmallButton } from './UsageUi';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from './usageFormat';

const SURFACES = ['chat', 'agent', 'workflow', 'task', 'api', 'magic', 'system'];
const OUTCOMES = ['ok', 'error', 'aborted', 'quota', 'rate_limited'];
const PAGE_SIZE = 50;

const TH =
  'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm tabular-nums text-gray-700 dark:text-gray-300 whitespace-nowrap';
const INPUT =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200';

const OUTCOME_STYLE = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  rate_limited: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  quota: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  aborted: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
};

function OutcomeBadge({ outcome }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${OUTCOME_STYLE[outcome] || OUTCOME_STYLE.aborted}`}
    >
      {t(`admin.usage.reports.outcome.${outcome}`, outcome)}
    </span>
  );
}

/** Text filter applied a moment after the last key. */
function FilterInput({ label, value, onChange }) {
  const [draft, setDraft] = useState(value);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    if (draft === value) return undefined;
    const timer = setTimeout(() => changeRef.current(draft.trim()), 400);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <label className="text-xs text-gray-600 dark:text-gray-400">
      {label}
      <input className={INPUT} value={draft} onChange={e => setDraft(e.target.value)} />
    </label>
  );
}

/** Side drawer with one call's metadata. No prompt or response text exists to show. */
function CallDrawer({ call, onClose }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // Focus moves into the drawer, stays there, and returns to the row on close.
  useFocusTrap(panelRef, {
    isActive: true,
    initialFocusRef: closeRef,
    returnFocusOnDeactivate: true
  });
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const rows = [
    [t('admin.usage.reports.calls.time', 'Time'), formatDateTime(call.ts, lang)],
    [
      t('admin.usage.reports.dim.surface', 'Surface'),
      t(`admin.usage.reports.surface.${call.surf}`, call.surf)
    ],
    [t('admin.usage.reports.dim.user', 'User'), call.uid || '—'],
    [t('admin.usage.reports.calls.groups', 'Groups'), (call.grp || []).join(', ') || '—'],
    [t('admin.usage.reports.dim.app', 'App'), call.app || '—'],
    [t('admin.usage.reports.dim.model', 'Model'), call.model || '—'],
    [t('admin.usage.reports.dim.provider', 'Provider'), call.prov || '—'],
    [t('admin.usage.reports.calls.outcome', 'Outcome'), <OutcomeBadge key="o" outcome={call.st} />],
    [t('admin.usage.reports.col.code', 'Code'), call.err || '—'],
    [t('admin.usage.reports.kpi.inputTokens', 'Input tokens'), formatNumber(call.pt, lang)],
    [
      t('admin.usage.reports.kpi.cachedTokens', 'Cached input'),
      call.cr != null ? formatNumber(call.cr, lang) : '—'
    ],
    [
      t('admin.usage.reports.calls.cacheWrite', 'Cache write'),
      call.cw != null ? formatNumber(call.cw, lang) : '—'
    ],
    [t('admin.usage.reports.kpi.outputTokens', 'Output tokens'), formatNumber(call.ct, lang)],
    [
      t('admin.usage.reports.calls.reasoning', 'Reasoning'),
      call.rt != null ? formatNumber(call.rt, lang) : '—'
    ],
    [
      t('admin.usage.reports.calls.webSearches', 'Web searches'),
      call.ws != null ? formatNumber(call.ws, lang) : '—'
    ],
    [
      t('admin.usage.reports.calls.tokenSource', 'Token counts'),
      call.src === 'provider'
        ? t('admin.usage.reports.calls.fromProvider', 'Reported by the provider')
        : t('admin.usage.reports.calls.estimated', 'Estimated')
    ],
    [t('admin.usage.reports.calls.latency', 'Latency'), formatDuration(call.lat, lang)],
    [t('admin.usage.reports.calls.ttft', 'Time to first token'), formatDuration(call.ttft, lang)],
    [t('admin.usage.reports.calls.toolCalls', 'Tool calls'), formatNumber(call.tc || 0, lang)],
    [t('admin.usage.reports.calls.conversation', 'Conversation / run'), call.cid || '—'],
    [t('admin.usage.reports.calls.requestId', 'Request id'), call.rid || '—']
  ];
  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-testid="usage-call-drawer">
      <button
        type="button"
        aria-label={t('common.close', 'Close')}
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-call-title"
        className="relative h-full w-full max-w-md overflow-y-auto bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2
            id="usage-call-title"
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.usage.reports.calls.details', 'Call details')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
        <dl className="divide-y divide-gray-100 px-4 dark:divide-gray-700">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-2 gap-3 py-2 text-sm">
              <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
              <dd className="break-all text-gray-900 dark:text-gray-100">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.usage.reports.calls.noContent',
            'Usage records hold metadata only — no prompt or response text.'
          )}
        </p>
      </aside>
    </div>
  );
}

/**
 * Request log: individual model calls of the range, newest first, filtered
 * by user, app, model, surface and outcome (filters kept in the URL).
 */
export default function RequestLog({ state }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const seqRef = useRef(0);
  const { filters } = state;
  const key = JSON.stringify({ ...state.rangeParams, ...filters });

  const load = useCallback(
    async next => {
      const mine = ++seqRef.current;
      setLoading(true);
      try {
        const page = await fetchUsageCalls({
          ...JSON.parse(key),
          limit: PAGE_SIZE,
          ...(next ? { cursor: next } : {})
        });
        if (mine !== seqRef.current) return;
        setItems(prev => (next ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
        setLoaded(true);
      } catch (err) {
        if (mine === seqRef.current) setError(err);
      } finally {
        if (mine === seqRef.current) setLoading(false);
      }
    },
    [key]
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const setFilter = (name, value) => state.update({ [`f_${name}`]: value || null });
  const clearDrawer = useCallback(() => setSelected(null), []);
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4" data-testid="usage-request-log">
      <ErrorNote error={error} />
      <Panel
        title={t('admin.usage.reports.calls.title', 'Requests')}
        subtitle={t(
          'admin.usage.reports.calls.subtitle',
          'Every model call with its tokens, outcome and timing. Kept as long as the usage events (event retention).'
        )}
        loading={loading}
        actions={
          anyFilter && (
            <SmallButton
              onClick={() =>
                state.update({
                  f_user: null,
                  f_app: null,
                  f_model: null,
                  f_surface: null,
                  f_outcome: null
                })
              }
            >
              {t('admin.usage.reports.calls.clearFilters', 'Clear filters')}
            </SmallButton>
          )
        }
      >
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <FilterInput
            key={`u-${filters.user}`}
            label={t('admin.usage.reports.dim.user', 'User')}
            value={filters.user}
            onChange={v => setFilter('user', v)}
          />
          <FilterInput
            key={`a-${filters.app}`}
            label={t('admin.usage.reports.dim.app', 'App')}
            value={filters.app}
            onChange={v => setFilter('app', v)}
          />
          <FilterInput
            key={`m-${filters.model}`}
            label={t('admin.usage.reports.dim.model', 'Model')}
            value={filters.model}
            onChange={v => setFilter('model', v)}
          />
          <label className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.usage.reports.dim.surface', 'Surface')}
            <select
              className={INPUT}
              value={filters.surface}
              onChange={e => setFilter('surface', e.target.value)}
            >
              <option value="">{t('admin.usage.reports.calls.any', 'Any')}</option>
              {SURFACES.map(s => (
                <option key={s} value={s}>
                  {t(`admin.usage.reports.surface.${s}`, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.usage.reports.calls.outcome', 'Outcome')}
            <select
              className={INPUT}
              value={filters.outcome}
              onChange={e => setFilter('outcome', e.target.value)}
            >
              <option value="">{t('admin.usage.reports.calls.any', 'Any')}</option>
              {OUTCOMES.map(o => (
                <option key={o} value={o}>
                  {t(`admin.usage.reports.outcome.${o}`, o)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {items.length === 0 ? (
          loaded ? (
            <EmptyState title={t('admin.usage.reports.calls.empty', 'No calls match')}>
              {anyFilter
                ? t(
                    'admin.usage.reports.calls.emptyFiltered',
                    'Try fewer filters or a longer range.'
                  )
                : t(
                    'admin.usage.reports.empty.hint',
                    'Model calls from chats, agents, workflows, scheduled tasks and the API appear here as they happen.'
                  )}
            </EmptyState>
          ) : (
            <div className="h-32" />
          )
        ) : (
          <>
            <div className="-mx-4 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead>
                  <tr>
                    <th className={TH}>{t('admin.usage.reports.calls.time', 'Time')}</th>
                    <th className={TH}>{t('admin.usage.reports.dim.user', 'User')}</th>
                    <th className={TH}>{t('admin.usage.reports.dim.surface', 'Surface')}</th>
                    <th className={TH}>{t('admin.usage.reports.dim.app', 'App')}</th>
                    <th className={TH}>{t('admin.usage.reports.dim.model', 'Model')}</th>
                    <th className={TH}>{t('admin.usage.reports.calls.outcome', 'Outcome')}</th>
                    <th className={TH}>{t('admin.usage.reports.col.input', 'Input')}</th>
                    <th className={TH}>{t('admin.usage.reports.col.output', 'Output')}</th>
                    <th className={TH}>{t('admin.usage.reports.calls.latency', 'Latency')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                  {items.map(call => (
                    <tr
                      key={call.id}
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/30"
                      onClick={() => setSelected(call)}
                    >
                      <td className={TD} title={formatDateTime(call.ts, lang)}>
                        <button
                          type="button"
                          className="text-indigo-600 hover:underline dark:text-indigo-400"
                          onClick={e => {
                            e.stopPropagation();
                            setSelected(call);
                          }}
                        >
                          {formatRelative(call.ts, lang)}
                        </button>
                      </td>
                      <td className={`${TD} max-w-[10rem] truncate`} title={call.uid || ''}>
                        {call.uid || '—'}
                      </td>
                      <td className={TD}>
                        {t(`admin.usage.reports.surface.${call.surf}`, call.surf)}
                      </td>
                      <td className={`${TD} max-w-[10rem] truncate`}>{call.app || '—'}</td>
                      <td className={`${TD} max-w-[10rem] truncate`}>{call.model || '—'}</td>
                      <td className={TD}>
                        <OutcomeBadge outcome={call.st} />
                      </td>
                      <td className={TD}>{formatNumber(call.pt, lang)}</td>
                      <td className={TD}>{formatNumber(call.ct, lang)}</td>
                      <td className={TD}>{formatDuration(call.lat, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cursor && (
              <div className="mt-4 flex justify-center">
                <SmallButton onClick={() => load(cursor)} disabled={loading}>
                  {t('admin.usage.reports.calls.loadMore', 'Load more')}
                </SmallButton>
              </div>
            )}
          </>
        )}
      </Panel>
      {selected && <CallDrawer call={selected} onClose={clearDrawer} />}
    </div>
  );
}
