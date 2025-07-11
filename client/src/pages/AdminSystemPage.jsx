import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../api/adminApi';

const AdminSystemPage = () => {
  const { t } = useTranslation();
  const [forceRefreshLoading, setForceRefreshLoading] = useState(false);
  const [forceRefreshMessage, setForceRefreshMessage] = useState('');

  const handleForceRefresh = async () => {
    setForceRefreshLoading(true);
    setForceRefreshMessage('');

    try {
      const response = await makeAdminApiCall('/api/admin/client/_refresh', {
        method: 'POST'
      });

      const data = await response.json();

      setForceRefreshMessage({
        type: 'success',
        text: `Force refresh triggered successfully! New salt: ${data.newAdminSalt}. All clients will refresh on their next page load.`
      });
    } catch (error) {
      setForceRefreshMessage({
        type: 'error',
        text: error.message || 'Failed to trigger force refresh'
      });
    } finally {
      setForceRefreshLoading(false);
    }
  };

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">System Administration</h1>
              <p className="text-gray-600 mt-1">Manage system-wide settings and maintenance</p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">
          
          {/* Force Refresh Section */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0 mt-1">
                <div className="p-3 rounded-full bg-orange-100">
                  <Icon name="refresh" size="lg" className="text-orange-600" />
                </div>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Force Client Refresh</h3>
                <p className="text-gray-600 mb-4">
                  Trigger a force refresh for all clients. This will clear all browser caches, localStorage, 
                  and force clients to reload all assets (JS, CSS, fonts, configurations) without using 
                  browser cache. The disclaimer acceptance will be preserved.
                </p>
                
                <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-4">
                  <div className="flex">
                    <Icon name="warning" size="md" className="text-amber-500 mt-0.5 mr-3" />
                    <div>
                      <h4 className="text-sm font-medium text-amber-800">Warning</h4>
                      <p className="text-sm text-amber-700 mt-1">
                        This action will force all connected clients to reload their browsers on their 
                        next page interaction. Use this when deploying critical updates or when clients 
                        need to clear cached data.
                      </p>
                    </div>
                  </div>
                </div>

                {forceRefreshMessage && (
                  <div className={`p-4 rounded-md mb-4 ${
                    forceRefreshMessage.type === 'success' 
                      ? 'bg-green-50 border border-green-200' 
                      : 'bg-red-50 border border-red-200'
                  }`}>
                    <div className="flex">
                      <Icon 
                        name={forceRefreshMessage.type === 'success' ? 'check' : 'warning'} 
                        size="md" 
                        className={`mt-0.5 mr-3 ${
                          forceRefreshMessage.type === 'success' ? 'text-green-500' : 'text-red-500'
                        }`} 
                      />
                      <p className={`text-sm ${
                        forceRefreshMessage.type === 'success' ? 'text-green-700' : 'text-red-700'
                      }`}>
                        {forceRefreshMessage.text}
                      </p>
                    </div>
                  </div>
                )}

                <button
                  onClick={handleForceRefresh}
                  disabled={forceRefreshLoading}
                  className={`
                    inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium 
                    rounded-md shadow-sm text-white 
                    ${forceRefreshLoading 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500'
                    }
                  `}
                >
                  {forceRefreshLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Triggering Force Refresh...
                    </>
                  ) : (
                    <>
                      <Icon name="refresh" size="md" className="mr-2" />
                      Trigger Force Refresh
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Cache Management Section */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0 mt-1">
                <div className="p-3 rounded-full bg-blue-100">
                  <Icon name="server" size="lg" className="text-blue-600" />
                </div>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Server Cache Management</h3>
                <p className="text-gray-600 mb-4">
                  Manage server-side configuration cache. Use these tools to refresh or clear 
                  cached configuration files on the server.
                </p>
                
                <div className="flex space-x-4">
                  <a
                    href="/api/admin/cache/_refresh"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <Icon name="refresh" size="md" className="mr-2" />
                    Refresh Cache
                  </a>
                  
                  <a
                    href="/api/admin/cache/_clear"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  >
                    <Icon name="trash" size="md" className="mr-2" />
                    Clear Cache
                  </a>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSystemPage;