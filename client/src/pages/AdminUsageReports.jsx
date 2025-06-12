import React, { useEffect, useState } from 'react';
import { fetchUsageData } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';


const renderTable = (obj) => {
  const rows = flatten(obj);
  return (
    <table className="min-w-full text-xs border mb-2">
      <thead>
        <tr className="bg-gray-100">
          <th className="text-left p-1">Key</th>
          <th className="text-right p-1">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, value }) => (
          <tr key={key} className="odd:bg-white even:bg-gray-50">
            <td className="p-1">{key}</td>
            <td className="p-1 text-right">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const renderSection = (title, data) => (
  <div className="mb-6">
    <h2 className="text-lg font-semibold mb-2">{title}</h2>
    {renderTable({ total: data.total })}
    <div className="grid md:grid-cols-3 gap-4">
      <div>
        <h3 className="font-medium mb-1">Per User</h3>
        {renderTable(data.perUser || {})}
      </div>
      <div>
        <h3 className="font-medium mb-1">Per App</h3>
        {renderTable(data.perApp || {})}
      </div>
      <div>
        <h3 className="font-medium mb-1">Per Model</h3>
        {renderTable(data.perModel || {})}
      </div>
    </div>
  </div>
);

const categories = [
  { key: 'messages', label: 'Messages' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'magicPrompt', label: 'Magic Prompt' }
];

const flatten = (obj, prefix = '') => {
  let rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      rows = rows.concat(flatten(v, key));
    } else {
      rows.push({ key, value: v });
    }
  }
  return rows;
};

const AdminUsageReports = () => {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('messages');

  const load = async () => {
    try {
      setLoading(true);
      const data = await fetchUsageData();
      setUsage(data);
    } catch (e) {
      console.error('Failed to load usage data', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const downloadJson = () => {
    if (!usage) return;
    const data = usage[category];
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${category}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = () => {
    if (!usage) return;
    const data = usage[category];
    const rows = flatten(data);
    const csv = ['Key,Value']
      .concat(rows.map(r => `${r.key},${r.value}`))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${category}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };



  if (loading) return <LoadingSpinner />;
  if (!usage) return <div>No data</div>;

  const { messages, tokens, feedback, magicPrompt } = usage;
  const { lastUpdated, lastReset } = usage;

  let content = null;
  if (category === 'messages') {
    content = renderSection('Messages', messages);
  } else if (category === 'tokens') {
    content = (
      <>
        {renderSection('Tokens', tokens)}
        {renderSection('Prompt Tokens', tokens.prompt)}
        {renderSection('Completion Tokens', tokens.completion)}
      </>
    );
  } else if (category === 'feedback') {
    content = renderSection('Feedback', feedback);
  } else if (category === 'magicPrompt') {
    content = (
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-2">Magic Prompt</h2>
        {renderSection('Invocations', {
          total: magicPrompt.total,
          perUser: magicPrompt.perUser,
          perApp: magicPrompt.perApp,
          perModel: magicPrompt.perModel
        })}
        {renderSection('Input Tokens', magicPrompt.tokensIn)}
        {renderSection('Output Tokens', magicPrompt.tokensOut)}
      </div>
    );
  }

  return (
    <div className="my-4 p-4">
      <h1 className="text-2xl font-bold mb-4">Usage Reports</h1>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end mb-4">
        <div className="text-sm text-gray-600 mb-2 sm:mb-0">
          <div>Last Updated: {new Date(lastUpdated).toLocaleString()}</div>
          <div>Last Reset: {new Date(lastReset).toLocaleString()}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={downloadJson}
            className="px-3 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Download JSON
          </button>
          <button
            onClick={downloadCsv}
            className="px-3 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Download CSV
          </button>
        </div>
      </div>

      <nav className="mb-6 border-b flex gap-2">
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`px-3 py-2 rounded-t-md text-sm font-medium border-b-2 ${
              category === c.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-600 hover:text-indigo-600'
            }`}
          >
            {c.label}
          </button>
        ))}
      </nav>

      {content}
    </div>
  );
};

export default AdminUsageReports;
