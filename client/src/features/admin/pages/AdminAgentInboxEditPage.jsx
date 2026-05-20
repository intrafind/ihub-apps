import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchInbox, writeInbox } from '../../../api/agentsAdminApi';

export default function AdminAgentInboxEditPage() {
  const navigate = useNavigate();
  const { inboxId } = useParams();
  const [body, setBody] = useState('');
  const [version, setVersion] = useState(0);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchInbox(inboxId);
        const data = res?.data || {};
        setBody(data.body || '');
        setItems(data.items || []);
        setVersion(data.version || 0);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [inboxId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await writeInbox(inboxId, body, version);
      setVersion(res?.data?.version || version + 1);
    } catch (err) {
      const code = err?.response?.data?.error;
      setError(code === 'VERSION_CONFLICT' ? 'Conflict — reload required' : err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-4xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-2xl font-bold">Inbox — {inboxId}</h1>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-indigo-600 text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => navigate('/admin/agents/inboxes')}
                className="px-4 py-2 border bg-white rounded"
              >
                Back
              </button>
            </div>
          </div>
          <div className="text-xs text-gray-500 mb-2">
            Version {version} · {items.length} items
          </div>
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}

          {loading ? (
            <div>Loading…</div>
          ) : (
            <textarea
              className="w-full h-[500px] font-mono text-sm p-3 border rounded"
              value={body}
              onChange={e => setBody(e.target.value)}
            />
          )}
        </div>
      </div>
    </AdminAuth>
  );
}
