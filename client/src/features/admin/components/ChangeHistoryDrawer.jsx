import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { XMarkIcon, ClockIcon, ArrowUturnLeftIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * Truncate a string to a maximum length, appending ellipsis if needed.
 */
function truncate(str, max = 200) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

/**
 * Format a timestamp into a human-readable date/time string.
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return String(ts);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * JsonDiff - Renders a side-by-side comparison of top-level keys between
 * two JSON objects (before / after).
 */
function JsonDiff({ before, after }) {
  const { t } = useTranslation();

  if (!before && !after) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">
        {t('admin.changeHistory.noDiffData', 'No diff data available.')}
      </p>
    );
  }

  const beforeObj = before || {};
  const afterObj = after || {};
  const allKeys = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])].sort();

  if (allKeys.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">
        {t('admin.changeHistory.emptyObjects', 'Both objects are empty.')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {allKeys.map(key => {
        const beforeVal = JSON.stringify(beforeObj[key], null, 2);
        const afterVal = JSON.stringify(afterObj[key], null, 2);
        const isAdded = !(key in beforeObj);
        const isRemoved = !(key in afterObj);
        const isChanged = !isAdded && !isRemoved && beforeVal !== afterVal;
        const isUnchanged = !isAdded && !isRemoved && !isChanged;

        if (isUnchanged) {
          return null;
        }

        if (isAdded) {
          return (
            <div
              key={key}
              className="rounded border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-2"
            >
              <span className="text-xs font-mono font-semibold text-green-700 dark:text-green-400">
                + {key}
              </span>
              <pre className="text-xs font-mono text-green-700 dark:text-green-300 whitespace-pre-wrap mt-1">
                {truncate(afterVal)}
              </pre>
            </div>
          );
        }

        if (isRemoved) {
          return (
            <div
              key={key}
              className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2"
            >
              <span className="text-xs font-mono font-semibold text-red-700 dark:text-red-400">
                - {key}
              </span>
              <pre className="text-xs font-mono text-red-700 dark:text-red-300 whitespace-pre-wrap mt-1 line-through">
                {truncate(beforeVal)}
              </pre>
            </div>
          );
        }

        // Changed
        return (
          <div
            key={key}
            className="rounded border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 p-2"
          >
            <span className="text-xs font-mono font-semibold text-yellow-700 dark:text-yellow-400">
              ~ {key}
            </span>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <div>
                <span className="text-[10px] uppercase tracking-wider text-red-500 dark:text-red-400 font-semibold">
                  {t('admin.changeHistory.before', 'Before')}
                </span>
                <pre className="text-xs font-mono text-red-700 dark:text-red-300 whitespace-pre-wrap mt-0.5 bg-red-50 dark:bg-red-900/20 rounded p-1">
                  {truncate(beforeVal)}
                </pre>
              </div>
              <div>
                <span className="text-[10px] uppercase tracking-wider text-green-500 dark:text-green-400 font-semibold">
                  {t('admin.changeHistory.after', 'After')}
                </span>
                <pre className="text-xs font-mono text-green-700 dark:text-green-300 whitespace-pre-wrap mt-0.5 bg-green-50 dark:bg-green-900/20 rounded p-1">
                  {truncate(afterVal)}
                </pre>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * ConfirmRollbackModal - Inline confirmation modal for rollback actions.
 */
function ConfirmRollbackModal({ isOpen, onConfirm, onCancel, loading, snapshot }) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 max-w-md w-full mx-4 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t('admin.changeHistory.confirmRollbackTitle', 'Confirm Rollback')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
          {t(
            'admin.changeHistory.confirmRollbackMessage',
            'Are you sure you want to rollback to this snapshot? This will restore the configuration to the state it was in at:'
          )}
        </p>
        {snapshot && (
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">
            {formatTimestamp(snapshot.ts)}
          </p>
        )}
        {snapshot?.admin && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t('admin.changeHistory.changedBy', 'Changed by')}: {snapshot.admin}
          </p>
        )}
        <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
          {t(
            'admin.changeHistory.rollbackWarning',
            'This action will create a new change entry and cannot be undone except by another rollback.'
          )}
        </p>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 disabled:opacity-50"
          >
            {t('admin.changeHistory.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 inline-flex items-center"
          >
            {loading && (
              <svg
                className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
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
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            <ArrowUturnLeftIcon className="h-4 w-4 mr-1.5" />
            {t('admin.changeHistory.rollback', 'Rollback')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Loading spinner component.
 */
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <svg
        className="animate-spin h-8 w-8 text-indigo-500 dark:text-indigo-400"
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
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    </div>
  );
}

/**
 * ChangeHistoryDrawer - A fixed right-side drawer that displays the change history
 * for a given admin resource, allowing snapshot inspection and rollback.
 */
function ChangeHistoryDrawer({ isOpen, onClose, resource, resourceId }) {
  const { t } = useTranslation();

  // State
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [rollbackModalOpen, setRollbackModalOpen] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackError, setRollbackError] = useState(null);

  /**
   * Fetch the list of snapshots for the current resource.
   */
  const fetchSnapshots = useCallback(async () => {
    if (!resource || !resourceId) return;

    setLoading(true);
    setError(null);
    setSelectedSnapshot(null);
    setDetail(null);
    setDetailError(null);
    setRollbackError(null);

    try {
      const response = await makeAdminApiCall(
        `/admin/changes/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}`
      );
      const data = response.data || response;
      setSnapshots(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(
        err.message || t('admin.changeHistory.fetchError', 'Failed to load change history.')
      );
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, [resource, resourceId, t]);

  /**
   * Fetch the detail (before/after) for a specific snapshot.
   */
  const fetchDetail = useCallback(
    async snapshot => {
      if (!snapshot?.filename) return;

      setDetailLoading(true);
      setDetailError(null);
      setRollbackError(null);

      try {
        const response = await makeAdminApiCall(
          `/admin/changes/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}/${encodeURIComponent(snapshot.filename)}`
        );
        setDetail(response.data || response);
      } catch (err) {
        setDetailError(
          err.message || t('admin.changeHistory.detailError', 'Failed to load snapshot details.')
        );
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [resource, resourceId, t]
  );

  /**
   * Perform the rollback for the currently selected snapshot.
   */
  const handleRollback = useCallback(async () => {
    if (!selectedSnapshot?.filename) return;

    setRollbackLoading(true);
    setRollbackError(null);

    try {
      await makeAdminApiCall(
        `/admin/changes/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}/${encodeURIComponent(selectedSnapshot.filename)}/rollback`,
        { method: 'POST' }
      );
      setRollbackModalOpen(false);
      // Refresh snapshots after rollback
      await fetchSnapshots();
    } catch (err) {
      setRollbackError(
        err.message || t('admin.changeHistory.rollbackError', 'Failed to rollback.')
      );
    } finally {
      setRollbackLoading(false);
    }
  }, [selectedSnapshot, resource, resourceId, fetchSnapshots, t]);

  // Fetch snapshots when drawer opens
  useEffect(() => {
    if (isOpen && resource && resourceId) {
      fetchSnapshots();
    }
  }, [isOpen, resource, resourceId, fetchSnapshots]);

  // Handle selecting a snapshot
  const handleSelectSnapshot = useCallback(
    snapshot => {
      setSelectedSnapshot(snapshot);
      setRollbackError(null);
      fetchDetail(snapshot);
    },
    [fetchDetail]
  );

  // Handle going back to the list
  const handleBackToList = useCallback(() => {
    setSelectedSnapshot(null);
    setDetail(null);
    setDetailError(null);
    setRollbackError(null);
  }, []);

  // Close drawer and reset state
  const handleClose = useCallback(() => {
    onClose();
    // Delay state reset so the slide-out animation completes
    setTimeout(() => {
      setSelectedSnapshot(null);
      setDetail(null);
      setDetailError(null);
      setRollbackError(null);
    }, 300);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleClose}
      />

      {/* Drawer */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-[480px] max-w-full bg-white dark:bg-gray-900 shadow-2xl border-l border-gray-200 dark:border-gray-700 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClockIcon className="h-5 w-5 text-indigo-500 dark:text-indigo-400 flex-shrink-0" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
              {t('admin.changeHistory.title', 'Change History')}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label={t('admin.changeHistory.close', 'Close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Subtitle with resource info */}
        {resource && resourceId && (
          <div className="px-5 py-2 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              <span className="font-medium text-gray-700 dark:text-gray-300">{resource}</span>
              {' / '}
              <span className="font-mono">{resourceId}</span>
            </p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Loading state */}
          {loading && <LoadingSpinner />}

          {/* Error state */}
          {!loading && error && (
            <div className="m-4 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              <button
                type="button"
                onClick={fetchSnapshots}
                className="mt-2 text-xs font-medium text-red-600 dark:text-red-400 underline hover:no-underline"
              >
                {t('admin.changeHistory.retry', 'Try again')}
              </button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && snapshots.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <ClockIcon className="h-12 w-12 text-gray-300 dark:text-gray-600 mb-3" />
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                {t('admin.changeHistory.noChanges', 'No changes recorded yet.')}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                {t(
                  'admin.changeHistory.noChangesHint',
                  'Changes will appear here when this resource is modified.'
                )}
              </p>
            </div>
          )}

          {/* Snapshot list */}
          {!loading && !error && snapshots.length > 0 && !selectedSnapshot && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {snapshots.map((snapshot, index) => (
                <li key={snapshot.filename || index}>
                  <button
                    type="button"
                    onClick={() => handleSelectSnapshot(snapshot)}
                    className="w-full text-left px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors duration-150 focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-800/50"
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {formatTimestamp(snapshot.ts)}
                        </p>
                        {snapshot.admin && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {t('admin.changeHistory.by', 'by')} {snapshot.admin}
                          </p>
                        )}
                      </div>
                      <svg
                        className="h-4 w-4 text-gray-400 flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Snapshot detail view */}
          {selectedSnapshot && (
            <div className="p-5">
              {/* Back button */}
              <button
                type="button"
                onClick={handleBackToList}
                className="inline-flex items-center text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 mb-4"
              >
                <svg
                  className="h-3.5 w-3.5 mr-1"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                {t('admin.changeHistory.backToList', 'Back to list')}
              </button>

              {/* Snapshot header */}
              <div className="mb-4">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {formatTimestamp(selectedSnapshot.ts)}
                </p>
                {selectedSnapshot.admin && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t('admin.changeHistory.by', 'by')} {selectedSnapshot.admin}
                  </p>
                )}
              </div>

              {/* Rollback error */}
              {rollbackError && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                  <p className="text-sm text-red-700 dark:text-red-400">{rollbackError}</p>
                </div>
              )}

              {/* Rollback button */}
              <button
                type="button"
                onClick={() => setRollbackModalOpen(true)}
                className="mb-4 inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-amber-300 dark:border-amber-600 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 transition-colors duration-150"
              >
                <ArrowUturnLeftIcon className="h-4 w-4 mr-1.5" />
                {t('admin.changeHistory.rollbackToThis', 'Rollback to this version')}
              </button>

              {/* Detail loading */}
              {detailLoading && <LoadingSpinner />}

              {/* Detail error */}
              {!detailLoading && detailError && (
                <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                  <p className="text-sm text-red-700 dark:text-red-400">{detailError}</p>
                </div>
              )}

              {/* Diff view */}
              {!detailLoading && !detailError && detail && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                    {t('admin.changeHistory.changes', 'Changes')}
                  </h4>
                  <JsonDiff before={detail.before} after={detail.after} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Rollback confirmation modal */}
      <ConfirmRollbackModal
        isOpen={rollbackModalOpen}
        onConfirm={handleRollback}
        onCancel={() => setRollbackModalOpen(false)}
        loading={rollbackLoading}
        snapshot={selectedSnapshot}
      />
    </>
  );
}

export default ChangeHistoryDrawer;
