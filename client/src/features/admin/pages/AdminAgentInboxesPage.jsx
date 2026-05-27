import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchInboxes, createInbox } from '../../../api/agentsAdminApi';

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
      setError(err.message);
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
    <div className="bg-gray-50 min-h-screen">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <h1 className="text-2xl font-bold mb-6">
          {t('admin.agents.inboxes.title', 'Agent Inboxes')}
        </h1>
        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
            {error}
          </div>
        )}
        <div className="bg-white border rounded p-4 mb-6">
          <h2 className="text-sm font-semibold mb-2">
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
              className="flex-1 border-gray-300 rounded shadow-sm text-sm"
            />
            <button
              onClick={handleCreate}
              className="px-3 py-2 text-sm bg-indigo-600 text-white rounded"
            >
              {t('common.create', 'Create')}
            </button>
          </div>
          {localError && <p className="mt-2 text-xs text-red-600">{localError}</p>}
        </div>
        {loading ? (
          <div>{t('common.loading', 'Loading…')}</div>
        ) : (
          <div className="bg-white border rounded">
            <table className="min-w-full">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-semibold uppercase">
                  <th className="px-4 py-3">{t('admin.agents.inboxes.col.id', 'ID')}</th>
                  <th className="px-4 py-3">{t('admin.agents.inboxes.col.open', 'Open')}</th>
                  <th className="px-4 py-3">{t('admin.agents.inboxes.col.total', 'Total')}</th>
                  <th className="px-4 py-3">{t('admin.agents.inboxes.col.updated', 'Updated')}</th>
                  <th className="px-4 py-3 text-right">
                    {t('admin.agents.inboxes.col.actions', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {inboxes.map(inbox => (
                  <tr key={inbox.inboxId} className="border-t">
                    <td className="px-4 py-3 font-mono">{inbox.inboxId}</td>
                    <td className="px-4 py-3">{inbox.openCount}</td>
                    <td className="px-4 py-3">{inbox.totalCount}</td>
                    <td className="px-4 py-3 text-xs">{inbox.updatedAt || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => navigate(`/admin/agents/inboxes/${inbox.inboxId}`)}
                        className="text-indigo-600 hover:underline"
                      >
                        {t('common.edit', 'Edit')}
                      </button>
                    </td>
                  </tr>
                ))}
                {inboxes.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
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
