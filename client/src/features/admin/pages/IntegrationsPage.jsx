import { useState, useEffect } from 'react';
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  ClipboardIcon,
  CheckIcon
} from '@heroicons/react/24/outline';
import { apiClient } from '../../../api/client';

export function IntegrationsPage() {
  const [outlookInfo, setOutlookInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadIntegrationInfo();
  }, []);

  const loadIntegrationInfo = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/api/integrations/outlook/info');
      setOutlookInfo(response.data);
    } catch (err) {
      console.error('Error loading integration info:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const downloadManifest = async () => {
    try {
      const response = await fetch('/api/integrations/outlook/manifest.xml', {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to download manifest');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ihub-outlook-manifest.xml';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Error downloading manifest:', err);
      alert('Failed to download manifest: ' + err.message);
    }
  };

  const copyToClipboard = text => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/4 mb-4"></div>
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-200">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Integrations</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Configure and manage external integrations for iHub Apps
        </p>
      </div>

      {/* Outlook Integration */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 mb-6">
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
                Outlook Add-in for Mac
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Enable AI-powered features directly in Outlook for Mac
              </p>
            </div>
            <span className="px-3 py-1 text-sm font-medium text-green-800 bg-green-100 dark:bg-green-900/30 dark:text-green-200 rounded-full">
              Active
            </span>
          </div>
        </div>

        <div className="p-6">
          {/* Features */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
              Features
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {outlookInfo?.features?.map((feature, index) => (
                <div
                  key={index}
                  className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700"
                >
                  <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                    {feature.name}
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                    {feature.description}
                  </p>
                  <span className="text-xs text-blue-600 dark:text-blue-400 font-mono">
                    App: {feature.app}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Download Section */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
              Download & Install
            </h3>
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <div className="flex items-start gap-4">
                <div className="flex-1">
                  <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
                    Download the manifest file and install it in Outlook for Mac to enable AI
                    features.
                  </p>
                  <button
                    onClick={downloadManifest}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                  >
                    <ArrowDownTrayIcon className="w-4 h-4" />
                    Download Manifest
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Configuration */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
              Configuration
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex-1">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Server URL
                  </label>
                  <p className="text-sm text-gray-600 dark:text-gray-400 font-mono mt-1">
                    {outlookInfo?.serverUrl}
                  </p>
                </div>
                <button
                  onClick={() => copyToClipboard(outlookInfo?.serverUrl)}
                  className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <CheckIcon className="w-5 h-5 text-green-600" />
                  ) : (
                    <ClipboardIcon className="w-5 h-5" />
                  )}
                </button>
              </div>

              <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex-1">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Manifest URL
                  </label>
                  <p className="text-sm text-gray-600 dark:text-gray-400 font-mono mt-1">
                    {outlookInfo?.manifestUrl}
                  </p>
                </div>
                <button
                  onClick={() => copyToClipboard(outlookInfo?.manifestUrl)}
                  className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  title="Copy to clipboard"
                >
                  <ClipboardIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>

          {/* Installation Instructions */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
              Installation Instructions
            </h3>
            <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700 dark:text-gray-300">
                {outlookInfo?.instructions?.split('\n').map((line, index) => (
                  <li key={index}>{line.replace(/^\d+\.\s*/, '')}</li>
                ))}
              </ol>
            </div>
          </div>

          {/* Authentication Info */}
          {outlookInfo?.authentication && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Authentication
              </h3>
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <div className="flex gap-3">
                  <div className="flex-shrink-0">
                    <svg
                      className="w-5 h-5 text-yellow-600 dark:text-yellow-400"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold text-yellow-900 dark:text-yellow-200 mb-1">
                      {outlookInfo.authentication.type.toUpperCase()} Authentication
                    </h4>
                    <p className="text-sm text-yellow-800 dark:text-yellow-300 mb-2">
                      {outlookInfo.authentication.description}
                    </p>
                    <p className="text-sm text-yellow-800 dark:text-yellow-300">
                      <strong>Note:</strong> {outlookInfo.authentication.note}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Documentation Link */}
          <div>
            <a
              href="/page/help"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
              View Documentation
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export default IntegrationsPage;
