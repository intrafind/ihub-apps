import { useState, useEffect, useRef, useCallback } from 'react';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminAuthDebugPage = () => {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [selectedLevel, setSelectedLevel] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [exportFormat, setExportFormat] = useState('json');
  const [realTimeEnabled, setRealTimeEnabled] = useState(false);
  const eventSourceRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  useEffect(() => {
    loadDebugData();
  }, [loadDebugData]);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(loadDebugData, 5000); // Refresh every 5 seconds
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, loadDebugData]);

  useEffect(() => {
    if (realTimeEnabled) {
      connectToRealTimeStream();
    } else {
      disconnectFromRealTimeStream();
    }

    return () => {
      disconnectFromRealTimeStream();
    };
  }, [realTimeEnabled, connectToRealTimeStream]);

  const connectToRealTimeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const params = new URLSearchParams();
    if (selectedProvider !== 'all') {
      params.set('provider', selectedProvider);
    }

    const url = `/api/admin/auth/debug/stream?${params.toString()}`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnectionStatus('connected');
    };

    eventSource.onmessage = event => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'log') {
          setLogs(prevLogs => [data.data, ...prevLogs.slice(0, 99)]); // Keep only latest 100
        } else if (data.type === 'cleared') {
          setLogs([]);
        }
      } catch (error) {
        console.error('Error parsing real-time data:', error);
      }
    };

    eventSource.onerror = () => {
      setConnectionStatus('error');
      setTimeout(() => {
        if (realTimeEnabled) {
          connectToRealTimeStream();
        }
      }, 3000);
    };

    eventSourceRef.current = eventSource;
  }, [selectedProvider, realTimeEnabled]);

  const disconnectFromRealTimeStream = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnectionStatus('disconnected');
  };

  const loadDebugData = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: '50'
      });

      if (selectedProvider !== 'all') {
        params.set('provider', selectedProvider);
      }

      if (selectedLevel !== 'all') {
        params.set('level', selectedLevel);
      }

      const [logsResponse, statsResponse] = await Promise.all([
        makeAdminApiCall(`/admin/auth/debug/logs?${params.toString()}`),
        makeAdminApiCall('/admin/auth/debug/stats')
      ]);

      setLogs(logsResponse.data.logs || []);
      setStats(statsResponse.data || {});
    } catch (error) {
      console.error('Error loading debug data:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedProvider, selectedLevel]);

  const clearLogs = async () => {
    try {
      const params = selectedProvider !== 'all' ? `?provider=${selectedProvider}` : '';
      await makeAdminApiCall(`/admin/auth/debug/logs${params}`, { method: 'DELETE' });
      setLogs([]);
      loadDebugData();
    } catch (error) {
      console.error('Error clearing logs:', error);
    }
  };

  const exportLogs = async () => {
    try {
      const params = new URLSearchParams({
        format: exportFormat,
        limit: '1000'
      });

      if (selectedProvider !== 'all') {
        params.set('provider', selectedProvider);
      }

      if (selectedLevel !== 'all') {
        params.set('level', selectedLevel);
      }

      const response = await fetch(`/api/admin/auth/debug/export?${params.toString()}`, {
        credentials: 'include'
      });

      if (response.ok) {
        // Get filename from Content-Disposition header
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'auth-debug-logs.json';
        if (contentDisposition) {
          const filenameMatch = contentDisposition.match(/filename="(.+)"/);
          if (filenameMatch) {
            filename = filenameMatch[1];
          }
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (error) {
      console.error('Error exporting logs:', error);
    }
  };

  const testProvider = async provider => {
    try {
      await makeAdminApiCall(`/admin/auth/debug/test/${provider}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testType: 'manual' })
      });

      // Refresh logs after test
      setTimeout(loadDebugData, 1000);
    } catch (error) {
      console.error('Error testing provider:', error);
    }
  };

  const formatLogData = data => {
    return JSON.stringify(data, null, 2);
  };

  const getLogLevelColor = level => {
    switch (level) {
      case 'error':
        return 'text-red-600 bg-red-50 border-red-200';
      case 'warn':
        return 'text-yellow-600 bg-yellow-50 border-yellow-200';
      case 'info':
        return 'text-blue-600 bg-blue-50 border-blue-200';
      case 'debug':
        return 'text-gray-600 bg-gray-50 border-gray-200';
      default:
        return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  const getProviderIcon = provider => {
    switch (provider) {
      case 'oidc':
        return 'shield';
      case 'local':
        return 'user';
      case 'proxy':
        return 'server';
      case 'ldap':
        return 'building';
      default:
        return 'lock';
    }
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  const providers = ['all', ...Object.keys(stats.providerStats || {})];
  const levels = ['all', 'error', 'warn', 'info', 'debug'];

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Authentication Debug Logs</h1>
                <p className="text-gray-600 mt-1">
                  Monitor authentication events and troubleshoot issues
                </p>
              </div>
              <div className="flex items-center space-x-3">
                {/* Real-time toggle */}
                <div className="flex items-center space-x-2">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={realTimeEnabled}
                      onChange={e => setRealTimeEnabled(e.target.checked)}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium">Real-time</span>
                  </label>
                  <div
                    className={`w-2 h-2 rounded-full ${
                      connectionStatus === 'connected'
                        ? 'bg-green-500'
                        : connectionStatus === 'error'
                          ? 'bg-red-500'
                          : 'bg-gray-400'
                    }`}
                  />
                </div>

                {/* Auto-refresh toggle */}
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={e => setAutoRefresh(e.target.checked)}
                    className="mr-2"
                  />
                  <span className="text-sm font-medium">Auto-refresh</span>
                </label>

                {/* Export */}
                <div className="flex items-center space-x-2">
                  <select
                    value={exportFormat}
                    onChange={e => setExportFormat(e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded text-sm"
                  >
                    <option value="json">JSON</option>
                    <option value="csv">CSV</option>
                    <option value="text">Text</option>
                  </select>
                  <button
                    onClick={exportLogs}
                    className="px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm"
                  >
                    <Icon name="download" size="sm" className="mr-1" />
                    Export
                  </button>
                </div>

                <button
                  onClick={clearLogs}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm"
                >
                  <Icon name="trash" size="sm" className="mr-1" />
                  Clear
                </button>

                <button
                  onClick={loadDebugData}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
                >
                  <Icon name="refresh" size="sm" className="mr-1" />
                  Refresh
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex items-center space-x-4 mt-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                <select
                  value={selectedProvider}
                  onChange={e => setSelectedProvider(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                >
                  {providers.map(provider => (
                    <option key={provider} value={provider}>
                      {provider === 'all' ? 'All Providers' : provider.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
                <select
                  value={selectedLevel}
                  onChange={e => setSelectedLevel(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                >
                  {levels.map(level => (
                    <option key={level} value={level}>
                      {level === 'all' ? 'All Levels' : level.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              {/* Test buttons */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Test</label>
                <div className="flex space-x-2">
                  {Object.keys(stats.providerStats || {}).map(provider => (
                    <button
                      key={provider}
                      onClick={() => testProvider(provider)}
                      className="px-2 py-1 text-xs bg-purple-100 text-purple-700 rounded border border-purple-200 hover:bg-purple-200"
                    >
                      Test {provider.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Summary */}
        {stats.totalLogs > 0 && (
          <div className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-6">
                <div className="text-sm">
                  <span className="font-medium text-gray-900">{stats.totalLogs}</span>
                  <span className="text-gray-500 ml-1">total logs</span>
                </div>
                <div className="text-sm">
                  <span className="font-medium text-gray-900">{stats.activeSessions}</span>
                  <span className="text-gray-500 ml-1">active sessions</span>
                </div>
                {Object.entries(stats.levelStats || {}).map(([level, count]) => (
                  <div key={level} className="text-sm">
                    <span
                      className={`font-medium ${
                        level === 'error'
                          ? 'text-red-600'
                          : level === 'warn'
                            ? 'text-yellow-600'
                            : level === 'info'
                              ? 'text-blue-600'
                              : 'text-gray-600'
                      }`}
                    >
                      {count}
                    </span>
                    <span className="text-gray-500 ml-1">{level}</span>
                  </div>
                ))}
              </div>
              {stats.debugEnabled && (
                <div className="flex items-center text-sm text-green-600">
                  <Icon name="check-circle" size="sm" className="mr-1" />
                  Debug Enabled
                </div>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {!stats.debugEnabled ? (
            <div className="text-center py-8">
              <Icon name="info" size="xl" className="mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Debug Logging Disabled</h3>
              <p className="text-gray-500 mb-4">
                Enable debug mode in Authentication Configuration to start logging authentication
                events.
              </p>
              <a
                href="/admin/auth"
                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                <Icon name="settings" size="sm" className="mr-2" />
                Go to Authentication Settings
              </a>
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Icon name="file-text" size="xl" className="mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No Debug Logs</h3>
              <p className="text-gray-500">
                No authentication events have been logged yet. Try authenticating or use the test
                buttons above.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {logs.map((log, index) => (
                <div key={log.id || index} className="bg-white rounded-lg shadow border p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center space-x-3">
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium border ${getLogLevelColor(log.level)}`}
                      >
                        {log.level.toUpperCase()}
                      </span>
                      <div className="flex items-center space-x-2">
                        <Icon
                          name={getProviderIcon(log.provider)}
                          size="sm"
                          className="text-gray-600"
                        />
                        <span className="font-medium text-gray-900">
                          {log.provider.toUpperCase()}
                        </span>
                      </div>
                      <span className="text-gray-600">{log.event}</span>
                      {log.sessionId && (
                        <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                          Session: {log.sessionId.slice(-8)}
                        </span>
                      )}
                      {log.userId && (
                        <span className="text-xs text-gray-500 bg-blue-100 px-2 py-1 rounded">
                          User: {log.userId}
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-gray-500">
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                  </div>

                  <pre className="bg-gray-50 p-3 rounded text-sm overflow-x-auto max-h-96 overflow-y-auto">
                    {formatLogData(log.data)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminAuthDebugPage;
