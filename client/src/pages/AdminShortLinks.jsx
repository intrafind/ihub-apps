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
          <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
            <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
              <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                <table className="min-w-full divide-y divide-gray-300">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Code</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">App</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">User</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Usage</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Created</th>
                      <th className="px-6 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {links.map(link => (
                      <tr key={link.code} className="hover:bg-gray-50">
                        <td className="px-6 py-2 whitespace-nowrap">
                          <a href={`/s/${link.code}`} className="text-indigo-600 underline" target="_blank" rel="noreferrer">
                            {link.code}
                          </a>
                        </td>
                        <td className="px-6 py-2 whitespace-nowrap">{link.appId || '-'}</td>
                        <td className="px-6 py-2 whitespace-nowrap">{link.userId || '-'}</td>
                        <td className="px-6 py-2 whitespace-nowrap">{link.usage || 0}</td>
                        <td className="px-6 py-2 whitespace-nowrap">{new Date(link.createdAt).toLocaleString()}</td>
                        <td className="px-6 py-2 whitespace-nowrap text-right">
                          <button onClick={() => handleDelete(link.code)} className="text-red-600 hover:underline">
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminShortLinks;
