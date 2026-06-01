import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  fetchAgentProfiles,
  toggleAgentProfile,
  deleteAgentProfile,
  triggerAgentRun
} from '../../../api/agentsAdminApi';
import { useFilterState } from '../hooks/useFilterState';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';

export default function AdminAgentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const [q, setQ] = useFilterState('q', '');
  const [enabled, setEnabled] = useFilterState('enabled', 'all');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const data = await fetchAgentProfiles();
      setProfiles(data?.data || data || []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(id) {
    try {
      const res = await toggleAgentProfile(id);
      const newEnabled = res?.data?.enabled;
      setProfiles(prev => prev.map(p => (p.id === id ? { ...p, enabled: newEnabled } : p)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function confirmDelete() {
    const id = pendingDeleteId;
    if (!id) return;
    setPendingDeleteId(null);
    try {
      await deleteAgentProfile(id);
      setProfiles(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleTrigger(id) {
    setError(null);
    try {
      const res = await triggerAgentRun(id, {});
      const runId = res?.data?.executionId;
      if (runId) {
        navigate(`/admin/agents/runs/${runId}`);
      } else {
        setError(
          t('admin.agents.triggerSucceeded', 'Triggered: {{details}}', {
            details: JSON.stringify(res?.data)
          })
        );
      }
    } catch (err) {
      setError(
        t('admin.agents.triggerFailed', 'Trigger failed: {{message}}', {
          message: err?.response?.data?.message || err.message
        })
      );
    }
  }

  const filteredProfiles = profiles.filter(p => {
    const name = (p.name?.en || p.id || '').toLowerCase();
    if (q && !name.includes(q.toLowerCase()) && !p.id.toLowerCase().includes(q.toLowerCase())) {
      return false;
    }
    if (enabled === 'enabled' && !p.enabled) return false;
    if (enabled === 'disabled' && p.enabled) return false;
    return true;
  });

  const columns = [
    {
      key: 'name',
      header: t('admin.agents.col.name', 'Name'),
      sortable: true,
      sortAccessor: p => p.name?.en || p.id,
      render: p => (
        <span className="font-medium text-gray-900 dark:text-gray-100">{p.name?.en || p.id}</span>
      )
    },
    {
      key: 'id',
      header: t('admin.agents.col.id', 'ID'),
      sortable: true,
      hideBelow: 'md',
      render: p => (
        <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{p.id}</span>
      )
    },
    {
      key: 'inbox',
      header: t('admin.agents.col.inbox', 'Inbox'),
      hideBelow: 'lg',
      render: p => p.inboxId || '—'
    },
    {
      key: 'schedule',
      header: t('admin.agents.col.schedule', 'Schedule'),
      hideBelow: 'lg',
      render: p => {
        const schedule = (p.workflow?.definition?.triggers || []).find(
          tr => tr.type === 'schedule'
        );
        return <span className="font-mono text-xs">{schedule?.config?.cron || '—'}</span>;
      }
    },
    {
      key: 'enabled',
      header: t('admin.agents.col.enabled', 'Enabled'),
      sortable: true,
      sortAccessor: p => (p.enabled ? 1 : 0),
      render: p => (
        <button
          onClick={e => {
            e.stopPropagation();
            handleToggle(p.id);
          }}
          aria-label={t('admin.agents.action.toggleAriaLabel', 'Toggle agent {{name}}', {
            name: p.name?.en || p.id
          })}
          className={`px-2 py-1 text-xs rounded font-medium ${
            p.enabled
              ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
          }`}
        >
          {p.enabled ? t('admin.agents.action.on', 'On') : t('admin.agents.action.off', 'Off')}
        </button>
      )
    }
  ];

  const actions = [
    {
      id: 'run',
      label: t('admin.agents.action.run', 'Run'),
      icon: 'play',
      priority: 'primary',
      onClick: p => handleTrigger(p.id)
    },
    {
      id: 'edit',
      label: t('common.edit', 'Edit'),
      icon: 'pencil',
      onClick: p => navigate(`/admin/agents/${p.id}`)
    },
    {
      id: 'runs',
      label: t('admin.agents.action.runs', 'Runs'),
      icon: 'clock',
      onClick: p => navigate(`/admin/agents/${p.id}/runs`)
    },
    {
      id: 'delete',
      label: t('admin.agents.action.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: p => setPendingDeleteId(p.id)
    }
  ];

  return (
    <>
      <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
        <div className="max-w-7xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.agents.title', 'Agent Profiles')}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.agents.subtitle',
                  'Manage autonomous agents that run on schedules, webhooks, or manual triggers.'
                )}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => navigate('/admin/agents/inboxes')}
                className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t('admin.agents.manageInboxes', 'Manage Inboxes')}
              </button>
              <button
                onClick={() => navigate('/admin/agents/approvals')}
                className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t('admin.agents.approvals', 'Pending Approvals')}
              </button>
              <button
                onClick={() => navigate('/admin/agents/new')}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
              >
                {t('admin.agents.new', 'New Profile')}
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
              {error}
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder={t('admin.agents.searchPlaceholder', 'Search by name or ID…')}
            />
            <FilterSelect
              label={t('common.status', 'Status')}
              value={enabled}
              onChange={setEnabled}
              options={[
                { value: 'all', label: t('common.all', 'All') },
                { value: 'enabled', label: t('common.enabled', 'Enabled') },
                { value: 'disabled', label: t('common.disabled', 'Disabled') }
              ]}
            />
          </div>

          <DataTable
            columns={columns}
            data={filteredProfiles}
            getRowId={p => p.id}
            actions={actions}
            loading={loading}
            empty={{
              icon: 'cpu-chip',
              title: t('admin.agents.empty', 'No agent profiles yet'),
              description: t(
                'admin.agents.emptyDescription',
                'Create your first profile to get started.'
              )
            }}
          />
        </div>
      </div>
      <ConfirmDialog
        isOpen={!!pendingDeleteId}
        danger
        title={t('admin.agents.deleteTitle', 'Delete profile')}
        message={t(
          'admin.agents.deleteMessage',
          'Delete agent profile "{{id}}"? This cannot be undone.',
          { id: pendingDeleteId || '' }
        )}
        confirmLabel={t('admin.agents.action.delete', 'Delete')}
        onConfirm={confirmDelete}
        onDeny={() => setPendingDeleteId(null)}
      />
    </>
  );
}
