import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../../../api/client';

/**
 * Hook for fetching the current user's workflow executions.
 * Supports filtering by status and pagination.
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

  const fetchExecutions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      params.append('limit', String(limit));
      params.append('offset', String(offset));

      const response = await apiClient.get(`/workflows/my-executions?${params.toString()}`);
      setExecutions(response.data || []);
    } catch (err) {
      console.error('Failed to fetch executions:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load executions');
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  }, [status, limit, offset]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

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
