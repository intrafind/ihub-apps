import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
    return <div className="p-8 text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading…')}</div>;
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.agents.memory.title', 'Memory — {{profileId}}', { profileId })}
          </h1>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50"
            >
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
            <button
              onClick={() => navigate(`/admin/agents/${profileId}`)}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded"
            >
              {t('admin.agents.memory.backToProfile', 'Back to profile')}
            </button>
          </div>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {t('admin.agents.memory.versionLine', 'Version {{version}}{{updatedSuffix}}', {
            version,
            updatedSuffix: updatedAt ? ` · updated ${updatedAt}` : ''
          })}
        </div>
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
            {error}
          </div>
        )}
        <textarea
          className="w-full h-[500px] font-mono text-sm p-3 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          value={body}
          onChange={e => setBody(e.target.value)}
        />
      </div>
    </div>
  );
}
