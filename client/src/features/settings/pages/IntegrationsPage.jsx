import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/hooks/useAuth';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import Icon from '../../../shared/components/Icon';

const IntegrationsPage = () => {
  useTranslation(); // Hook called for future i18n, not currently used
  const { user } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const [integrations, setIntegrations] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  // Derive cloud storage providers from platform config
  const cloudStorage = platformConfig?.cloudStorage || { enabled: false, providers: [] };
  const cloudProviders = useMemo(
    () => (cloudStorage.enabled ? cloudStorage.providers.filter(p => p.enabled !== false) : []),
    [cloudStorage.enabled, cloudStorage.providers]
  );

  // Handle OAuth callback query parameters
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const jiraConnected = params.get('jira_connected');
    const jiraError = params.get('jira_error');

    // Handle JIRA callbacks
    if (jiraConnected === 'true') {
      setMessage({
        type: 'success',
        text: 'JIRA account connected successfully! You can now use JIRA features in your apps.'
      });
      navigate('/settings/integrations', { replace: true });
    } else if (jiraError) {
      setMessage({
        type: 'error',
        text: `JIRA connection failed: ${decodeURIComponent(jiraError)}`
      });
      navigate('/settings/integrations', { replace: true });
    }

    // Handle cloud storage provider callbacks dynamically
    cloudProviders.forEach(provider => {
      const connected = params.get(`${provider.type}_connected`);
      const error = params.get(`${provider.type}_error`);

      if (connected === 'true') {
        setMessage({
          type: 'success',
          text: `${provider.displayName} account connected successfully! You can now select files from ${provider.displayName}.`
        });
        navigate('/settings/integrations', { replace: true });
      } else if (error) {
        setMessage({
          type: 'error',
          text: `${provider.displayName} connection failed: ${decodeURIComponent(error)}`
        });
        navigate('/settings/integrations', { replace: true });
      }
    });
  }, [location.search, navigate, cloudProviders]);

  // Load integration status
  useEffect(() => {
    const loadIntegrations = async () => {
      if (!user?.id) return;

      setLoading(true);
      try {
        // Check JIRA status
        const jiraResponse = await fetch('/api/integrations/jira/status', {
          credentials: 'include'
        });
        const jiraData = await jiraResponse.json();

        setIntegrations(prev => ({
          ...prev,
          jira: jiraData
        }));

        // Check cloud storage provider status dynamically
        for (const provider of cloudProviders) {
          try {
            const response = await fetch(`/api/integrations/${provider.type}/status`, {
              credentials: 'include'
            });
            const data = await response.json();

            setIntegrations(prev => ({
              ...prev,
              [provider.id]: data
            }));
          } catch (err) {
            console.error(`Error loading ${provider.type} status:`, err);
          }
        }
      } catch (error) {
        console.error('Error loading integrations:', error);
      } finally {
        setLoading(false);
      }
    };

    loadIntegrations();
  }, [user?.id, cloudProviders]);

  const handleConnect = async integration => {
    if (integration === 'jira') {
      // Use fetch to initiate the OAuth flow so credentials are included
      try {
        const response = await fetch('/api/integrations/jira/auth', {
          credentials: 'include',
          redirect: 'manual' // Don't automatically follow redirects
        });

        if (
          response.type === 'opaqueredirect' ||
          response.status === 302 ||
          response.status === 301
        ) {
          // The server is redirecting to JIRA OAuth, follow the redirect manually
          window.location.href = '/api/integrations/jira/auth';
        } else if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
          setMessage({
            type: 'error',
            text: `Connection failed: ${errorData.message || 'Unknown error'}`
          });
        }
      } catch (error) {
        setMessage({
          type: 'error',
          text: `Connection failed: ${error.message}`
        });
      }
    }
  };

  // Handle cloud provider connection
  const handleCloudConnect = provider => {
    window.location.href = `/api/integrations/${provider.type}/auth?providerId=${encodeURIComponent(provider.id)}`;
  };

  const handleDisconnect = async integration => {
    if (integration === 'jira') {
      try {
        const response = await fetch('/api/integrations/jira/disconnect', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.ok) {
          setIntegrations(prev => ({
            ...prev,
            jira: { connected: false, message: 'JIRA account disconnected' }
          }));
          setMessage({
            type: 'success',
            text: 'JIRA account disconnected successfully'
          });
        }
      } catch (error) {
        setMessage({
          type: 'error',
          text: `Failed to disconnect JIRA: ${error.message}`
        });
      }
    }
  };

  // Handle cloud provider disconnection
  const handleCloudDisconnect = async provider => {
    try {
      const response = await fetch(`/api/integrations/${provider.type}/disconnect`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        setIntegrations(prev => ({
          ...prev,
          [provider.id]: {
            connected: false,
            message: `${provider.displayName} account disconnected`
          }
        }));
        setMessage({
          type: 'success',
          text: `${provider.displayName} account disconnected successfully`
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to disconnect ${provider.displayName}: ${error.message}`
      });
    }
  };

  const handleTest = async integration => {
    if (integration === 'jira') {
      try {
        const response = await fetch('/api/integrations/jira/test', {
          credentials: 'include'
        });
        const data = await response.json();

        if (data.success) {
          setMessage({
            type: 'success',
            text: `JIRA connection test successful! Found ${data.testResults?.accessibleTickets || 0} accessible tickets.`
          });
        } else {
          setMessage({
            type: 'error',
            text: `JIRA connection test failed: ${data.message}`
          });
        }
      } catch (error) {
        setMessage({
          type: 'error',
          text: `JIRA connection test failed: ${error.message}`
        });
      }
    }
  };

  const dismissMessage = () => {
    setMessage(null);
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Icon name="lock" className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Authentication Required</h2>
          <p className="text-gray-600">Please log in to manage your integrations.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-6">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white shadow rounded-lg">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
                <p className="text-gray-600 mt-1">
                  Connect your external accounts to enhance your AI applications
                </p>
              </div>
              <Icon name="link" className="w-8 h-8 text-blue-600" />
            </div>
          </div>

          {/* Message Banner */}
          {message && (
            <div
              className={`px-6 py-4 border-b border-gray-200 ${
                message.type === 'success'
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <Icon
                    name={message.type === 'success' ? 'check-circle' : 'warning'}
                    className={`w-5 h-5 mr-2 ${
                      message.type === 'success' ? 'text-green-600' : 'text-red-600'
                    }`}
                  />
                  <span className={message.type === 'success' ? 'text-green-800' : 'text-red-800'}>
                    {message.text}
                  </span>
                </div>
                <button
                  onClick={dismissMessage}
                  className={`p-1 rounded-full hover:bg-opacity-20 ${
                    message.type === 'success'
                      ? 'hover:bg-green-600 text-green-600'
                      : 'hover:bg-red-600 text-red-600'
                  }`}
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Integrations List */}
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Icon name="spinner" className="w-8 h-8 animate-spin text-blue-600" />
                <span className="ml-3 text-gray-600">Loading integrations...</span>
              </div>
            ) : (
              <div className="space-y-6">
                {/* JIRA Integration */}
                <div className="border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start space-x-4">
                    <div className="flex-shrink-0">
                      <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center">
                        <Icon name="ticket" className="w-7 h-7 text-white" />
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-lg font-semibold text-gray-900">JIRA</h3>
                          <p className="text-gray-600 text-sm">
                            Atlassian JIRA integration for ticket management and project insights
                          </p>
                        </div>

                        <div className="flex items-center">
                          <span
                            className={`px-3 py-1 text-xs font-medium rounded-full ${
                              integrations.jira?.connected
                                ? 'bg-green-100 text-green-800'
                                : 'bg-gray-100 text-gray-800'
                            }`}
                          >
                            {integrations.jira?.connected ? 'Connected' : 'Not Connected'}
                          </span>
                        </div>
                      </div>

                      {integrations.jira?.connected && integrations.jira.userInfo && (
                        <div className="mt-3 p-3 bg-gray-50 rounded-md">
                          <div className="flex items-center text-sm text-gray-700">
                            <Icon name="user" className="w-4 h-4 mr-2" />
                            <span className="font-medium">
                              {integrations.jira.userInfo.displayName}
                            </span>
                            <span className="ml-2 text-gray-500">
                              ({integrations.jira.userInfo.emailAddress})
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="mt-4 flex items-center space-x-3">
                        {integrations.jira?.connected ? (
                          <>
                            <button
                              onClick={() => handleTest('jira')}
                              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                            >
                              <Icon name="check-circle" className="w-4 h-4 mr-2" />
                              Test Connection
                            </button>
                            <button
                              onClick={() => handleDisconnect('jira')}
                              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                            >
                              <Icon name="x-circle" className="w-4 h-4 mr-2" />
                              Disconnect
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handleConnect('jira')}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                          >
                            <Icon name="link" className="w-4 h-4 mr-2" />
                            Connect JIRA Account
                          </button>
                        )}
                      </div>

                      {integrations.jira?.connected && (
                        <div className="mt-3">
                          <h4 className="text-sm font-medium text-gray-900 mb-2">
                            Available Features:
                          </h4>
                          <ul className="text-sm text-gray-700 space-y-1">
                            <li className="flex items-center">
                              <Icon
                                name="check"
                                className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                              />
                              Search and retrieve JIRA tickets
                            </li>
                            <li className="flex items-center">
                              <Icon
                                name="check"
                                className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                              />
                              Create new tickets and issues
                            </li>
                            <li className="flex items-center">
                              <Icon
                                name="check"
                                className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                              />
                              Update existing tickets
                            </li>
                            <li className="flex items-center">
                              <Icon
                                name="check"
                                className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                              />
                              Get project and user information
                            </li>
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Cloud Storage Integrations */}
                {cloudProviders.map(provider => (
                  <div key={provider.id} className="border border-gray-200 rounded-lg p-6">
                    <div className="flex items-start space-x-4">
                      <div className="flex-shrink-0">
                        <div className="w-12 h-12 bg-gradient-to-br from-purple-600 to-teal-500 rounded-lg flex items-center justify-center">
                          <Icon name="cloud" className="w-7 h-7 text-white" />
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-lg font-semibold text-gray-900">
                              {provider.displayName}
                            </h3>
                            <p className="text-gray-600 text-sm">
                              {provider.type === 'office365'
                                ? 'Microsoft Office 365 integration for cloud file access'
                                : 'Google Drive integration for cloud file access'}
                            </p>
                          </div>

                          <div className="flex items-center">
                            <span
                              className={`px-3 py-1 text-xs font-medium rounded-full ${
                                integrations[provider.id]?.connected
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {integrations[provider.id]?.connected ? 'Connected' : 'Not Connected'}
                            </span>
                          </div>
                        </div>

                        {integrations[provider.id]?.connected &&
                          integrations[provider.id].userInfo && (
                            <div className="mt-3 p-3 bg-gray-50 rounded-md">
                              <div className="flex items-center text-sm text-gray-700">
                                <Icon name="user" className="w-4 h-4 mr-2" />
                                <span className="font-medium">
                                  {integrations[provider.id].userInfo.displayName}
                                </span>
                                <span className="ml-2 text-gray-500">
                                  (
                                  {integrations[provider.id].userInfo.mail ||
                                    integrations[provider.id].userInfo.emailAddress}
                                  )
                                </span>
                              </div>
                              {integrations[provider.id].tokenInfo?.isExpiring && (
                                <div className="mt-2 flex items-center text-sm text-amber-600">
                                  <Icon name="exclamationTriangle" className="w-4 h-4 mr-2" />
                                  <span>Token expires soon - consider reconnecting</span>
                                </div>
                              )}
                            </div>
                          )}

                        <div className="mt-4 flex items-center space-x-3">
                          {integrations[provider.id]?.connected ? (
                            <button
                              onClick={() => handleCloudDisconnect(provider)}
                              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                            >
                              <Icon name="x-circle" className="w-4 h-4 mr-2" />
                              Disconnect
                            </button>
                          ) : (
                            <button
                              onClick={() => handleCloudConnect(provider)}
                              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                            >
                              <Icon name="link" className="w-4 h-4 mr-2" />
                              Connect {provider.displayName} Account
                            </button>
                          )}
                        </div>

                        {integrations[provider.id]?.connected && (
                          <div className="mt-3">
                            <h4 className="text-sm font-medium text-gray-900 mb-2">
                              Available Features:
                            </h4>
                            <ul className="text-sm text-gray-700 space-y-1">
                              <li className="flex items-center">
                                <Icon
                                  name="check"
                                  className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                                />
                                {provider.type === 'office365'
                                  ? 'Browse OneDrive and SharePoint files'
                                  : 'Browse Google Drive files'}
                              </li>
                              <li className="flex items-center">
                                <Icon
                                  name="check"
                                  className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                                />
                                Upload cloud files to chats
                              </li>
                              <li className="flex items-center">
                                <Icon
                                  name="check"
                                  className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                                />
                                Secure OAuth 2.0 with PKCE
                              </li>
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* Placeholder for future integrations */}
                <div className="border border-dashed border-gray-300 rounded-lg p-6 text-center">
                  <Icon name="plus" className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                  <h3 className="text-lg font-medium text-gray-500 mb-1">
                    More Integrations Coming Soon
                  </h3>
                  <p className="text-gray-400 text-sm">
                    We're working on adding more integrations to enhance your AI applications
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default IntegrationsPage;
