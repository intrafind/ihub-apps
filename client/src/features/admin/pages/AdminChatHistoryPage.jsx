import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { makeAdminApiCall } from '../../../api/adminApi';

const inputClass =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100';
const cardClass = 'bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6';
const headingClass =
  'text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center';

function errorText(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback;
}

function formatNumber(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** One gate in the "is this being stored?" chain. */
function ShareStateBadge({ state, t }) {
  const labels = {
    active: t('admin.chatHistory.shares.state.active', 'Active'),
    revoked: t('admin.chatHistory.shares.state.revoked', 'Revoked'),
    expired: t('admin.chatHistory.shares.state.expired', 'Expired'),
    exhausted: t('admin.chatHistory.shares.state.exhausted', 'View limit reached')
  };
  const tone =
    state === 'active'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
      : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
  return (
    <span className={`inline-block text-xs font-medium rounded-full px-2 py-0.5 ${tone}`}>
      {labels[state] || state}
    </span>
  );
}

function shareModeLabel(mode, t) {
  return (
    {
      users: t('admin.chatHistory.shares.mode.users', 'Specific users'),
      authenticated: t('admin.chatHistory.shares.mode.authenticated', 'Signed-in users'),
      public: t('admin.chatHistory.shares.mode.public', 'Public')
    }[mode] || mode
  );
}

function GateRow({ ok, label, detail, action }) {
  return (
    <li className="flex items-start justify-between gap-4 py-2">
      <div className="flex items-start">
        <Icon
          name={ok ? 'check-circle' : 'x-circle'}
          className={`w-5 h-5 mr-2 shrink-0 ${ok ? 'text-green-500' : 'text-red-500'}`}
        />
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
          {detail && <p className="text-xs text-gray-500 dark:text-gray-400">{detail}</p>}
        </div>
      </div>
      {action}
    </li>
  );
}

function StatTile({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1">{value}</p>
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function CountList({ title, counts }) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">—</p>
      ) : (
        <ul className="text-sm space-y-1">
          {entries.map(([key, count]) => (
            <li key={key} className="flex justify-between text-gray-700 dark:text-gray-300">
              <span className="font-mono">{key}</span>
              <span>{formatNumber(count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopTable({ title, rows, keyName, keyLabel, t }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
      {!rows || rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">—</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
              <th className="py-1 font-medium">{keyLabel}</th>
              <th className="py-1 font-medium text-right">
                {t('admin.chatHistory.stats.chats', 'Chats')}
              </th>
              <th className="py-1 font-medium text-right">
                {t('admin.chatHistory.stats.messages', 'Messages')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={row[keyName]}
                className="border-t border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300"
              >
                <td className="py-1 font-mono truncate max-w-xs">{row[keyName]}</td>
                <td className="py-1 text-right">{formatNumber(row.chats)}</td>
                <td className="py-1 text-right">{formatNumber(row.messages)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NumberField({ id, label, help, value, onChange, min }) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        step="1"
        min={min}
        value={Number.isFinite(value) ? value : ''}
        onChange={e => {
          const parsed = parseInt(e.target.value, 10);
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
        className={inputClass}
      />
      {help && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{help}</p>}
    </div>
  );
}

function CheckboxField({ id, label, help, checked, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center">
        <input
          id={id}
          type="checkbox"
          checked={!!checked}
          onChange={e => onChange(e.target.checked)}
          className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
      </label>
      {help && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">{help}</p>}
    </div>
  );
}

function AdminChatHistoryPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(null);
  const [overview, setOverview] = useState(null);
  const [settings, setSettings] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [shares, setShares] = useState({ items: [], truncated: false });

  const loadShares = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/chat-history/shares');
      setShares({
        items: response.data?.items || [],
        truncated: response.data?.truncated === true
      });
    } catch {
      // The overview still renders; the list just stays empty.
      setShares({ items: [], truncated: false });
    }
  }, []);

  const loadOverview = useCallback(
    async ({ keepSettings = false } = {}) => {
      try {
        setRefreshing(true);
        const response = await makeAdminApiCall('/admin/chat-history');
        setOverview(response.data);
        if (!keepSettings) {
          setSettings(response.data.settings);
          setDirty(false);
        }
      } catch (error) {
        setMessage({
          type: 'error',
          text: errorText(
            error,
            t('admin.chatHistory.loadError', 'Failed to load chat history overview')
          )
        });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [t]
  );

  useEffect(() => {
    loadOverview();
    loadShares();
  }, [loadOverview, loadShares]);

  const updateSetting = (block, key, value) => {
    setSettings(prev => ({ ...prev, [block]: { ...prev[block], [key]: value } }));
    setDirty(true);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage(null);
      const response = await makeAdminApiCall('/admin/chat-history/settings', {
        method: 'PUT',
        body: { chats: settings.chats, runLog: settings.runLog, sharing: settings.sharing }
      });
      setMessage({
        type: 'success',
        text: response.data?.restartRequired
          ? t(
              'admin.chatHistory.saveSuccessRestart',
              'Settings saved. The ledger flush interval takes effect after a server restart.'
            )
          : t('admin.chatHistory.saveSuccess', 'Settings saved and applied.')
      });
      await loadOverview();
    } catch (error) {
      setMessage({
        type: 'error',
        text: errorText(error, t('admin.chatHistory.saveError', 'Failed to save settings'))
      });
    } finally {
      setSaving(false);
    }
  };

  const runRetention = async target => {
    setConfirmDialog(null);
    try {
      setRunning(true);
      setMessage(null);
      const response = await makeAdminApiCall('/admin/chat-history/retention/run', {
        method: 'POST',
        body: { target }
      });
      const { chats, ledger } = response.data || {};
      const parts = [];
      if (chats) {
        parts.push(
          chats.ran
            ? t('admin.chatHistory.retention.chatsRemoved', {
                count: chats.removed,
                defaultValue: '{{count}} chat(s) removed'
              })
            : t(
                'admin.chatHistory.retention.chatsSkipped',
                'Chats not swept: durable chats are not active'
              )
        );
      }
      if (ledger) {
        parts.push(
          ledger.ran
            ? t('admin.chatHistory.retention.runsRemoved', {
                count: ledger.removed,
                defaultValue: '{{count}} ledger run(s) removed'
              })
            : t(
                'admin.chatHistory.retention.runsSkipped',
                'Ledger not swept: ledger cleanup is disabled'
              )
        );
      }
      setMessage({ type: 'success', text: parts.join(' · ') });
      await loadOverview({ keepSettings: dirty });
    } catch (error) {
      setMessage({
        type: 'error',
        text: errorText(error, t('admin.chatHistory.retention.error', 'Failed to run retention'))
      });
    } finally {
      setRunning(false);
    }
  };

  const revokeShare = async shareId => {
    setConfirmDialog(null);
    try {
      setMessage(null);
      await makeAdminApiCall(`/admin/chat-history/shares/${encodeURIComponent(shareId)}`, {
        method: 'DELETE'
      });
      setMessage({
        type: 'success',
        text: t('admin.chatHistory.shares.revoked', 'Share revoked. The link no longer opens.')
      });
      await Promise.all([loadShares(), loadOverview({ keepSettings: dirty })]);
    } catch (error) {
      setMessage({
        type: 'error',
        text: errorText(error, t('admin.chatHistory.shares.revokeFailed', 'Failed to revoke share'))
      });
    }
  };

  const confirmRevoke = share => {
    setConfirmDialog({
      title: t('admin.chatHistory.shares.revokeTitle', 'Revoke this share?'),
      message: t('admin.chatHistory.shares.revokeMessage', {
        title: share.title || share.chatId,
        defaultValue:
          'The link to "{{title}}" stops working immediately for everyone who has it. The chat itself is not changed.'
      }),
      confirmLabel: t('admin.chatHistory.shares.revoke', 'Revoke'),
      onConfirm: () => revokeShare(share.id)
    });
  };

  const confirmRetention = target => {
    setConfirmDialog({
      target,
      title: t('admin.chatHistory.retention.confirmTitle', 'Run retention now?'),
      message: t(
        'admin.chatHistory.retention.confirmMessage',
        'Everything past the saved retention rules is deleted permanently — chats with their transcripts and ledger runs. Unsaved changes on this page are not used.'
      )
    });
  };

  if (loading || !overview || !settings) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-6xl mx-auto">
          <div className={cardClass}>
            {message ? (
              <p className="text-sm text-red-600 dark:text-red-400">{message.text}</p>
            ) : (
              <p className="text-gray-600 dark:text-gray-400">
                {t('common.loading', 'Loading...')}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const { status, stats } = overview;
  const chatStats = stats?.chats || {};
  const ledgerStats = stats?.ledger || {};
  const shareStats = stats?.shares || {};
  const retention = chatStats.retention || {};
  // `default` and `full` both record the plain user id; only `pseudonymized`
  // records a different one, which is what chat history is listed by.
  const savedIdentity = overview.settings?.runLog?.identityMode;
  const identityOwnerChange =
    savedIdentity !== settings.runLog.identityMode &&
    (savedIdentity === 'pseudonymized' || settings.runLog.identityMode === 'pseudonymized');
  const featuresLink = (
    <Link
      to="/admin/features"
      className="text-sm text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
    >
      {t('admin.chatHistory.status.openFeatures', 'Open Features')}
    </Link>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className={cardClass}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start">
              <Icon name="chat-bubble-left-right" className="w-8 h-8 mr-3 text-blue-500 shrink-0" />
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {t('admin.chatHistory.title', 'Chat History')}
                </h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {t(
                    'admin.chatHistory.description',
                    'Configure how long stored chats and the run ledger are kept, and review what is stored.'
                  )}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => loadOverview({ keepSettings: dirty })}
              disabled={refreshing}
              className="inline-flex items-center px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              <Icon
                name="arrow-path"
                className={`w-4 h-4 mr-1 ${refreshing ? 'animate-spin' : ''}`}
              />
              {t('admin.chatHistory.refresh', 'Refresh')}
            </button>
          </div>
        </div>

        {message && (
          <div
            role="status"
            className={`p-4 rounded-lg ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
            }`}
          >
            <div className="flex items-start">
              <Icon
                name={message.type === 'success' ? 'check-circle' : 'x-circle'}
                className="w-5 h-5 mr-2 shrink-0"
              />
              <p className="text-sm">{message.text}</p>
            </div>
          </div>
        )}

        {/* Status */}
        <div className={cardClass}>
          <h2 className={headingClass}>
            <Icon name="signal" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.status.title', 'Status')}
          </h2>
          <div
            className={`mb-4 p-3 rounded-md text-sm ${
              status.chatPersistenceActive
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200'
            }`}
          >
            {status.chatPersistenceActive
              ? t(
                  'admin.chatHistory.status.active',
                  'Chats of signed-in users are stored on the server.'
                )
              : t(
                  'admin.chatHistory.status.inactive',
                  'Chats are not stored on the server. Every check below must pass.'
                )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                {t('admin.chatHistory.status.chatsHeading', 'Durable chats')}
              </h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                <GateRow
                  ok={status.featureChatPersistence}
                  label={t('admin.chatHistory.status.feature', 'Durable Chats feature')}
                  detail={t(
                    'admin.chatHistory.status.featureHelp',
                    'Turned on in Admin → Features.'
                  )}
                  action={featuresLink}
                />
                <GateRow
                  ok={status.chatsEnabled}
                  label={t('admin.chatHistory.status.chatsEnabled', 'Chat storage enabled')}
                  detail={t(
                    'admin.chatHistory.status.chatsEnabledHelp',
                    'The "Store chats" setting below.'
                  )}
                />
                <GateRow
                  ok={status.storageReady}
                  label={t('admin.chatHistory.status.storage', 'Storage provider ready')}
                  detail={status.storageProvider}
                />
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                {t('admin.chatHistory.status.ledgerHeading', 'Run ledger')}
              </h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                <GateRow
                  ok={status.ledgerActive}
                  label={t('admin.chatHistory.status.ledgerActive', 'Ledger recording')}
                  detail={
                    status.ledgerForcedByChats
                      ? t(
                          'admin.chatHistory.status.ledgerForced',
                          'On because durable chats need it, even though the Run Ledger feature or setting is off.'
                        )
                      : null
                  }
                />
                <GateRow
                  ok={status.featureRunLog}
                  label={t('admin.chatHistory.status.ledgerFeature', 'Run Ledger feature')}
                  action={featuresLink}
                />
                <GateRow
                  ok={status.runLogEnabled}
                  label={t('admin.chatHistory.status.ledgerEnabled', 'Ledger enabled')}
                  detail={t(
                    'admin.chatHistory.status.ledgerEnabledHelp',
                    'The "Record the run ledger" setting below.'
                  )}
                />
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                {t('admin.chatHistory.status.sharingHeading', 'Chat sharing')}
              </h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                <GateRow
                  ok={status.chatSharingActive}
                  label={t('admin.chatHistory.status.sharingActive', 'Links can be created')}
                  detail={t(
                    'admin.chatHistory.status.sharingActiveHelp',
                    'Needs durable chats, the feature and the switch below.'
                  )}
                />
                <GateRow
                  ok={status.featureChatSharing}
                  label={t('admin.chatHistory.status.sharingFeature', 'Chat Sharing feature')}
                  action={featuresLink}
                />
                <GateRow
                  ok={status.sharingEnabled}
                  label={t('admin.chatHistory.status.sharingEnabled', 'Sharing enabled')}
                  detail={t(
                    'admin.chatHistory.status.sharingEnabledHelp',
                    'The "Allow sharing chats" setting below.'
                  )}
                />
              </ul>
            </div>
          </div>
        </div>

        {/* Statistics */}
        <div className={cardClass}>
          <h2 className={headingClass}>
            <Icon name="chart-bar" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.stats.title', 'Stored chats')}
          </h2>
          {!chatStats.available ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.chatHistory.stats.unavailable',
                'The storage provider is not available, so stored chats cannot be counted.'
              )}
            </p>
          ) : (
            <div className="space-y-6">
              {chatStats.truncated && (
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  {t('admin.chatHistory.stats.truncated', {
                    count: chatStats.scanned,
                    defaultValue:
                      'Only the first {{count}} chats were counted; the numbers below are incomplete.'
                  })}
                </p>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile
                  label={t('admin.chatHistory.stats.chats', 'Chats')}
                  value={formatNumber(chatStats.totalChats)}
                />
                <StatTile
                  label={t('admin.chatHistory.stats.messages', 'Messages')}
                  value={formatNumber(chatStats.totalMessages)}
                />
                <StatTile
                  label={t('admin.chatHistory.stats.users', 'Users with chats')}
                  value={formatNumber(chatStats.totalUsers)}
                />
                <StatTile
                  label={t('admin.chatHistory.stats.active', 'Active (24h / 7d)')}
                  value={`${formatNumber(chatStats.activeLast24h)} / ${formatNumber(chatStats.activeLast7d)}`}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <CountList
                  title={t('admin.chatHistory.stats.byStatus', 'By status')}
                  counts={chatStats.byStatus}
                />
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.chatHistory.stats.activity', 'Activity')}
                  </h3>
                  <dl className="text-sm space-y-1 text-gray-700 dark:text-gray-300">
                    <div className="flex justify-between gap-2">
                      <dt>{t('admin.chatHistory.stats.oldest', 'Oldest activity')}</dt>
                      <dd>{formatDate(chatStats.oldestActivityAt)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>{t('admin.chatHistory.stats.newest', 'Latest activity')}</dt>
                      <dd>{formatDate(chatStats.newestActivityAt)}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.chatHistory.stats.nextSweep', 'Next retention sweep')}
                  </h3>
                  <dl className="text-sm space-y-1 text-gray-700 dark:text-gray-300">
                    <div className="flex justify-between gap-2">
                      <dt>{t('admin.chatHistory.stats.expiring', 'Expired by age')}</dt>
                      <dd>{formatNumber(retention.expiringByAge)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>{t('admin.chatHistory.stats.overQuota', 'Over the per-user limit')}</dt>
                      <dd>
                        {formatNumber(retention.chatsOverQuota)}
                        {retention.usersOverQuota > 0 &&
                          ` (${t('admin.chatHistory.stats.usersCount', {
                            count: retention.usersOverQuota,
                            defaultValue: '{{count}} user(s)'
                          })})`}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>{t('admin.chatHistory.stats.atCap', 'At the message limit')}</dt>
                      <dd>{formatNumber(retention.chatsAtMessageCap)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>{t('admin.chatHistory.stats.nearCap', 'Near the message limit')}</dt>
                      <dd>{formatNumber(retention.chatsNearMessageCap)}</dd>
                    </div>
                  </dl>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <TopTable
                  t={t}
                  title={t('admin.chatHistory.stats.topApps', 'Top apps')}
                  rows={chatStats.topApps}
                  keyName="appId"
                  keyLabel={t('admin.chatHistory.stats.app', 'App')}
                />
                <TopTable
                  t={t}
                  title={t('admin.chatHistory.stats.topUsers', 'Top users')}
                  rows={chatStats.topUsers}
                  keyName="ownerId"
                  keyLabel={t('admin.chatHistory.stats.user', 'User')}
                />
              </div>
            </div>
          )}

          <h2 className={`${headingClass} mt-8`}>
            <Icon name="database" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.stats.ledgerTitle', 'Run ledger')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <StatTile
              label={t('admin.chatHistory.stats.runs', 'Recorded runs')}
              value={formatNumber(ledgerStats.totalExecutions)}
            />
            <StatTile
              label={t('admin.chatHistory.stats.ledgerUsers', 'Users')}
              value={formatNumber(ledgerStats.totalUsers)}
            />
            <CountList
              title={t('admin.chatHistory.stats.byKind', 'By kind')}
              counts={ledgerStats.byKind}
            />
            <CountList
              title={t('admin.chatHistory.stats.byStatus', 'By status')}
              counts={ledgerStats.byStatus}
            />
          </div>

          <h2 className={`${headingClass} mt-8`}>
            <Icon name="link" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.shares.title', 'Shared chats')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <StatTile
              label={t('admin.chatHistory.shares.total', 'Shares')}
              value={formatNumber(shareStats.total)}
              hint={
                shareStats.truncated
                  ? t('admin.chatHistory.shares.truncated', 'Counted up to the scan limit')
                  : undefined
              }
            />
            <StatTile
              label={t('admin.chatHistory.shares.active', 'Active links')}
              value={formatNumber(shareStats.byState?.active)}
            />
            <StatTile
              label={t('admin.chatHistory.shares.views', 'Link opens')}
              value={formatNumber(shareStats.views)}
            />
            <CountList
              title={t('admin.chatHistory.shares.byMode', 'Active by audience')}
              counts={shareStats.activeByMode}
            />
          </div>
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.chatHistory.shares.listTitle', 'Recent shares')}
            </h3>
            {shares.items.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('admin.chatHistory.shares.empty', 'No chat has been shared yet.')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      <th className="py-2 pr-4">{t('admin.chatHistory.shares.chat', 'Chat')}</th>
                      <th className="py-2 pr-4">{t('admin.chatHistory.shares.owner', 'Owner')}</th>
                      <th className="py-2 pr-4">
                        {t('admin.chatHistory.shares.audience', 'Audience')}
                      </th>
                      <th className="py-2 pr-4">
                        {t('admin.chatHistory.shares.stateLabel', 'State')}
                      </th>
                      <th className="py-2 pr-4">
                        {t('admin.chatHistory.shares.viewsLabel', 'Views')}
                      </th>
                      <th className="py-2 pr-4">
                        {t('admin.chatHistory.shares.created', 'Created')}
                      </th>
                      <th className="py-2 pr-4">
                        {t('admin.chatHistory.shares.expires', 'Expires')}
                      </th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700 text-gray-700 dark:text-gray-200">
                    {shares.items.map(share => (
                      <tr key={share.id}>
                        <td className="py-2 pr-4 max-w-xs">
                          <span className="block truncate" title={share.chatId}>
                            {share.title || share.chatId}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <span className="block truncate max-w-40" title={share.ownerId}>
                            {share.ownerName || share.ownerId}
                          </span>
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {shareModeLabel(share.mode, t)}
                          {share.mode === 'users' &&
                            share.recipientCount > 0 &&
                            ` (${share.recipientCount})`}
                        </td>
                        <td className="py-2 pr-4">
                          <ShareStateBadge state={share.state} t={t} />
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {formatNumber(share.viewCount)}
                          {share.maxViews ? ` / ${formatNumber(share.maxViews)}` : ''}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {formatDate(share.createdAt)}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {share.expiresAt ? formatDate(share.expiresAt) : '—'}
                        </td>
                        <td className="py-2 text-right">
                          {share.state === 'active' && (
                            <button
                              type="button"
                              onClick={() => confirmRevoke(share)}
                              className="text-xs text-red-600 dark:text-red-400 hover:underline"
                            >
                              {t('admin.chatHistory.shares.revoke', 'Revoke')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shares.truncated && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {t(
                      'admin.chatHistory.shares.listTruncated',
                      'Only the newest shares are listed.'
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Durable chat settings */}
        <div className={cardClass}>
          <h2 className={headingClass}>
            <Icon name="chat-bubble-left-right" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.chats.title', 'Durable chats')}
          </h2>
          <div className="space-y-4">
            <CheckboxField
              id="chats-enabled"
              label={t('admin.chatHistory.chats.enabled', 'Store chats')}
              help={t(
                'admin.chatHistory.chats.enabledHelp',
                'Master switch for writing chats to storage. Also requires the Durable Chats feature. Turning it off stops new writes, hides the history from users and pauses the retention sweep; stored chats stay on disk.'
              )}
              checked={settings.chats.enabled}
              onChange={value => updateSetting('chats', 'enabled', value)}
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <NumberField
                id="chats-retention"
                label={t('admin.chatHistory.chats.retentionDays', 'Retention (days)')}
                help={t(
                  'admin.chatHistory.chats.retentionDaysHelp',
                  'Chats with no activity for this many days are deleted by the daily sweep. 0 keeps chats forever.'
                )}
                value={settings.chats.retentionDays}
                onChange={value => updateSetting('chats', 'retentionDays', value)}
              />
              <NumberField
                id="chats-max-per-user"
                label={t('admin.chatHistory.chats.maxChatsPerUser', 'Chats per user')}
                help={t(
                  'admin.chatHistory.chats.maxChatsPerUserHelp',
                  'Each user keeps this many most recent chats; older ones are deleted by the daily sweep. 0 removes the limit.'
                )}
                value={settings.chats.maxChatsPerUser}
                onChange={value => updateSetting('chats', 'maxChatsPerUser', value)}
              />
              <NumberField
                id="chats-max-messages"
                label={t('admin.chatHistory.chats.maxMessagesPerChat', 'Messages per chat')}
                help={t(
                  'admin.chatHistory.chats.maxMessagesPerChatHelp',
                  'Oldest messages are dropped once a chat grows past this. Applied on every write, without a restart. 0 removes the limit.'
                )}
                value={settings.chats.maxMessagesPerChat}
                onChange={value => updateSetting('chats', 'maxMessagesPerChat', value)}
              />
            </div>
          </div>
        </div>

        {/* Chat sharing settings */}
        <div className={cardClass}>
          <h2 className={headingClass}>
            <Icon name="link" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.sharing.title', 'Chat sharing')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.chatHistory.sharing.description',
              'Read-only links onto stored chats. Also requires the Chat Sharing feature. A link is a copy of the chat as it was when it was shared; uploaded files are never part of it.'
            )}
          </p>
          <div className="space-y-4">
            <CheckboxField
              id="sharing-enabled"
              label={t('admin.chatHistory.sharing.enabled', 'Allow sharing chats')}
              help={t(
                'admin.chatHistory.sharing.enabledHelp',
                'Turning it off stops new links and closes existing ones until it is turned on again.'
              )}
              checked={settings.sharing.enabled}
              onChange={value => updateSetting('sharing', 'enabled', value)}
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <CheckboxField
                id="sharing-allow-users"
                label={t('admin.chatHistory.sharing.allowUsers', 'Links for specific users')}
                help={t(
                  'admin.chatHistory.sharing.allowUsersHelp',
                  'The owner picks recipients from the user database; they sign in to open the link.'
                )}
                checked={settings.sharing.allowUsers}
                onChange={value => updateSetting('sharing', 'allowUsers', value)}
              />
              <CheckboxField
                id="sharing-allow-authenticated"
                label={t(
                  'admin.chatHistory.sharing.allowAuthenticated',
                  'Links for anyone signed in'
                )}
                help={t(
                  'admin.chatHistory.sharing.allowAuthenticatedHelp',
                  'Anyone with an account here who has the link.'
                )}
                checked={settings.sharing.allowAuthenticated}
                onChange={value => updateSetting('sharing', 'allowAuthenticated', value)}
              />
              <CheckboxField
                id="sharing-allow-public"
                label={t('admin.chatHistory.sharing.allowPublic', 'Public links (no sign-in)')}
                help={t(
                  'admin.chatHistory.sharing.allowPublicHelp',
                  'Anyone on the internet who has the link, without signing in. Owners see a warning before they create one.'
                )}
                checked={settings.sharing.allowPublic}
                onChange={value => updateSetting('sharing', 'allowPublic', value)}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <NumberField
                id="sharing-default-expiry"
                label={t('admin.chatHistory.sharing.defaultExpiryDays', 'Default expiry (days)')}
                help={t(
                  'admin.chatHistory.sharing.defaultExpiryDaysHelp',
                  'Expiry a new link gets when its owner picks none. 0 means links do not expire by default.'
                )}
                value={settings.sharing.defaultExpiryDays}
                onChange={value => updateSetting('sharing', 'defaultExpiryDays', value)}
              />
              <NumberField
                id="sharing-max-expiry"
                label={t('admin.chatHistory.sharing.maxExpiryDays', 'Longest expiry (days)')}
                help={t(
                  'admin.chatHistory.sharing.maxExpiryDaysHelp',
                  'Owners cannot pick a later expiry, and "never" is no longer offered. 0 removes the limit.'
                )}
                value={settings.sharing.maxExpiryDays}
                onChange={value => updateSetting('sharing', 'maxExpiryDays', value)}
              />
              <NumberField
                id="sharing-max-views"
                label={t('admin.chatHistory.sharing.maxViewsCap', 'Most views per link')}
                help={t(
                  'admin.chatHistory.sharing.maxViewsCapHelp',
                  'Owners cannot allow more opens than this, and "unlimited" is no longer offered. 0 removes the limit.'
                )}
                value={settings.sharing.maxViewsCap}
                onChange={value => updateSetting('sharing', 'maxViewsCap', value)}
              />
            </div>
          </div>
        </div>

        {/* Run ledger settings */}
        <div className={cardClass}>
          <h2 className={headingClass}>
            <Icon name="database" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.chatHistory.ledger.title', 'Run ledger')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.chatHistory.ledger.description',
              'An append-only event log per run (chats, workflows, agents). Durable chats are rebuilt from it, so it records whenever durable chats are active.'
            )}
          </p>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CheckboxField
                id="ledger-enabled"
                label={t('admin.chatHistory.ledger.enabled', 'Record the run ledger')}
                help={t(
                  'admin.chatHistory.ledger.enabledHelp',
                  'Also requires the Run Ledger feature.'
                )}
                checked={settings.runLog.enabled}
                onChange={value => updateSetting('runLog', 'enabled', value)}
              />
              <CheckboxField
                id="ledger-cleanup"
                label={t('admin.chatHistory.ledger.cleanupEnabled', 'Delete old runs daily')}
                help={t(
                  'admin.chatHistory.ledger.cleanupEnabledHelp',
                  'When off, ledger runs are kept regardless of the retention below.'
                )}
                checked={settings.runLog.cleanupEnabled}
                onChange={value => updateSetting('runLog', 'cleanupEnabled', value)}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="ledger-identity"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('admin.chatHistory.ledger.identityMode', 'Identity in the ledger')}
                </label>
                <select
                  id="ledger-identity"
                  value={settings.runLog.identityMode}
                  onChange={e => updateSetting('runLog', 'identityMode', e.target.value)}
                  className={inputClass}
                >
                  <option value="default">
                    {t('admin.chatHistory.ledger.identityDefault', 'Default — user id')}
                  </option>
                  <option value="full">
                    {t(
                      'admin.chatHistory.ledger.identityFull',
                      'Full — user id, name, email and groups'
                    )}
                  </option>
                  <option value="pseudonymized">
                    {t(
                      'admin.chatHistory.ledger.identityPseudonymized',
                      'Pseudonymized — a stable hash instead of the user id'
                    )}
                  </option>
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t(
                    'admin.chatHistory.ledger.identityModeHelp',
                    'Applies to runs and chats started after saving. Existing ones keep the identity they were recorded with.'
                  )}
                </p>
                {identityOwnerChange && (
                  <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
                    {t(
                      'admin.chatHistory.ledger.identityModeWarning',
                      "Switching to or from pseudonymized changes the id chats are listed under: chats stored before the switch no longer appear in their owners' history lists."
                    )}
                  </p>
                )}
              </div>
              <NumberField
                id="ledger-retention"
                label={t('admin.chatHistory.ledger.retentionDays', 'Retention (days)')}
                help={t(
                  'admin.chatHistory.ledger.retentionDaysHelp',
                  'Runs older than this are deleted by the daily cleanup. 0 keeps runs forever.'
                )}
                value={settings.runLog.retentionDays}
                onChange={value => updateSetting('runLog', 'retentionDays', value)}
              />
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-700 dark:text-gray-300 font-medium">
                {t('admin.chatHistory.ledger.advanced', 'Advanced')}
              </summary>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <NumberField
                  id="ledger-spill"
                  min={1}
                  label={t(
                    'admin.chatHistory.ledger.spillThresholdBytes',
                    'Spill threshold (bytes)'
                  )}
                  help={t(
                    'admin.chatHistory.ledger.spillThresholdBytesHelp',
                    'Event payloads larger than this are stored as a separate file instead of inline.'
                  )}
                  value={settings.runLog.spillThresholdBytes}
                  onChange={value => updateSetting('runLog', 'spillThresholdBytes', value)}
                />
                <NumberField
                  id="ledger-flush"
                  min={1}
                  label={t('admin.chatHistory.ledger.flushIntervalMs', 'Flush interval (ms)')}
                  help={t(
                    'admin.chatHistory.ledger.flushIntervalMsHelp',
                    'How long ledger writes are buffered before reaching disk. Requires a restart.'
                  )}
                  value={settings.runLog.flushIntervalMs}
                  onChange={value => updateSetting('runLog', 'flushIntervalMs', value)}
                />
              </div>
            </details>
          </div>
        </div>

        {/* Actions */}
        <div
          className={`${cardClass} flex flex-col md:flex-row md:items-center gap-4 md:justify-between`}
        >
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => confirmRetention('all')}
              disabled={running}
              className="inline-flex items-center px-4 py-2 text-sm border border-red-300 dark:border-red-700 rounded-md text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              <Icon name="trash" className="w-4 h-4 mr-2" />
              {running
                ? t('admin.chatHistory.retention.running', 'Running…')
                : t('admin.chatHistory.retention.run', 'Run retention now')}
            </button>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="inline-flex items-center justify-center px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Icon name="save" className="w-4 h-4 mr-2" />
            {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={
          confirmDialog?.confirmLabel ?? t('admin.chatHistory.retention.confirm', 'Delete now')
        }
        danger
        onConfirm={() =>
          confirmDialog?.onConfirm
            ? confirmDialog.onConfirm()
            : runRetention(confirmDialog?.target || 'all')
        }
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminChatHistoryPage;
