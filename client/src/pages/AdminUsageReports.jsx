import React, { useEffect, useState } from 'react';
import { fetchUsageData } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';

const renderTable = (obj) => (
  <table className="min-w-full text-xs border mb-2">
    <thead>
      <tr className="bg-gray-100">
        <th className="text-left p-1">Key</th>
        <th className="text-right p-1">Value</th>
      </tr>
    </thead>
    <tbody>
      {Object.entries(obj).map(([k, v]) => (
        <tr key={k} className="odd:bg-white even:bg-gray-50">
          <td className="p-1">{k}</td>
          <td className="p-1 text-right">{v}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

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

const AdminUsageReports = () => {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

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



  if (loading) return <LoadingSpinner />;
  if (!usage) return <div>No data</div>;

  const { messages, tokens, feedback, magicPrompt } = usage;
  const { lastUpdated, lastReset } = usage;

  return (
    <div className="my-4 p-4">
      <h1 className="text-2xl font-bold mb-4">Usage Reports</h1>
      <div className="text-sm mb-4 text-gray-600">
        <div>Last Updated: {new Date(lastUpdated).toLocaleString()}</div>
        <div>Last Reset: {new Date(lastReset).toLocaleString()}</div>
      </div>

      {renderSection('Messages', messages)}
      {renderSection('Tokens', tokens)}
      {renderSection('Prompt Tokens', tokens.prompt)}
      {renderSection('Completion Tokens', tokens.completion)}
      {renderSection('Feedback', feedback)}

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
    </div>
  );
};

export default AdminUsageReports;
