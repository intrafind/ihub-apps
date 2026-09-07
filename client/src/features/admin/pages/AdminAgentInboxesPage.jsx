import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchInboxes, createInbox } from '../../../api/agentsAdminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';

import { getAdminApiErrorMessage } from '../../../api/adminApi';
export default function AdminAgentInboxesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [inboxes, setInboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [newId, setNewId] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchInboxes();
      setInboxes(res?.data || []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    const trimmed = newId.trim();
    if (!trimmed) {
      setLocalError(t('admin.agents.inboxes.idRequired', 'Inbox ID is required.'));
      return;
    }
    try {
      await createInbox(trimmed, `# ${trimmed}\n`);
      setNewId('');
      setLocalError(null);
      // Drop straight into the editor so the user can add items immediately.
      navigate(`/admin/agents/inboxes/${trimmed}`);
    } catch (err) {
      setError(err?.response?.data?.message || err.message);
    }
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.title', 'Admin'), href: '/admin' },
            { label: t('admin.agents.title', 'Agent Profiles'), href: '/admin/agents' },
            { label: t('admin.agents.inboxes.title', 'Agent Inboxes') }
          ]}
        />
        <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-gray-100">
          {t('admin.agents.inboxes.title', 'Agent Inboxes')}
        </h1>
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
            {error}
          </div>
        )}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-4 mb-6">
          <h2 className="text-sm font-semibold mb-2 text-gray-900 dark:text-gray-100">
            {t('admin.agents.inboxes.createHeading', 'Create inbox')}
          </h2>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="engineering-todos"
              value={newId}
              onChange={e => {
                setNewId(e.target.value);
                if (localError) setLocalError(null);
              }}
              className="flex-1 border-gray-300 dark:border-gray-600 rounded shadow-sm text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            />
            <button
              onClick={handleCreate}
              className="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
            >
              {t('common.create', 'Create')}
            </button>
          </div>
          {localError && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{localError}</p>
          )}
        </div>
        {loading ? (
          <div className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading…')}</div>
        ) : (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {t('admin.agents.inboxes.col.id', 'ID')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {t('admin.agents.inboxes.col.open', 'Open')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {t('admin.agents.inboxes.col.total', 'Total')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {t('admin.agents.inboxes.col.updated', 'Updated')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {t('admin.agents.inboxes.col.actions', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {inboxes.map(inbox => (
                  <tr
                    key={inbox.inboxId}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-sm text-gray-900 dark:text-gray-100">
                      {inbox.inboxId}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {inbox.openCount}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {inbox.totalCount}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {inbox.updatedAt || '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => navigate(`/admin/agents/inboxes/${inbox.inboxId}`)}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline text-sm"
                      >
                        {t('common.edit', 'Edit')}
                      </button>
                    </td>
                  </tr>
                ))}
                {inboxes.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-gray-500 dark:text-gray-400"
                    >
                      {t('admin.agents.inboxes.empty', 'No inboxes yet.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
