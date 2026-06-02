import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';

function AdminUpdatesPage() {
  const { t } = useTranslation();
  const [versionInfo, setVersionInfo] = useState(null);
  const [versionLoading, setVersionLoading] = useState(true);
  const [versionError, setVersionError] = useState('');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateCheckLoading, setUpdateCheckLoading] = useState(true);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateActionLoading, setUpdateActionLoading] = useState(false);
  const [updateActionMessage, setUpdateActionMessage] = useState('');
  const [updateActionMessageType, setUpdateActionMessageType] = useState('success');
  const updatePollIntervalRef = useRef(null);
  const rollbackPollIntervalRef = useRef(null);
  const updatePollAbortRef = useRef(null);
  const rollbackPollAbortRef = useRef(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    const fetchVersionInfo = async () => {
      try {
        const response = await makeAdminApiCall('/admin/version', { method: 'GET' });
        setVersionInfo(response.data);
        setVersionError('');
      } catch (error) {
        setVersionError(error.message || 'Failed to load version information');
      } finally {
        setVersionLoading(false);
      }
    };
    fetchVersionInfo();
  }, []);

  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const response = await makeAdminApiCall('/admin/version/check-update', { method: 'GET' });
        setUpdateInfo(response.data);
      } catch (error) {
        setUpdateInfo({ updateAvailable: false, error: error.message });
      } finally {
        setUpdateCheckLoading(false);
      }
    };
    checkForUpdates();
  }, []);

  useEffect(() => {
    const fetchUpdateStatus = async () => {
      try {
        const response = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
        setUpdateStatus(response.data);
      } catch {
        // Update status not available (not a binary installation)
      }
    };
    fetchUpdateStatus();
  }, []);

  useEffect(() => {
    return () => {
      if (updatePollIntervalRef.current) clearInterval(updatePollIntervalRef.current);
      if (rollbackPollIntervalRef.current) clearInterval(rollbackPollIntervalRef.current);
      if (updatePollAbortRef.current) {
        updatePollAbortRef.current.abort();
        updatePollAbortRef.current = null;
      }
      if (rollbackPollAbortRef.current) {
        rollbackPollAbortRef.current.abort();
        rollbackPollAbortRef.current = null;
      }
    };
  }, []);

  const handleUpdateNow = async () => {
    setUpdateActionLoading(true);
    setUpdateActionMessage('');
    setUpdateActionMessageType('success');

    try {
      setUpdateActionMessage(t('admin.system.updateDownloading', 'Downloading update...'));
      await makeAdminApiCall('/admin/update/download', { method: 'POST' });

      setUpdateActionMessage(t('admin.system.updateApplying', 'Applying update...'));
      await makeAdminApiCall('/admin/update/apply', { method: 'POST' });

      setUpdateActionMessage(
        t('admin.system.updateRestarting', 'Update applied. Server is restarting...')
      );

      updatePollIntervalRef.current = setInterval(async () => {
        if (updatePollAbortRef.current) updatePollAbortRef.current.abort();
        const controller = new AbortController();
        updatePollAbortRef.current = controller;
        try {
          const response = await makeAdminApiCall('/admin/version', {
            method: 'GET',
            signal: controller.signal
          });
          if (response.data) {
            clearInterval(updatePollIntervalRef.current);
            updatePollIntervalRef.current = null;
            updatePollAbortRef.current = null;
            setUpdateActionMessage(
              t('admin.system.updateSuccess', 'Update complete! Now running version {{version}}.', {
                version: response.data.app
              })
            );
            setUpdateActionMessageType('success');
            setUpdateActionLoading(false);
            setVersionInfo(response.data);
            setUpdateInfo(prev => (prev ? { ...prev, updateAvailable: false } : prev));
            try {
              const statusRes = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
              setUpdateStatus(statusRes.data);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* Server not ready yet */
        } finally {
          if (updatePollAbortRef.current === controller) updatePollAbortRef.current = null;
        }
      }, 3000);

      setTimeout(() => {
        if (updatePollIntervalRef.current) {
          clearInterval(updatePollIntervalRef.current);
          updatePollIntervalRef.current = null;
          setUpdateActionMessage(
            t(
              'admin.system.updateTimeout',
              'Update is taking longer than expected. Please check the server status and try again.'
            )
          );
          setUpdateActionMessageType('error');
          setUpdateActionLoading(false);
        }
      }, 120000);
    } catch (error) {
      setUpdateActionMessage(
        t('admin.system.updateFailed', 'Update failed: {{error}}', {
          error: error.response?.data?.error || error.message
        })
      );
      setUpdateActionMessageType('error');
      setUpdateActionLoading(false);
    }
  };

  const handleRollback = () => {
    setConfirmDialog({
      title: t('admin.system.rollbackTitle', 'Rollback Update'),
      message: t(
        'admin.system.rollbackConfirm',
        'Are you sure you want to rollback to the previous version?'
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        doRollback();
      }
    });
  };

  const doRollback = async () => {
    setUpdateActionLoading(true);
    setUpdateActionMessage(t('admin.system.rollbackApplying', 'Rolling back...'));
    setUpdateActionMessageType('success');

    try {
      await makeAdminApiCall('/admin/update/rollback', { method: 'POST' });
      setUpdateActionMessage(
        t('admin.system.rollbackRestarting', 'Rollback applied. Server is restarting...')
      );

      rollbackPollIntervalRef.current = setInterval(async () => {
        if (rollbackPollAbortRef.current) rollbackPollAbortRef.current.abort();
        const controller = new AbortController();
        rollbackPollAbortRef.current = controller;
        try {
          const response = await makeAdminApiCall('/admin/version', {
            method: 'GET',
            signal: controller.signal
          });
          if (response.data) {
            clearInterval(rollbackPollIntervalRef.current);
            rollbackPollIntervalRef.current = null;
            rollbackPollAbortRef.current = null;
            setUpdateActionMessage(
              t(
                'admin.system.rollbackSuccess',
                'Rollback complete! Now running version {{version}}.',
                {
                  version: response.data.app
                }
              )
            );
            setUpdateActionMessageType('success');
            setUpdateActionLoading(false);
            setVersionInfo(response.data);
            try {
              const statusRes = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
              setUpdateStatus(statusRes.data);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* Server not ready yet */
        } finally {
          if (rollbackPollAbortRef.current === controller) rollbackPollAbortRef.current = null;
        }
      }, 3000);

      setTimeout(() => {
        if (rollbackPollIntervalRef.current) {
          clearInterval(rollbackPollIntervalRef.current);
          rollbackPollIntervalRef.current = null;
          setUpdateActionMessage(
            t(
              'admin.system.rollbackTimeout',
              'Rollback is taking longer than expected. Please check the server status and logs.'
            )
          );
          setUpdateActionMessageType('error');
          setUpdateActionLoading(false);
        }
      }, 120000);
    } catch (error) {
      setUpdateActionMessage(
        t('admin.system.rollbackFailed', 'Rollback failed: {{error}}', {
          error: error.response?.data?.error || error.message
        })
      );
      setUpdateActionMessageType('error');
      setUpdateActionLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.nav.updates', 'Updates')}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.updates.description', 'Version information, update management, and rollback')}
        </p>
      </div>

      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start space-x-4">
            <div className="flex-shrink-0 mt-1">
              <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/50">
                <Icon
                  name="information-circle"
                  size="lg"
                  className="text-blue-600 dark:text-blue-400"
                />
              </div>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('admin.system.versionTitle', 'Version Information')}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {t(
                  'admin.system.versionDesc',
                  'Current version information for the application, frontend, and backend components.'
                )}
              </p>

              {/* Update Available Banner */}
              {!updateCheckLoading &&
                updateInfo &&
                updateInfo.updateAvailable &&
                !updateInfo.error && (
                  <div className="mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md p-4">
                    <div className="flex items-start">
                      <div className="flex-shrink-0">
                        <Icon name="check-circle" size="md" className="text-green-500 mt-0.5" />
                      </div>
                      <div className="ml-3 flex-1">
                        <h4 className="text-sm font-medium text-green-800 dark:text-green-200">
                          {t('admin.system.updateCheckTitle', 'Update Available')}
                        </h4>
                        <div className="mt-2 text-sm text-green-700 dark:text-green-300">
                          <p>
                            {t(
                              'admin.system.updateAvailable',
                              'A new version of iHub Apps is available!'
                            )}
                          </p>
                          <div className="mt-2 flex items-center space-x-4">
                            <span>
                              <strong>
                                {t('admin.system.currentVersion', 'Current Version')}:
                              </strong>{' '}
                              {updateInfo.currentVersion}
                            </span>
                            <span>
                              <strong>{t('admin.system.latestVersion', 'Latest Version')}:</strong>{' '}
                              {updateInfo.latestVersion}
                            </span>
                          </div>
                        </div>
                        {updateStatus?.isContainer && (
                          <div className="mt-3 text-sm text-green-700 dark:text-green-300">
                            <Icon
                              name="information-circle"
                              size="sm"
                              className="inline-block mr-1 -mt-0.5"
                            />
                            {t(
                              'admin.system.updateContainerNotice',
                              'In-place updates are disabled when running in a container. Pull a new container image and restart the container to update.'
                            )}
                          </div>
                        )}
                        <div className="mt-3 flex items-center space-x-3">
                          {updateStatus?.isBinary && !updateStatus?.isContainer && (
                            <button
                              onClick={handleUpdateNow}
                              disabled={updateActionLoading}
                              className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {updateActionLoading ? (
                                <svg
                                  className="animate-spin -ml-0.5 mr-1.5 h-3 w-3"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                >
                                  <circle
                                    className="opacity-25"
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                  />
                                  <path
                                    className="opacity-75"
                                    fill="currentColor"
                                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                  />
                                </svg>
                              ) : (
                                <Icon name="download" size="sm" className="mr-1.5" />
                              )}
                              {t('admin.system.updateNow', 'Update Now')}
                            </button>
                          )}
                          <a
                            href={updateInfo.releaseUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-green-700 dark:text-green-200 bg-green-100 dark:bg-green-800/50 hover:bg-green-200 dark:hover:bg-green-700/50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                          >
                            <Icon name="external-link" size="sm" className="mr-1.5" />
                            {t('admin.system.viewRelease', 'View Release on GitHub')}
                          </a>
                        </div>
                        {updateActionMessage && (
                          <div
                            className={`mt-2 text-sm ${updateActionMessageType === 'error' ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
                          >
                            {updateActionMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

              {/* Rollback Banner */}
              {updateStatus?.hasBackup && !updateStatus?.isContainer && !updateActionLoading && (
                <div className="mb-4 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <Icon name="warning" size="md" className="text-yellow-500 mt-0.5" />
                    </div>
                    <div className="ml-3 flex-1">
                      <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                        {t('admin.system.rollbackAvailable', 'Rollback Available')}
                      </h4>
                      <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
                        {t(
                          'admin.system.rollbackDesc',
                          'A backup of version {{version}} is available. You can rollback if the current version has issues.',
                          {
                            version: updateStatus.backupVersion || 'unknown'
                          }
                        )}
                      </p>
                      <div className="mt-2">
                        <button
                          onClick={handleRollback}
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-yellow-700 dark:text-yellow-200 bg-yellow-100 dark:bg-yellow-800/50 hover:bg-yellow-200 dark:hover:bg-yellow-700/50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500"
                        >
                          <Icon name="refresh" size="sm" className="mr-1.5" />
                          {t('admin.system.rollbackButton', 'Rollback to {{version}}', {
                            version: updateStatus.backupVersion || 'previous'
                          })}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {versionLoading ? (
                <div className="flex items-center text-gray-600 dark:text-gray-400">
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-600"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  {t('admin.system.versionLoading', 'Loading version information...')}
                </div>
              ) : versionError ? (
                <div className="p-4 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800">
                  <div className="flex">
                    <Icon name="warning" size="md" className="text-red-500 mt-0.5 mr-3" />
                    <p className="text-sm text-red-700 dark:text-red-300">
                      {t('admin.system.versionError', 'Failed to load version information')}:{' '}
                      {versionError}
                    </p>
                  </div>
                </div>
              ) : versionInfo ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.system.versionApp', 'Application Version')}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {versionInfo.app}
                      </span>
                    </div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.system.versionClient', 'Frontend Version')}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {versionInfo.client}
                      </span>
                    </div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.system.versionServer', 'Backend Version')}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {versionInfo.server}
                      </span>
                    </div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.system.versionNode', 'Node.js Version')}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {versionInfo.node}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminUpdatesPage;
