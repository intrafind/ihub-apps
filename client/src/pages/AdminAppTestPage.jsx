import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const AdminAppTestPage = () => {
  const { t } = useTranslation();
  const { appId } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [testMessage, setTestMessage] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadApp();
  }, [appId]);

  const loadApp = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/apps/${appId}`);
      if (!response.ok) {
        throw new Error('Failed to load app');
      }
      const data = await response.json();
      setApp(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async (e) => {
    e.preventDefault();
    
    if (!testMessage.trim()) {
      setError('Please enter a test message');
      return;
    }

    try {
      setTesting(true);
      setError(null);
      setTestResult(null);

      // Simulate API call to test the app
      const response = await fetch(`/api/apps/${appId}/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: testMessage,
          // Add any other test parameters
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to test app');
      }

      const result = await response.json();
      setTestResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  const getLocalizedContent = (content, lang = 'en') => {
    if (typeof content === 'string') return content;
    return content?.[lang] || content?.en || '';
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">{t('admin.apps.loading', 'Loading...')}</p>
        </div>
      </div>
    );
  }

  if (error && !app) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.apps.errorTitle', 'Error')}
              </h3>
              <div className="mt-2 text-sm text-red-700">
                {error}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('admin.apps.test.title', 'Test App')} - {getLocalizedContent(app?.name)}
          </h1>
          <p className="mt-2 text-sm text-gray-700">
            {t('admin.apps.test.subtitle', 'Test your app configuration and behavior')}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
            onClick={() => navigate('/admin/apps')}
          >
            {t('admin.apps.test.back', 'Back to Apps')}
          </button>
        </div>
      </div>

      {/* App Information */}
      <div className="mt-8 bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.test.appInfo', 'App Information')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.test.appInfoDesc', 'Current app configuration')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="grid grid-cols-1 gap-6">
              <div className="flex items-center">
                <div 
                  className="flex-shrink-0 h-10 w-10 rounded-full flex items-center justify-center text-white font-bold"
                  style={{ backgroundColor: app?.color || '#6B7280' }}
                >
                  {getLocalizedContent(app?.name).charAt(0).toUpperCase()}
                </div>
                <div className="ml-4">
                  <div className="text-sm font-medium text-gray-900">
                    {getLocalizedContent(app?.name)}
                  </div>
                  <div className="text-sm text-gray-500">
                    {app?.id}
                  </div>
                </div>
                <div className="ml-auto">
                  <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    app?.enabled 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-red-100 text-red-800'
                  }`}>
                    {app?.enabled 
                      ? t('admin.apps.status.enabled', 'Enabled')
                      : t('admin.apps.status.disabled', 'Disabled')
                    }
                  </span>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.test.model', 'Model')}
                  </label>
                  <p className="mt-1 text-sm text-gray-900">{app?.preferredModel || 'N/A'}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.test.temperature', 'Temperature')}
                  </label>
                  <p className="mt-1 text-sm text-gray-900">{app?.preferredTemperature || 'N/A'}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.test.tokenLimit', 'Token Limit')}
                  </label>
                  <p className="mt-1 text-sm text-gray-900">{app?.tokenLimit || 'N/A'}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.test.outputFormat', 'Output Format')}
                  </label>
                  <p className="mt-1 text-sm text-gray-900">{app?.preferredOutputFormat || 'N/A'}</p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.test.description', 'Description')}
                </label>
                <p className="mt-1 text-sm text-gray-900">{getLocalizedContent(app?.description)}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.test.systemInstructions', 'System Instructions')}
                </label>
                <div className="mt-1 bg-gray-50 border border-gray-200 rounded-md p-3">
                  <pre className="text-sm text-gray-900 whitespace-pre-wrap">
                    {getLocalizedContent(app?.system)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Test Interface */}
      <div className="mt-8 bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.test.testInterface', 'Test Interface')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.test.testInterfaceDesc', 'Send a test message to your app')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <form onSubmit={handleTest} className="space-y-6">
              <div>
                <label htmlFor="test-message" className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.test.testMessage', 'Test Message')}
                </label>
                <textarea
                  id="test-message"
                  rows={4}
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  placeholder={t('admin.apps.test.testMessagePlaceholder', 'Enter your test message here...')}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div>
                <button
                  type="submit"
                  disabled={testing || !app?.enabled}
                  className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {testing 
                    ? t('admin.apps.test.testing', 'Testing...')
                    : t('admin.apps.test.testButton', 'Test App')
                  }
                </button>
                {!app?.enabled && (
                  <p className="mt-2 text-sm text-red-600">
                    {t('admin.apps.test.disabledWarning', 'App is disabled and cannot be tested')}
                  </p>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mt-8 bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.apps.test.errorTitle', 'Test Error')}
              </h3>
              <div className="mt-2 text-sm text-red-700">
                {error}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Test Results */}
      {testResult && (
        <div className="mt-8 bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900">
                {t('admin.apps.test.results', 'Test Results')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.apps.test.resultsDesc', 'Response from your app')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="bg-gray-50 border border-gray-200 rounded-md p-4">
                <div className="flex items-center mb-3">
                  <svg className="h-5 w-5 text-green-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm font-medium text-green-800">
                    {t('admin.apps.test.successResponse', 'Test completed successfully')}
                  </span>
                </div>
                <div className="text-sm text-gray-900">
                  <pre className="whitespace-pre-wrap">{JSON.stringify(testResult, null, 2)}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="mt-8 bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.test.quickActions', 'Quick Actions')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.test.quickActionsDesc', 'Common actions for this app')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="flex space-x-3">
              <button
                type="button"
                onClick={() => navigate(`/admin/apps/${appId}`)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                {t('admin.apps.test.editApp', 'Edit App')}
              </button>
              <button
                type="button"
                onClick={() => navigate(`/apps/${appId}`)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                {t('admin.apps.test.openApp', 'Open App')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminAppTestPage;