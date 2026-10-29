// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import AdminLoadError from '../components/AdminLoadError';
import StagedUpdatePanel from '../components/updates/StagedUpdatePanel';
import InstallFromFileCard from '../components/updates/InstallFromFileCard';
import { isRestartedServer } from '../components/updates/restartDetection';

/** A restart with migrations under a Windows service can take minutes. */
const RESTART_TIMEOUT_MS = 10 * 60 * 1000;
const RESTART_POLL_MS = 3000;

function Spinner({ className = 'h-3 w-3' }) {
  return (
    <svg className={`animate-spin ${className}`} fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

const MESSAGE_TONES = {
  success:
    'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200',
  warning:
    'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200',
  error:
    'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200',
  info: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200'
};

/**
 * What the last apply or rollback came to, as recorded by the launcher or the
 * restarted server (`.update-result.json`).
 */
function describeResult(result, runningVersion, t) {
  if (!result) {
    return {
      tone: 'success',
      text: t(
        'admin.updates.resultRunning',
        'The server is back. Now running version {{version}}.',
        {
          version: runningVersion
        }
      )
    };
  }
  if (result.status === 'success') {
    return {
      tone: 'success',
      text: t('admin.system.updateSuccess', 'Update complete! Now running version {{version}}.', {
        version: result.runningVersion || runningVersion
      })
    };
  }
  if (result.status === 'rolled-back' && result.manual) {
    return {
      tone: 'success',
      text: t(
        'admin.system.rollbackSuccess',
        'Rollback complete! Now running version {{version}}.',
        {
          version: runningVersion
        }
      )
    };
  }
  if (result.status === 'rolled-back') {
    return {
      tone: 'warning',
      text: t(
        'admin.updates.resultRolledBack',
        'The update to {{target}} was rolled back automatically: {{reason}}',
        { target: result.targetVersion, reason: result.reason }
      )
    };
  }
  return {
    tone: 'error',
    text: t('admin.updates.resultFailed', 'The update to {{target}} failed: {{reason}}', {
      target: result.targetVersion,
      reason: result.reason
    })
  };
}

function AdminUpdatesPage() {
  const { t } = useTranslation();
  const [versionInfo, setVersionInfo] = useState(null);
  const [versionLoading, setVersionLoading] = useState(true);
  const [versionError, setVersionError] = useState('');
  // Independent of the version cards below, which must render even when the
  // GitHub check never answers (issue #2150).
  const { updateInfo, setUpdateInfo } = useUpdateCheck();
  const [updateStatus, setUpdateStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  /** Summary of an archive just verified (accepted or rejected); falls back to the staged one. */
  const [summary, setSummary] = useState(null);
  /** { tone, text } shown below the version information. */
  const [message, setMessage] = useState(null);
  /** { kind: 'update'|'rollback', phase: 'waiting'|'done'|'timeout' } while the server restarts. */
  const [restart, setRestart] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [restoreConfig, setRestoreConfig] = useState(false);
  const pollRef = useRef(null);
  const pollAbortRef = useRef(null);

  const fetchVersionInfo = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/version', { method: 'GET' });
      setVersionInfo(response.data);
      setVersionError('');
    } catch (error) {
      setVersionError(error.message || 'Failed to load version information');
    } finally {
      setVersionLoading(false);
    }
  }, []);

  const fetchUpdateStatus = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
      setUpdateStatus(response.data);
      return response.data;
    } catch {
      // Update status not available (not a binary installation)
      return null;
    }
  }, []);

  useEffect(() => {
    void fetchVersionInfo();
    void fetchUpdateStatus();
  }, [fetchVersionInfo, fetchUpdateStatus]);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  };

  useEffect(() => stopPolling, []);

  /**
   * Wait for the server to come back from the restart. "Back" means another
   * start of the server (a new boot id), not merely an answer: the old process
   * keeps answering for a moment after it scheduled the restart.
   */
  const watchRestart = (kind, before) => {
    stopPolling();
    const startedAt = Date.now();
    let sawDown = false;
    setRestart({ kind, phase: 'waiting' });
    setMessage({
      tone: 'info',
      text:
        kind === 'rollback'
          ? t('admin.system.rollbackRestarting', 'Rollback applied. Server is restarting...')
          : t(
              'admin.updates.restarting',
              'The server is restarting to install the update. This page updates when it is back.'
            )
    });

    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > RESTART_TIMEOUT_MS) {
        stopPolling();
        setRestart({ kind, phase: 'timeout' });
        setMessage({
          tone: 'error',
          text: t(
            'admin.updates.restartTimeout',
            'The server has not come back after 10 minutes. Check the server log (and the service manager), or run the launcher with --update=status.'
          )
        });
        return;
      }
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const response = await makeAdminApiCall('/admin/update/status', {
          method: 'GET',
          signal: controller.signal,
          timeout: 5000
        });
        const status = response.data;
        if (!isRestartedServer(status, before, sawDown)) return;
        stopPolling();
        setUpdateStatus(status);
        setSummary(null);
        setRestart({ kind, phase: 'done' });
        setMessage(describeResult(status.lastResult, status.currentVersion, t));
        setUpdateInfo(prev =>
          prev ? { ...prev, updateAvailable: prev.latestVersion !== status.currentVersion } : prev
        );
        void fetchVersionInfo();
      } catch (error) {
        // Server not ready yet. A poll this page aborted itself proves nothing.
        if (error?.code !== 'ERR_CANCELED') sawDown = true;
      } finally {
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
      }
    }, RESTART_POLL_MS);
  };

  const errorText = error => error.response?.data?.error || error.message;

  /** Online: download the release from GitHub; it is verified like any other archive. */
  const handleDownload = async () => {
    setBusy(true);
    setMessage({
      tone: 'info',
      text: t('admin.system.updateDownloading', 'Downloading update...')
    });
    try {
      const response = await makeAdminApiCall('/admin/update/download', {
        method: 'POST',
        timeout: 0
      });
      if (response.data?.success === false) {
        setMessage({ tone: 'info', text: response.data.message });
      } else {
        setSummary(response.data);
        setMessage(null);
      }
    } catch (error) {
      if (error.response?.status === 422 && error.response.data?.summary) {
        setSummary(error.response.data.summary);
        setMessage(null);
      } else {
        setMessage({
          tone: 'error',
          text: t('admin.system.updateFailed', 'Update failed: {{error}}', {
            error: errorText(error)
          })
        });
      }
    } finally {
      setBusy(false);
      void fetchUpdateStatus();
    }
  };

  const handleStaged = ({ summary: staged, error }) => {
    if (staged) {
      setSummary(staged);
      setMessage(null);
    } else if (error) {
      setMessage({ tone: 'error', text: error });
    }
    void fetchUpdateStatus();
  };

  const handleApply = async options => {
    setBusy(true);
    const before = { bootId: updateStatus?.bootId, version: updateStatus?.currentVersion };
    try {
      await makeAdminApiCall('/admin/update/apply', {
        method: 'POST',
        body: options,
        timeout: 0
      });
      watchRestart('update', before);
    } catch (error) {
      setMessage({
        tone: 'error',
        text: t('admin.system.updateFailed', 'Update failed: {{error}}', {
          error: errorText(error)
        })
      });
      void fetchUpdateStatus();
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    const current = summary ?? updateStatus?.staged;
    if (current && !current.accepted) {
      // A rejected archive was never staged; there is nothing to delete.
      setSummary(null);
      return;
    }
    setBusy(true);
    try {
      await makeAdminApiCall('/admin/update/staged', { method: 'DELETE' });
      setSummary(null);
      setMessage(null);
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
      void fetchUpdateStatus();
    }
  };

  const doRollback = async withConfig => {
    setBusy(true);
    const before = { bootId: updateStatus?.bootId, version: updateStatus?.currentVersion };
    setMessage({ tone: 'info', text: t('admin.system.rollbackApplying', 'Rolling back...') });
    try {
      await makeAdminApiCall('/admin/update/rollback', {
        method: 'POST',
        body: { restoreConfig: withConfig },
        timeout: 0
      });
      watchRestart('rollback', before);
    } catch (error) {
      setMessage({
        tone: 'error',
        text: t('admin.system.rollbackFailed', 'Rollback failed: {{error}}', {
          error: errorText(error)
        })
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = () => {
    setRestoreConfig(false);
    setConfirmDialog(true);
  };

  const restarting = restart?.phase === 'waiting';
  const canUpdateInPlace = updateStatus?.isBinary && !updateStatus?.isContainer;
  const shownSummary = summary ?? updateStatus?.staged ?? null;
  const lastResult = updateStatus?.lastResult;
  const showLastResult =
    !restart &&
    !message &&
    lastResult &&
    (lastResult.status === 'failed' || (lastResult.status === 'rolled-back' && !lastResult.manual));

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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start space-x-4">
            <div className="shrink-0 mt-1">
              <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/50">
                <Icon
                  name="information-circle"
                  size="lg"
                  className="text-blue-600 dark:text-blue-400"
                />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('admin.system.versionTitle', 'Version Information')}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {t(
                  'admin.system.versionDesc',
                  'Current version information for the application, frontend, and backend components.'
                )}
              </p>

              <div aria-live="polite">
                {message && (
                  <div
                    className={`mb-4 flex items-start gap-2 rounded-md border p-4 text-sm ${MESSAGE_TONES[message.tone]}`}
                    role={message.tone === 'error' ? 'alert' : 'status'}
                  >
                    {restarting && <Spinner className="h-4 w-4 mt-0.5 shrink-0" />}
                    <span>{message.text}</span>
                  </div>
                )}
                {showLastResult && (
                  <div
                    className={`mb-4 rounded-md border p-4 text-sm ${MESSAGE_TONES[describeResult(lastResult, updateStatus.currentVersion, t).tone]}`}
                  >
                    {describeResult(lastResult, updateStatus.currentVersion, t).text}
                  </div>
                )}
              </div>

              {/* Update Available Banner */}
              {updateInfo && updateInfo.updateAvailable && !updateInfo.error && !restarting && (
                <div className="mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md p-4">
                  <div className="flex items-start">
                    <div className="shrink-0">
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
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span>
                            <strong>{t('admin.system.currentVersion', 'Current Version')}:</strong>{' '}
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
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        {canUpdateInPlace && (
                          <button
                            type="button"
                            onClick={handleDownload}
                            disabled={busy}
                            className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-green-700 hover:bg-green-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy ? (
                              <Spinner className="-ml-0.5 mr-1.5 h-3 w-3" />
                            ) : (
                              <Icon name="download" size="sm" className="mr-1.5" />
                            )}
                            {t('admin.updates.downloadAndVerify', 'Download and verify')}
                          </button>
                        )}
                        <a
                          href={updateInfo.releaseUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-green-700 dark:text-green-200 bg-green-100 dark:bg-green-800/50 hover:bg-green-200 dark:hover:bg-green-700/50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                        >
                          <Icon name="external-link" size="sm" className="mr-1.5" />
                          {t('admin.system.viewRelease', 'View Release on GitHub')}
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Rollback Banner */}
              {updateStatus?.hasBackup && !updateStatus?.isContainer && !restarting && (
                <div className="mb-4 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
                  <div className="flex items-start">
                    <div className="shrink-0">
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
                          type="button"
                          onClick={handleRollback}
                          disabled={busy}
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-yellow-700 dark:text-yellow-200 bg-yellow-100 dark:bg-yellow-800/50 hover:bg-yellow-200 dark:hover:bg-yellow-700/50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 disabled:opacity-50"
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
                  <Spinner className="-ml-1 mr-3 h-5 w-5 text-blue-600" />
                  {t('admin.system.versionLoading', 'Loading version information...')}
                </div>
              ) : versionError ? (
                <AdminLoadError
                  title={t('admin.system.versionError', 'Failed to load version information')}
                  message={versionError}
                  framed={false}
                  action={null}
                />
              ) : versionInfo ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    ['admin.system.versionApp', 'Application Version', versionInfo.app],
                    ['admin.system.versionClient', 'Frontend Version', versionInfo.client],
                    ['admin.system.versionServer', 'Backend Version', versionInfo.server],
                    ['admin.system.versionNode', 'Node.js Version', versionInfo.node]
                  ].map(([key, fallback, value]) => (
                    <div
                      key={key}
                      className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t(key, fallback)}
                        </span>
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {value}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {canUpdateInPlace && shownSummary && !restarting && (
          <StagedUpdatePanel
            key={`${shownSummary.archiveSha256}-${shownSummary.stagedAt}`}
            summary={shownSummary}
            busy={busy}
            onApply={handleApply}
            onDiscard={handleDiscard}
          />
        )}

        {updateStatus?.canInstallFromFile && !restarting && (
          <InstallFromFileCard
            status={updateStatus}
            latestVersion={updateInfo?.updateAvailable ? updateInfo.latestVersion : null}
            busy={busy}
            setBusy={setBusy}
            onStaged={handleStaged}
          />
        )}
      </div>
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={t('admin.system.rollbackTitle', 'Rollback Update')}
        message={
          <div className="space-y-3">
            <p>
              {t(
                'admin.system.rollbackConfirm',
                'Are you sure you want to rollback to the previous version?'
              )}
            </p>
            {updateStatus?.backupHasConfigSnapshot && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  checked={restoreConfig}
                  onChange={event => setRestoreConfig(event.target.checked)}
                />
                <span>
                  {t(
                    'admin.updates.restoreConfig',
                    'Also restore the configuration as it was before the update. Configuration changes made since then are lost.'
                  )}
                </span>
              </label>
            )}
          </div>
        }
        danger
        onConfirm={() => {
          setConfirmDialog(null);
          void doRollback(restoreConfig);
        }}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminUpdatesPage;
