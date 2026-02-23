import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient } from '../../../api/client';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

/**
 * Hook for managing a single workflow execution.
 * Handles SSE streaming for real-time updates and checkpoint responses.
 * Only fetches if the workflows feature is enabled.
 *
 * @param {string} executionId - The workflow execution ID
 * @returns {Object} Execution state and methods
 * @property {Object|null} state - Current execution state
 * @property {boolean} loading - Whether initial state is loading
 * @property {boolean} connected - Whether SSE connection is active
 * @property {string|null} error - Error message if any
 * @property {Function} respondToCheckpoint - Function to respond to human checkpoint
 * @property {Function} reconnect - Function to reconnect SSE stream
 * @property {Function} refetch - Function to refetch execution state
 */
function useWorkflowExecution(executionId) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const featureFlags = useFeatureFlags();

  // Fetch initial execution state
  const fetchState = useCallback(async () => {
    if (!executionId) return;

    // Don't fetch if workflows feature is disabled
    if (!featureFlags.isEnabled('workflows', true)) {
      setState(null);
      setLoading(false);
      setError('Workflows feature is disabled');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(`/workflows/executions/${executionId}`);
      setState(response.data);
    } catch (err) {
      console.error('Failed to fetch execution state:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load execution');
    } finally {
      setLoading(false);
    }
  }, [executionId, featureFlags]);

  // Connect to SSE stream
  const connectSSE = useCallback(() => {
    if (!executionId) return;

    // Don't connect if workflows feature is disabled
    if (!featureFlags.isEnabled('workflows', true)) {
      return;
    }

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const url = buildApiUrl(`workflows/executions/${executionId}/stream`);
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setError(null);
    };

    // Handle workflow events
    const eventTypes = [
      'connected',
      'workflow.start',
      'workflow.iteration',
      'workflow.node.start',
      'workflow.node.complete',
      'workflow.node.error',
      'workflow.paused',
      'workflow.human.required',
      'workflow.human.responded',
      'workflow.complete',
      'workflow.failed',
      'workflow.cancelled',
      'workflow.checkpoint.saved'
    ];

    const handleEvent = event => {
      let data = null;
      if (event.data) {
        try {
          data = JSON.parse(event.data);
        } catch {
          data = event.data;
        }
      }

      const eventType = event.type;

      switch (eventType) {
        case 'connected':
          // SSE connection established
          break;

        case 'workflow.iteration':
          // Iteration progress - update state to trigger UI refresh
          setState(prev => ({
            ...prev,
            _lastIteration: data?.iteration
          }));
          break;

        case 'workflow.node.start':
          setState(prev => ({
            ...prev,
            currentNodes: data.nodeId ? [data.nodeId] : prev?.currentNodes || []
          }));
          break;

        case 'workflow.node.complete':
          setState(prev => {
            // Build updated nodeResults with both iteration key and base key
            const nodeResults = { ...prev?.data?.nodeResults };
            const iteration = data.result?.iteration || data.result?.output?.iteration;

            // Store with iteration key if iteration info is available (for loops)
            if (iteration !== undefined) {
              nodeResults[`${data.nodeId}_iter${iteration}`] = data.result;
            }

            // Always store latest result under nodeId for backward compatibility
            nodeResults[data.nodeId] = data.result;

            // Update execution metrics from node result
            const prevMetrics = prev?.data?.executionMetrics || {
              totalDuration: 0,
              totalTokens: { input: 0, output: 0, total: 0 },
              nodeCount: 0
            };
            const resultMetrics = data.result?.metrics;
            const resultTokens = data.result?.tokens;
            const updatedMetrics = resultMetrics
              ? {
                  totalDuration: prevMetrics.totalDuration + (resultMetrics.duration || 0),
                  totalTokens: {
                    input: prevMetrics.totalTokens.input + (resultTokens?.input || 0),
                    output: prevMetrics.totalTokens.output + (resultTokens?.output || 0),
                    total:
                      prevMetrics.totalTokens.total +
                      ((resultTokens?.input || 0) + (resultTokens?.output || 0))
                  },
                  nodeCount: prevMetrics.nodeCount + 1
                }
              : prevMetrics;

            return {
              ...prev,
              // Remove completed node from currentNodes
              currentNodes: (prev?.currentNodes || []).filter(id => id !== data.nodeId),
              history: [...(prev?.history || []), { ...data, iteration }],
              completedNodes: [...(prev?.completedNodes || []), data.nodeId].filter(
                (v, i, a) => a.indexOf(v) === i
              ),
              data: {
                ...prev?.data,
                nodeResults,
                nodeInvocations: (prev?.data?.nodeInvocations || 0) + 1,
                executionMetrics: updatedMetrics
              }
            };
          });
          break;

        case 'workflow.node.error':
          setState(prev => ({
            ...prev,
            failedNodes: [...(prev?.failedNodes || []), data.nodeId].filter(
              (v, i, a) => a.indexOf(v) === i
            ),
            errors: [...(prev?.errors || []), data.error]
          }));
          break;

        case 'workflow.human.required':
          setState(prev => ({
            ...prev,
            status: 'paused',
            pendingCheckpoint: data.checkpoint,
            currentNodes: data.checkpoint?.nodeId ? [data.checkpoint.nodeId] : prev?.currentNodes
          }));
          break;

        case 'workflow.human.responded':
          setState(prev => ({
            ...prev,
            pendingCheckpoint: null
          }));
          break;

        case 'workflow.paused':
          setState(prev => ({
            ...prev,
            status: 'paused'
          }));
          break;

        case 'workflow.complete':
          setState(prev => ({
            ...prev,
            // Use custom status from event (e.g., 'approved', 'rejected') or default to 'completed'
            status: data.status || 'completed',
            completedAt: new Date().toISOString(),
            // Merge the final output into state.data (handle empty/undefined output gracefully)
            data: {
              ...prev?.data,
              ...(data.output && typeof data.output === 'object' ? data.output : {})
            }
          }));
          eventSource.close();
          setConnected(false);
          // Refetch state after completion to ensure all data is loaded
          // (SSE event may have truncated data, server has the full state)
          setTimeout(() => fetchState(), 500);
          break;

        case 'workflow.failed':
          setState(prev => ({
            ...prev,
            status: 'failed',
            errors: [...(prev?.errors || []), data.error]
          }));
          eventSource.close();
          setConnected(false);
          break;

        case 'workflow.cancelled':
          setState(prev => ({
            ...prev,
            status: 'cancelled'
          }));
          eventSource.close();
          setConnected(false);
          break;

        case 'workflow.checkpoint.saved':
          // Checkpoint saved - this is informational, no state update needed
          // Could be used to show a toast notification in the future
          break;

        default:
          // Only log truly unhandled events, not expected internal events
          if (!eventType.startsWith('workflow.')) {
            console.log('Unhandled workflow event:', eventType, data);
          }
      }
    };

    // Register event handlers
    eventTypes.forEach(eventType => {
      eventSource.addEventListener(eventType, handleEvent);
    });

    eventSource.onerror = err => {
      console.error('Workflow SSE error:', err);
      setConnected(false);

      // Attempt reconnection after delay
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      reconnectTimeoutRef.current = setTimeout(() => {
        // Only reconnect if execution is still running/paused
        if (state?.status === 'running' || state?.status === 'paused') {
          console.log('Attempting SSE reconnection...');
          connectSSE();
        }
      }, 3000);
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [executionId, state?.status, featureFlags]);

  // Respond to human checkpoint
  const respondToCheckpoint = useCallback(
    async ({ checkpointId, response, data }) => {
      if (!executionId) return;

      // Don't respond if workflows feature is disabled
      if (!featureFlags.isEnabled('workflows', true)) {
        throw new Error('Workflows feature is disabled');
      }

      try {
        const result = await apiClient.post(`/workflows/executions/${executionId}/respond`, {
          checkpointId,
          response,
          data
        });

        // Update local state immediately
        setState(prev => ({
          ...prev,
          pendingCheckpoint: null,
          status: result.data.newStatus || 'running'
        }));

        return result.data;
      } catch (err) {
        console.error('Failed to respond to checkpoint:', err);
        throw err;
      }
    },
    [executionId, featureFlags]
  );

  // Cancel execution
  const cancelExecution = useCallback(
    async (reason = 'user_cancelled') => {
      if (!executionId) return;

      // Don't cancel if workflows feature is disabled
      if (!featureFlags.isEnabled('workflows', true)) {
        throw new Error('Workflows feature is disabled');
      }

      try {
        const result = await apiClient.post(`/workflows/executions/${executionId}/cancel`, {
          reason
        });

        setState(prev => ({
          ...prev,
          status: 'cancelled'
        }));

        return result.data;
      } catch (err) {
        console.error('Failed to cancel execution:', err);
        throw err;
      }
    },
    [executionId, featureFlags]
  );

  // Initial fetch
  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Connect SSE when execution is running or paused
  useEffect(() => {
    if (state && (state.status === 'running' || state.status === 'paused') && state.canReconnect) {
      connectSSE();
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [state?.status, state?.canReconnect, connectSSE]);

  return {
    state,
    loading,
    connected,
    error,
    respondToCheckpoint,
    cancelExecution,
    reconnect: connectSSE,
    refetch: fetchState
  };
}

export default useWorkflowExecution;
