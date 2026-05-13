import { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../../../api/client';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

/**
 * Hook for fetching the current user's workflow executions.
 * Supports filtering by status and pagination.
 * Only fetches if the workflows feature is enabled.
 *
 * @param {Object} options - Fetch options
 * @param {string} [options.status] - Filter by status (running, paused, completed, failed, cancelled)
 * @param {number} [options.limit=20] - Maximum number of results
 * @param {number} [options.offset=0] - Number of results to skip
 * @returns {Object} Execution list state and methods
 * @property {Array} executions - List of user's executions
 * @property {boolean} loading - Whether the list is loading
 * @property {string|null} error - Error message if fetch failed
 * @property {Function} refetch - Function to refetch the list
 * @property {number} runningCount - Count of running/paused executions
 */
function useMyExecutions(options = {}) {
  const { status, limit = 20, offset = 0 } = options;

  const [executions, setExecutions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const featureFlags = useFeatureFlags();
  // Abort the previous in-flight request whenever a new one starts, and on
  // unmount. Polling pages call this on a 5s interval; without aborting, slow
  // responses could stack up to the browser's 6-connection HTTP/1.1 limit.
  const inFlightAbortRef = useRef(null);

  const fetchExecutions = useCallback(async () => {
    // Don't fetch if workflows feature is disabled
    if (!featureFlags.isEnabled('workflows', true)) {
      setExecutions([]);
      setLoading(false);
      return;
    }

    if (inFlightAbortRef.current) {
      inFlightAbortRef.current.abort();
    }
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      params.append('limit', String(limit));
      params.append('offset', String(offset));

      const response = await apiClient.get(`/workflows/my-executions?${params.toString()}`, {
        signal: controller.signal
      });
      setExecutions(response.data || []);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      console.error('Failed to fetch executions:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load executions');
      setExecutions([]);
    } finally {
      if (inFlightAbortRef.current === controller) {
        inFlightAbortRef.current = null;
      }
      setLoading(false);
    }
  }, [status, limit, offset, featureFlags]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  // Abort any in-flight request on unmount.
  useEffect(() => {
    return () => {
      if (inFlightAbortRef.current) {
        inFlightAbortRef.current.abort();
        inFlightAbortRef.current = null;
      }
    };
  }, []);

  // Calculate running/paused count for badge display
  const runningCount = executions.filter(
    e => e.status === 'running' || e.status === 'paused'
  ).length;

  return {
    executions,
    loading,
    error,
    refetch: fetchExecutions,
    runningCount
  };
}

export default useMyExecutions;
