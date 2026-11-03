// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QuotaBar from '../../../shared/components/QuotaBar';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  fetchUsageLimitGroups,
  fetchUsageLimitModels,
  fetchUsageLimitSettings,
  fetchUsageLimitUsers,
  resetUsageLimitUser,
  saveUsageLimitSettings
} from '../../../api/usageLimitsAdminApi';
import { formatBytes } from '../utils/systemResourcesFormat';
import {
  formatResetMoment,
  formatTokens,
  localizedName,
  sourceLabel,
  windowLabel
} from '../../../shared/utils/usageFormat';

const WINDOWS = ['day', 'week', 'month'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const INPUT =
  'block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
const BUTTON =
  'inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';
const PRIMARY =
  'inline-flex items-center justify-center rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const CARD =
  'rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800';
const TH =
  'px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400';
const TD = 'px-4 py-3 text-sm text-gray-700 dark:text-gray-300 align-top';

function StatusBadge({ status }) {
  const { t } = useTranslation();
  const styles = {
    exceeded: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
  };
  const labels = {
    exceeded: t('admin.usage.limits.status.exceeded', 'Limit reached'),
    warning: t('admin.usage.limits.status.warning', 'Near limit'),
    ok: t('admin.usage.limits.status.ok', 'OK')
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] || styles.ok}`}
    >
      {labels[status] || labels.ok}
    </span>
  );
}

/** "≤ 100k / day · 1M / month", or "Unlimited". */
function limitSummary(limits, t, language) {
  const parts = WINDOWS.filter(w => limits?.[w] !== null && limits?.[w] !== undefined).map(w =>
    t('admin.usage.limits.perWindow', '{{limit}} / {{window}}', {
      limit: formatTokens(limits[w], language),
      window: windowLabel(w, t).toLowerCase()
    })
  );
  return parts.length ? parts.join(' · ') : t('admin.usage.limits.unlimited', 'Unlimited');
}

function bucketLabel(bucket, t, language) {
  const scope =
    bucket.scope === 'model'
      ? localizedName(bucket.modelName, language, bucket.modelId)
      : t('admin.usage.limits.allModels', 'All models');
  return `${scope} · ${windowLabel(bucket.window, t)}`;
}

/* ── Settings ───────────────────────────────────────────────────────────── */

function SettingsCard() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const apply = data => {
    setSettings(data);
    setForm({
      allModels: Object.fromEntries(
        WINDOWS.map(w => [w, data.allModels?.[w] >= 0 ? String(data.allModels[w]) : ''])
      ),
      resets: { ...data.resets, timezone: data.resets.timezone || '' }
    });
  };

  useEffect(() => {
    fetchUsageLimitSettings()
      .then(apply)
      .catch(() => setMessage({ type: 'error', text: t('admin.usage.limits.loadFailed') }));
  }, [t]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const allModels = {};
      for (const w of WINDOWS) {
        const raw = form.allModels[w].trim();
        if (raw !== '') allModels[w] = Math.max(-1, Math.floor(Number(raw)));
      }
      const saved = await saveUsageLimitSettings({
        allModels,
        resets: { ...form.resets, timezone: form.resets.timezone.trim() || null }
      });
      apply(saved);
      setMessage({ type: 'success', text: t('admin.usage.limits.saved', 'Settings saved') });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error?.message || t('admin.usage.limits.saveFailed', 'Settings could not be saved')
      });
    } finally {
      setSaving(false);
    }
  };

  if (!form) {
    return (
      <div className={`${CARD} p-5 text-sm text-gray-500 dark:text-gray-400`}>
        {message?.text || t('common.loading', 'Loading...')}
      </div>
    );
  }

  const setReset = (key, value) => setForm(f => ({ ...f, resets: { ...f.resets, [key]: value } }));

  return (
    <div className={`${CARD} p-5`} data-testid="usage-limit-settings">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.usage.limits.platformBudget', 'Budget across all models (every user)')}
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.usage.limits.platformBudgetHint',
              'The most tokens one user may use across all models. Leave empty for no limit. Per-model budgets are set on each model; groups and users can only lower them.'
            )}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {WINDOWS.map(w => (
              <label key={w} className="text-xs text-gray-600 dark:text-gray-400">
                {windowLabel(w, t)}
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  className={`${INPUT} mt-1`}
                  value={form.allModels[w]}
                  placeholder={t('admin.usage.limits.unlimited', 'Unlimited')}
                  onChange={e =>
                    setForm(f => ({ ...f, allModels: { ...f.allModels, [w]: e.target.value } }))
                  }
                />
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.usage.limits.schedule', 'Reset schedule')}
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.usage.limits.scheduleHint',
              'All token budgets reset at the same moments for everyone. Monthly budgets reset on the 1st.'
            )}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.usage.limits.dailyAt', 'Daily at')}
              <input
                type="time"
                className={`${INPUT} mt-1`}
                value={form.resets.dailyAt}
                onChange={e => setReset('dailyAt', e.target.value)}
              />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.usage.limits.weeklyOn', 'Weekly on')}
              <select
                className={`${INPUT} mt-1`}
                value={form.resets.weeklyOn}
                onChange={e => setReset('weeklyOn', e.target.value)}
              >
                {WEEKDAYS.map(day => (
                  <option key={day} value={day}>
                    {t(`admin.usage.limits.weekday.${day}`, day[0].toUpperCase() + day.slice(1))}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.usage.limits.weeklyAt', 'Weekly at')}
              <input
                type="time"
                className={`${INPUT} mt-1`}
                value={form.resets.weeklyAt}
                onChange={e => setReset('weeklyAt', e.target.value)}
              />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.usage.limits.monthlyAt', 'Monthly (1st) at')}
              <input
                type="time"
                className={`${INPUT} mt-1`}
                value={form.resets.monthlyAt}
                onChange={e => setReset('monthlyAt', e.target.value)}
              />
            </label>
            <label className="col-span-2 text-xs text-gray-600 dark:text-gray-400">
              {t('admin.usage.limits.timezone', 'Time zone')}
              <input
                type="text"
                className={`${INPUT} mt-1`}
                value={form.resets.timezone}
                placeholder={settings.effectiveTimezone}
                onChange={e => setReset('timezone', e.target.value)}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="next-resets">
            {t(
              'admin.usage.limits.nextResets',
              'Next resets: daily {{day}}, weekly {{week}}, monthly {{month}}.',
              {
                day: formatResetMoment(settings.nextResets.day, t, i18n.language),
                week: formatResetMoment(settings.nextResets.week, t, i18n.language),
                month: formatResetMoment(settings.nextResets.month, t, i18n.language)
              }
            )}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {message && (
          <span
            role={message.type === 'error' ? 'alert' : 'status'}
            className={`text-sm ${message.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}
          >
            {message.text}
          </span>
        )}
        <button type="button" className={PRIMARY} onClick={save} disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
        </button>
      </div>
    </div>
  );
}

