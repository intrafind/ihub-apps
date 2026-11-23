// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchAgentRuns } from '../../../api/agentsAdminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { DataTable } from '../components/data-table';
import StatusBadge from '../../workflows/components/StatusBadge';

import { getAdminApiErrorMessage } from '../../../api/adminApi';
const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 30000;

function formatTimestamp(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}

export default function AgentRunsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profileId } = useParams();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    let timer;

    async function load() {
      let hasActiveRun = true;
      try {
        const res = await fetchAgentRuns(profileId ? { profileId } : {});
        if (!mounted) return;
        const data = res?.data?.items ?? [];
        setRuns(data);
        setError(null);
        hasActiveRun = data.some(r => r.status === 'running' || r.status === 'paused');
      } catch (err) {
        if (mounted) setError(getAdminApiErrorMessage(err));
      } finally {
        if (mounted) setLoading(false);
      }
      if (mounted) timer = setTimeout(load, hasActiveRun ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }

    void load();

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [profileId]);

  const columns = [
    {
      key: 'executionId',
      header: t('admin.agents.runs.col.runId', 'Run ID'),
      sortable: true,
      render: r => (
        <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{r.executionId}</span>
      )
    },
    {
      key: 'profile',
      header: t('admin.agents.runs.col.profile', 'Profile'),
      sortable: true,
      sortAccessor: r => (r.userId || '').replace(/^agent:/, ''),
      render: r => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {(r.userId || '').replace(/^agent:/, '')}
        </span>
      )
    },
    {
      key: 'status',
      header: t('common.status', 'Status'),
      sortable: true,
      render: r => <StatusBadge status={r.status} />
    },
    {
      key: 'startedAt',
      header: t('admin.agents.runs.col.started', 'Started'),
      sortable: true,
      sortAccessor: r => r.startedAt || r.createdAt || '',
      render: r => (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {formatTimestamp(r.startedAt || r.createdAt)}
        </span>
      )
    }
  ];

  const actions = [
    {
      id: 'view',
      label: t('common.view', 'View'),
      icon: 'eye',
      onClick: r => navigate(`/admin/agents/runs/${r.executionId}`)
    }
  ];

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-6xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('documentTitle.admin', 'Admin'), href: '/admin' },
            { label: t('admin.agents.title', 'Agent Profiles'), href: '/admin/agents' },
            ...(profileId ? [{ label: profileId, href: `/admin/agents/${profileId}` }] : []),
            { label: t('admin.agents.runs.title', 'Runs') }
          ]}
        />
        <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-gray-100">
          {profileId
            ? t('admin.agents.runs.pageTitleFor', 'Agent Runs — {{profileId}}', { profileId })
            : t('admin.agents.runs.pageTitle', 'Agent Runs')}
        </h1>
        {/* The table shows a load error itself, never as "No runs yet" (the page polls on). */}
        <DataTable
          columns={columns}
          data={runs}
          getRowId={r => r.executionId}
          actions={actions}
          loading={loading}
          error={error}
          defaultSort={{ column: 'startedAt', direction: 'desc' }}
          empty={{
            icon: 'clock',
            title: t('admin.agents.runs.empty', 'No runs yet.')
          }}
        />
      </div>
    </div>
  );
}
