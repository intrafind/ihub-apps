import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';

const AdminShortLinks = () => {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [appIdFilter, setAppIdFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');

  const loadLinks = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (appIdFilter) params.set('appId', appIdFilter);
      if (userFilter) params.set('userId', userFilter);
      const resp = await fetch(`/api/shortlinks?${params.toString()}`);
      if (!resp.ok) throw new Error('Failed to load links');
      const data = await resp.json();
      setLinks(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLinks();
  }, []);

  const handleDelete = async (code) => {
    if (!window.confirm('Delete this link?')) return;
    await fetch(`/api/shortlinks/${code}`, { method: 'DELETE' });
    setLinks(l => l.filter(link => link.code !== code));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-3xl font-bold text-gray-900">Short Links</h1>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        <div className="flex gap-4">
          <input
            className="border rounded px-2 py-1 flex-1"
            placeholder="Filter by App ID"
            value={appIdFilter}
            onChange={e => setAppIdFilter(e.target.value)}
          />
          <input
            className="border rounded px-2 py-1 flex-1"
            placeholder="Filter by User"
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
          />
          <button
            className="px-3 py-1 bg-indigo-600 text-white rounded"
            onClick={loadLinks}
          >
            Search
          </button>
        </div>

        {loading ? (
          <div>Loading...</div>
        ) : error ? (
          <div className="text-red-600">{error}</div>
        ) : (
          <div className="overflow-x-auto shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-sm font-medium text-gray-500">Code</th>
                  <th className="px-2 py-1 text-left text-sm font-medium text-gray-500">App</th>
                  <th className="px-2 py-1 text-left text-sm font-medium text-gray-500">User</th>
                  <th className="px-2 py-1 text-left text-sm font-medium text-gray-500">Usage</th>
                  <th className="px-2 py-1 text-left text-sm font-medium text-gray-500">Created</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {links.map(link => (
                  <tr key={link.code}>
                    <td className="px-2 py-1">
                      <a href={`/s/${link.code}`} className="text-indigo-600 underline" target="_blank" rel="noreferrer">
                        {link.code}
                      </a>
                    </td>
                    <td className="px-2 py-1">{link.appId || '-'}</td>
                    <td className="px-2 py-1">{link.userId || '-'}</td>
                    <td className="px-2 py-1">{link.usage || 0}</td>
                    <td className="px-2 py-1">{new Date(link.createdAt).toLocaleString()}</td>
                    <td className="px-2 py-1 text-right">
                      <button onClick={() => handleDelete(link.code)} className="text-red-600 hover:underline">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminShortLinks;
