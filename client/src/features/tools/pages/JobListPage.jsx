import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { apiClient } from '../../../api/client';
import StatusBadge from '../../../shared/components/StatusBadge';
import ProgressBar from '../../../shared/components/ProgressBar';

function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

export default function JobListPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  // Abort the previous in-flight fetch when a new poll tick starts (or on
  // unmount) so slow responses don't pile up against the browser's 6-connection
  // HTTP/1.1 limit.
  const inFlightAbortRef = useRef(null);

  const fetchJobs = useCallback(async () => {
    if (inFlightAbortRef.current) {
      inFlightAbortRef.current.abort();
    }
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    try {
      const res = await apiClient.get('/tools-service/jobs', { signal: controller.signal });
      setJobs(res.data);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      // Silently fail other errors
    } finally {
      if (inFlightAbortRef.current === controller) {
        inFlightAbortRef.current = null;
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();

    // Auto-refresh while any job is in progress
    const interval = setInterval(() => {
      fetchJobs();
    }, 5000);

    return () => {
      clearInterval(interval);
      if (inFlightAbortRef.current) {
        inFlightAbortRef.current.abort();
        inFlightAbortRef.current = null;
      }
    };
  }, [fetchJobs]);

  const handleDownload = jobId => {
    const downloadUrl = buildApiUrl(`/tools-service/jobs/${jobId}/download`);
    window.open(downloadUrl, '_blank');
  };

  const handleCancel = async jobId => {
    try {
      await apiClient.patch(`/tools-service/jobs/${jobId}/cancel`);
      fetchJobs();
    } catch {
      // Job may already be done
    }
  };

  const hasActiveJobs = jobs.some(j => ['queued', 'processing', 'building'].includes(j.status));

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Jobs</h1>
        <Link
          to="/tools/ocr-ai"
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
        >
          New OCR Job
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No jobs yet</p>
          <p className="text-sm">
            Start an{' '}
            <Link to="/tools/ocr-ai" className="text-blue-600 dark:text-blue-400 hover:underline">
              OCR job
            </Link>{' '}
            to see it here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                <th className="py-3 px-2 font-medium text-gray-600 dark:text-gray-400">File</th>
                <th className="py-3 px-2 font-medium text-gray-600 dark:text-gray-400">Status</th>
                <th className="py-3 px-2 font-medium text-gray-600 dark:text-gray-400">Progress</th>
                <th className="py-3 px-2 font-medium text-gray-600 dark:text-gray-400">Model</th>
                <th className="py-3 px-2 font-medium text-gray-600 dark:text-gray-400">Created</th>
                <th className="py-3 px-2 font-medium text-gray-600 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const isActive = ['queued', 'processing', 'building'].includes(job.status);
                return (
                  <tr
                    key={job.id}
                    className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <td className="py-3 px-2 text-gray-900 dark:text-white truncate max-w-[200px]">
                      {job.resultFilename || job.id.slice(0, 8)}
                    </td>
                    <td className="py-3 px-2">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="py-3 px-2 w-32">
                      {job.progress?.total > 0 ? (
                        <ProgressBar
                          value={job.progress.current}
                          max={job.progress.total}
                          variant="inline"
                        />
                      ) : isActive ? (
                        <span className="text-xs text-gray-400">Pending...</span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="py-3 px-2 text-gray-600 dark:text-gray-400">
                      {job.model || '-'}
                    </td>
                    <td className="py-3 px-2 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {formatDate(job.createdAt)}
                    </td>
                    <td className="py-3 px-2">
                      <div className="flex gap-2">
                        {job.status === 'completed' && (
                          <button
                            onClick={() => handleDownload(job.id)}
                            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                          >
                            Download
                          </button>
                        )}
                        {isActive && (
                          <button
                            onClick={() => handleCancel(job.id)}
                            className="px-2 py-1 text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {hasActiveJobs && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Auto-refreshing every 5 seconds...
            </p>
          )}
        </div>
      )}
    </div>
  );
}
