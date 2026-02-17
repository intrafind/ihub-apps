import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../../../api/client';

/**
 * Hook for fetching available workflow definitions.
 * Returns workflows the user has permission to execute.
 *
 * @returns {Object} Workflow list state and methods
 * @property {Array} workflows - List of workflow definitions
 * @property {boolean} loading - Whether the list is loading
 * @property {string|null} error - Error message if fetch failed
 * @property {Function} refetch - Function to refetch the list
 */
function useWorkflowList() {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchWorkflows = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get('/workflows');
      setWorkflows(response.data || []);
    } catch (err) {
      console.error('Failed to fetch workflows:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load workflows');
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  return {
    workflows,
    loading,
    error,
    refetch: fetchWorkflows
  };
}

export default useWorkflowList;
