import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchAgentMemory, writeAgentMemory } from '../../../api/agentsAdminApi';

export default function AdminAgentMemoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profileId } = useParams();
  const [body, setBody] = useState('');
  const [version, setVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchAgentMemory(profileId);
        const data = res?.data || {};
        setBody(data.body || '');
        setVersion(data.version || 0);
        setUpdatedAt(data.updatedAt || null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await writeAgentMemory(profileId, {
        content: body,
        expectedVersion: version
      });
      setVersion(res?.data?.version || version + 1);
    } catch (err) {
      const code = err?.response?.data?.error;
      if (code === 'VERSION_CONFLICT') {
        setError(
          t(
            'admin.agents.memory.versionConflict',
            'Conflict: memory was modified elsewhere. Reload to see the latest.'
          )
        );
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="p-8">{t('common.loading', 'Loading…')}</div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-4xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-2xl font-bold">
              {t('admin.agents.memory.title', 'Memory — {{profileId}}', { profileId })}
            </h1>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-indigo-600 text-white rounded disabled:opacity-50"
              >
                {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
              <button
                onClick={() => navigate(`/admin/agents/${profileId}`)}
                className="px-4 py-2 border bg-white rounded"
              >
                {t('admin.agents.memory.backToProfile', 'Back to profile')}
              </button>
            </div>
          </div>
          <div className="text-xs text-gray-500 mb-2">
            {t('admin.agents.memory.versionLine', 'Version {{version}}{{updatedSuffix}}', {
              version,
              updatedSuffix: updatedAt ? ` · updated ${updatedAt}` : ''
            })}
          </div>
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}
          <textarea
            className="w-full h-[500px] font-mono text-sm p-3 border rounded"
            value={body}
            onChange={e => setBody(e.target.value)}
          />
        </div>
      </div>
    </AdminAuth>
  );
}