/* ── Users ──────────────────────────────────────────────────────────────── */

function UsersView({ models }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [query, setQuery] = useState({ search: '', status: 'all', modelId: '', page: 1 });
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [pendingReset, setPendingReset] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchUsageLimitUsers({ ...query, pageSize: 25 }));
      setError(null);
    } catch (e) {
      setError(e?.message || t('admin.usage.limits.loadFailed', 'Could not load usage'));
    } finally {
      setLoading(false);
    }
  }, [query, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q => ({ ...q, search, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const confirmReset = async () => {
    const target = pendingReset;
    setPendingReset(null);
    if (!target) return;
    try {
      await resetUsageLimitUser(target.userKey);
      await load();
    } catch (e) {
      setError(e?.message || t('admin.usage.limits.resetFailed', 'Reset failed'));
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-end gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
        <label className="min-w-[12rem] flex-1 text-xs text-gray-600 dark:text-gray-400">
          {t('admin.usage.limits.search', 'Search')}
          <input
            type="search"
            className={`${INPUT} mt-1`}
            value={search}
            placeholder={t('admin.usage.limits.searchPlaceholder', 'Name, e-mail or group')}
            onChange={e => setSearch(e.target.value)}
          />
        </label>
        <label className="text-xs text-gray-600 dark:text-gray-400">
          {t('admin.usage.limits.filterStatus', 'Show')}
          <select
            className={`${INPUT} mt-1`}
            value={query.status}
            onChange={e => setQuery(q => ({ ...q, status: e.target.value, page: 1 }))}
          >
            <option value="all">{t('admin.usage.limits.filter.all', 'All users')}</option>
            <option value="limited">
              {t('admin.usage.limits.filter.limited', 'Users with limits')}
            </option>
            <option value="warning">
              {t('admin.usage.limits.filter.warning', 'Near or at a limit (≥ 80 %)')}
            </option>
            <option value="exceeded">
              {t('admin.usage.limits.filter.exceeded', 'Limit reached')}
            </option>
          </select>
        </label>
        <label className="text-xs text-gray-600 dark:text-gray-400">
          {t('admin.usage.limits.filterModel', 'Model')}
          <select
            className={`${INPUT} mt-1`}
            value={query.modelId}
            onChange={e => setQuery(q => ({ ...q, modelId: e.target.value, page: 1 }))}
          >
            <option value="">{t('admin.usage.limits.filter.anyModel', 'Any model')}</option>
            {models
              .filter(m => m.limited)
              .map(m => (
                <option key={m.modelId} value={m.modelId}>
                  {localizedName(m.name, lang, m.modelId)}
                </option>
              ))}
          </select>
        </label>
        <button type="button" className={BUTTON} onClick={load} disabled={loading}>
          {t('admin.usage.limits.refresh', 'Refresh')}
        </button>
      </div>

      {error && (
        <div role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <th className={TH}>{t('admin.usage.limits.user', 'User')}</th>
              <th className={`${TH} w-1/3`}>
                {t('admin.usage.limits.closestLimit', 'Closest to its limit')}
              </th>
              <th className={TH}>{t('admin.usage.limits.thisMonth', 'Tokens this month')}</th>
              <th className={TH}>{t('admin.usage.limits.files', 'File storage')}</th>
              <th className={TH}>{t('admin.usage.limits.statusLabel', 'Status')}</th>
              <th className={TH}>
                <span className="sr-only">{t('common.actions', 'Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {(data?.items || []).map(user => (
              <Fragment key={user.userKey}>
                <tr>
                  <td className={TD}>
                    <button
                      type="button"
                      className="text-left"
                      aria-expanded={expanded === user.userKey}
                      onClick={() => setExpanded(e => (e === user.userKey ? null : user.userKey))}
                    >
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {user.guest ? t('admin.usage.limits.guests', 'Guests') : user.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {[user.email || user.username, (user.groups || []).join(', ')]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </button>
                  </td>
                  <td className={TD}>
                    {user.worst ? (
                      <QuotaBar
                        size="sm"
                        label={bucketLabel(user.worst, t, lang)}
                        used={user.worst.used}
                        limit={user.worst.limit}
                      />
                    ) : (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('admin.usage.limits.noLimits', 'No limits')}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(user.tokens?.month, lang)}</td>
                  <td className={`${TD} tabular-nums`}>
                    {user.files
                      ? `${formatBytes(user.files.usedBytes)}${user.files.limit ? ` / ${formatBytes(user.files.limit)}` : ''}`
                      : '—'}
                  </td>
                  <td className={TD}>
                    <StatusBadge status={user.status} />
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <button
                      type="button"
                      className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
                      onClick={() => setExpanded(e => (e === user.userKey ? null : user.userKey))}
                    >
                      {expanded === user.userKey
                        ? t('admin.usage.limits.hide', 'Hide')
                        : t('admin.usage.limits.details', 'Details')}
                    </button>
                  </td>
                </tr>
                {expanded === user.userKey && (
                  <tr className="bg-gray-50 dark:bg-gray-900/30">
                    <td colSpan={6} className="px-4 py-4">
                      {user.buckets.length > 0 ? (
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {user.buckets.map(b => (
                            <QuotaBar
                              key={b.id}
                              size="sm"
                              label={bucketLabel(b, t, lang)}
                              used={b.used}
                              limit={b.limit}
                              resetAt={b.resetAt}
                              hint={sourceLabel(b.source, t)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.usage.limits.noLimitsUser',
                            'No token limits apply to this user.'
                          )}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap gap-3">
                        {!user.guest && (
                          <Link
                            to={`/admin/users/${encodeURIComponent(user.userKey)}`}
                            className={BUTTON}
                          >
                            {t('admin.usage.limits.editLimits', 'Edit personal limits')}
                          </Link>
                        )}
                        <button
                          type="button"
                          className={BUTTON}
                          onClick={() => setPendingReset(user)}
                        >
                          {t('admin.usage.limits.resetUsage', 'Reset current usage')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                  {t('admin.usage.limits.noUsers', 'No users match.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && pages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-200 p-3 text-sm dark:border-gray-700">
          <span className="text-gray-500 dark:text-gray-400">
            {t('admin.usage.limits.pageOf', 'Page {{page}} of {{pages}} · {{total}} users', {
              page: data.page,
              pages,
              total: data.total
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={data.page <= 1}
              onClick={() => setQuery(q => ({ ...q, page: q.page - 1 }))}
            >
              {t('common.previous', 'Previous')}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={data.page >= pages}
              onClick={() => setQuery(q => ({ ...q, page: q.page + 1 }))}
            >
              {t('common.next', 'Next')}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={Boolean(pendingReset)}
        onDeny={() => setPendingReset(null)}
        onConfirm={confirmReset}
        title={t('admin.usage.limits.resetTitle', 'Reset usage?')}
        message={t(
          'admin.usage.limits.resetMessage',
          "This sets {{name}}'s token counts for the current day, week and month to zero, for every model.",
          { name: pendingReset?.name || pendingReset?.userKey || '' }
        )}
        confirmLabel={t('admin.usage.limits.resetConfirm', 'Reset')}
        danger
      />
    </div>
  );
}

/* ── Models ─────────────────────────────────────────────────────────────── */

function ModelsView({ models }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-900/40">
          <tr>
            <th className={TH}>{t('admin.usage.limits.model', 'Model')}</th>
            <th className={TH}>{t('admin.usage.limits.perUserLimit', 'Limit per user')}</th>
            {WINDOWS.map(w => (
              <th key={w} className={TH}>
                {t('admin.usage.limits.tokensWindow', 'Tokens ({{window}})', {
                  window: windowLabel(w, t).toLowerCase()
                })}
              </th>
            ))}
            <th className={TH}>{t('admin.usage.limits.activeUsers', 'Users this month')}</th>
            <th className={TH}>{t('admin.usage.limits.nearOver', 'Near / at limit')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {models.map(m => (
            <tr key={m.modelId}>
              <td className={TD}>
                <Link
                  to={`/admin/models/${encodeURIComponent(m.modelId)}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {localizedName(m.name, lang, m.modelId)}
                </Link>
              </td>
              <td className={TD}>{limitSummary(m.limits, t, lang)}</td>
              {WINDOWS.map(w => (
                <td key={w} className={`${TD} tabular-nums`}>
                  {formatTokens(m.tokens[w], lang)}
                </td>
              ))}
              <td className={`${TD} tabular-nums`}>{m.activeUsers}</td>
              <td className={TD}>
                <span className="text-amber-700 dark:text-amber-400">{m.usersWarning}</span>
                {' / '}
                <span className="text-red-600 dark:text-red-400">{m.usersExceeded}</span>
              </td>
            </tr>
          ))}
          {models.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500">
                {t('admin.usage.limits.noModels', 'No enabled models.')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── Groups ─────────────────────────────────────────────────────────────── */

function groupLimitSummary(usageLimits, t, lang) {
  if (!usageLimits) return t('admin.usage.limits.noGroupLimits', 'None (model limits apply)');
  const parts = [];
  if (usageLimits.allModels) {
    parts.push(
      `${t('admin.usage.limits.allModels', 'All models')}: ${limitSummary(usageLimits.allModels, t, lang)}`
    );
  }
  for (const [modelId, limits] of Object.entries(usageLimits.models || {})) {
    parts.push(
      `${modelId === '*' ? t('admin.usage.limits.otherModels', 'Other models') : modelId}: ${limitSummary(limits, t, lang)}`
    );
  }
  if (usageLimits.fileStorageBytes >= 0) {
    parts.push(
      `${t('admin.usage.limits.files', 'File storage')}: ${formatBytes(usageLimits.fileStorageBytes)}`
    );
  }
  return parts;
}

function GroupsView({ groups }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-900/40">
          <tr>
            <th className={TH}>{t('admin.usage.limits.group', 'Group')}</th>
            <th className={TH}>{t('admin.usage.limits.groupLimits', 'Limits')}</th>
            <th className={TH}>{t('admin.usage.limits.members', 'Members seen')}</th>
            <th className={TH}>{t('admin.usage.limits.thisMonth', 'Tokens this month')}</th>
            <th className={TH}>{t('admin.usage.limits.nearOver', 'Near / at limit')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {groups.map(g => {
            const summary = groupLimitSummary(g.usageLimits, t, lang);
            return (
              <tr key={g.groupId}>
                <td className={TD}>
                  <Link
                    to={`/admin/groups/${encodeURIComponent(g.groupId)}`}
                    className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {localizedName(g.name, lang, g.groupId)}
                  </Link>
                  {g.inherits?.length > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('admin.usage.limits.inherits', 'inherits {{groups}}', {
                        groups: g.inherits.join(', ')
                      })}
                    </div>
                  )}
                </td>
                <td className={`${TD} text-xs`}>
                  {Array.isArray(summary) ? (
                    <ul className="space-y-0.5">
                      {summary.map(line => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400">{summary}</span>
                  )}
                </td>
                <td className={`${TD} tabular-nums`}>{g.members}</td>
                <td className={`${TD} tabular-nums`}>{formatTokens(g.tokens.month, lang)}</td>
                <td className={TD}>
                  <span className="text-amber-700 dark:text-amber-400">{g.usersWarning}</span>
                  {' / '}
                  <span className="text-red-600 dark:text-red-400">{g.usersExceeded}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Panel ──────────────────────────────────────────────────────────────── */

/**
 * Usage → Limits & quotas: the reset schedule and the budget across all
 * models, then every user against their limits (search, filter, reset), the
 * same per model and per group.
 */
function UsageQuotasPanel() {
  const { t } = useTranslation();
  const [view, setView] = useState('users');
  const [models, setModels] = useState([]);
  const [groups, setGroups] = useState([]);

  useEffect(() => {
    fetchUsageLimitModels()
      .then(data => setModels(data.items || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (view !== 'groups') return;
    fetchUsageLimitGroups()
      .then(data => setGroups(data.items || []))
      .catch(() => {});
  }, [view]);

  const views = [
    ['users', t('admin.usage.limits.views.users', 'Users')],
    ['models', t('admin.usage.limits.views.models', 'Models')],
    ['groups', t('admin.usage.limits.views.groups', 'Groups')]
  ];

  return (
    <div className="space-y-6" data-testid="usage-quotas-panel">
      <SettingsCard />
      <div className="flex gap-2" role="tablist">
        {views.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              view === id
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'users' && <UsersView models={models} />}
      {view === 'models' && <ModelsView models={models} />}
      {view === 'groups' && <GroupsView groups={groups} />}
    </div>
  );
}

export default UsageQuotasPanel;
