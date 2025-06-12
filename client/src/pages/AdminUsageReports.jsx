import React, { useEffect, useState } from 'react';
import { fetchUsageData } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';

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

  return (
    <div className="my-4">
      <h1 className="text-2xl font-bold mb-4">Usage Reports</h1>
      <pre className="bg-gray-100 p-2 rounded overflow-x-auto text-xs">
        {JSON.stringify(usage, null, 2)}
      </pre>
    </div>
  );
};

export default AdminUsageReports;
