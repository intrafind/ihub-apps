import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiClient } from '../../../api/client';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import useRunStream from '../../../shared/hooks/useRunStream';
import { RUN_EVENTS, getRuns } from '../../../shared/run/runReducer';
import { projectWorkflowState, isActiveWorkflowStatus } from '../workflowRunProjection';

/** Delay before reconnecting after the stream dropped while the execution is still active. */
const RECONNECT_DELAY_MS = 3000;
/** Delay before refetching the REST state after the root run completed (server has the full state). */
const REFETCH_AFTER_COMPLETE_MS = 500;

/**
 * Hook for managing a single workflow execution (or agent run).
 *
 * The live stream (`GET ${streamEndpoint}/:id/stream`, SSE v2) is consumed via
 * `useRunStream` and projected with `projectWorkflowState` onto the state
 * shape the pages read; the REST state (`GET ${stateEndpoint}/:id`) is the
 * base the live frames are layered on. Events of child runs (sub-workflow
 * executions) arriving on the same stream are folded into the same state.
 * Only fetches if the required feature flag(s) are enabled.
 *
 * @param {string} executionId - The workflow execution ID (root run id of the stream)
 * @param {Object} [options]
 * @param {string|string[]} [options.requireFeature='workflows'] - Feature flag id(s); any one enabled suffices
 * @param {string} [options.stateEndpoint='workflows/executions'] - REST base path (relative to the API root)
 * @param {string} [options.streamEndpoint='workflows/executions'] - Stream base path (buildApiUrl prepends /api)
 * @param {string} [options.respondEndpoint='respond'] - Suffix for the HITL respond endpoint
 * @param {string} [options.cancelEndpoint='cancel'] - Suffix for the cancel endpoint
 * @returns {Object} Execution state and methods
 * @property {Object|null} state - Current execution state (REST state + live projection)
 * @property {boolean} loading - Whether initial state is loading
 * @property {boolean} connected - Whether the stream is open
 * @property {string|null} error - Error message if any
 * @property {Function} respondToCheckpoint - Respond to a human checkpoint
 * @property {Function} cancelExecution - Cancel the execution
 * @property {Function} reconnect - Reconnect the stream
 * @property {Function} refetch - Refetch the REST state
 */
function useWorkflowExecution(executionId, options = {}) {
  const {
    requireFeature = 'workflows',
    stateEndpoint = 'workflows/executions',
    streamEndpoint = 'workflows/executions',
    respondEndpoint = 'respond',
    cancelEndpoint = 'cancel'
  } = options;

  const [baseState, setBaseState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reconnectTimeoutRef = useRef(null);
  // Tracks whether the hook is still mounted so the reconnect timer and the
  // post-completion refetch bail out after unmount.
  const mountedRef = useRef(true);
  const featureFlags = useFeatureFlags();

  const requiredFeatures = useMemo(
    () => (Array.isArray(requireFeature) ? requireFeature : [requireFeature]),
    [requireFeature]
  );
  const isFeatureEnabled = useCallback(
    () => requiredFeatures.some(id => featureFlags.isEnabled(id, true)),
    [requiredFeatures, featureFlags]
  );
  const featureDisabledMessage = () =>
    `Required feature(s) ${requiredFeatures.join(' or ')} disabled`;

  // Latest values for callbacks that must not re-create the stream.
  const fetchStateRef = useRef(null);
  const connectRef = useRef(null);
  const statusRef = useRef(null);
  const streamStateRef = useRef(null);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      // Bail out if the component unmounted while we were waiting.
      if (!mountedRef.current) return;
      // Only reconnect if the execution is still running/paused
      if (isActiveWorkflowStatus(statusRef.current)) {
        console.log('Attempting SSE reconnection...');
        connectRef.current?.();
      }
    }, RECONNECT_DELAY_MS);
  }, []);

  const handleRunEnd = useCallback(envelope => {
    // Refetch state after completion to ensure all data is loaded (the stream
    // payload may be truncated; the server has the full state).
    if (envelope?.data?.status === 'completed') {
      setTimeout(() => {
        if (mountedRef.current) fetchStateRef.current?.();
      }, REFETCH_AFTER_COMPLETE_MS);
    }
  }, []);

  const handleStreamError = useCallback(
    err => {
      console.error('Workflow SSE error:', err);
      scheduleReconnect();
    },
    [scheduleReconnect]
  );

  const {
    state: streamState,
    connect,
    disconnect,
    reset,
    push,
    connected
  } = useRunStream({
    closeOnRunEnd: true,
    onRunEnd: handleRunEnd,
    onError: handleStreamError,
    onClose: scheduleReconnect
  });
  streamStateRef.current = streamState;

  const state = useMemo(
    () => (baseState ? projectWorkflowState(streamState, executionId, baseState) : null),
    [streamState, baseState, executionId]
  );
  statusRef.current = state?.status ?? null;

  // Fetch the REST execution state. The response is authoritative: the live
  // accumulation is dropped (the legacy hook replaced the whole state on fetch)
  // and later frames layer on top of the fresh base.
  const fetchState = useCallback(async () => {
    if (!executionId) return;

    if (!isFeatureEnabled()) {
      setBaseState(null);
      setLoading(false);
      setError(featureDisabledMessage());
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(`/${stateEndpoint}/${executionId}`);
      if (!mountedRef.current) return;
      setBaseState(response.data);
      reset({ keepConnection: true, keepSeq: true });
    } catch (err) {
      console.error('Failed to fetch execution state:', err);
      if (mountedRef.current) {
        setError(err.response?.data?.error || err.message || 'Failed to load execution');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [executionId, stateEndpoint, isFeatureEnabled, reset]);
  fetchStateRef.current = fetchState;

  // Open the SSE v2 stream (root run = executionId).
  const connectSSE = useCallback(() => {
    if (!executionId) return;
    if (!isFeatureEnabled()) return;
    connect(buildApiUrl(`${streamEndpoint}/${executionId}/stream`), {
      streamId: executionId,
      rootRunId: executionId
    });
  }, [executionId, streamEndpoint, isFeatureEnabled, connect]);
  connectRef.current = connectSSE;

  // Respond to human checkpoint
  const respondToCheckpoint = useCallback(
    async ({ checkpointId, response, data }) => {
      if (!executionId) return;

      if (!isFeatureEnabled()) {
        throw new Error(featureDisabledMessage());
      }

      try {
        const result = await apiClient.post(`/${stateEndpoint}/${executionId}/${respondEndpoint}`, {
          checkpointId,
          response,
          data
        });

        // Optimistic local update until the server's interaction/answered +
        // run/resumed frames arrive: answer the interaction (checkpoint id ===
        // interaction id) on the run that raised it.
        const now = new Date().toISOString();
        const owner =
          getRuns(streamStateRef.current).find(r => r.interactions?.[checkpointId]) || null;
        const ownerRunId = owner?.runId || executionId;
        push({
          v: 2,
          runId: ownerRunId,
          ts: now,
          type: RUN_EVENTS.INTERACTION_ANSWERED,
          data: {
            interactionId: checkpointId,
            kind: owner?.interactions?.[checkpointId]?.kind || 'approval',
            answer: {
              value: response,
              ...(data ? { data } : {}),
              by: 'user',
              at: now,
              channel: 'run_page'
            }
          }
        });
        const newStatus = result.data?.newStatus || 'running';
        if (newStatus === 'running') {
          push({
            v: 2,
            runId: ownerRunId,
            ts: now,
            type: RUN_EVENTS.RUN_RESUMED,
            data: { interactionId: checkpointId }
          });
        }
        setBaseState(prev =>
          prev ? { ...prev, pendingCheckpoint: null, status: newStatus } : prev
        );

        return result.data;
      } catch (err) {
        console.error('Failed to respond to checkpoint:', err);
        throw err;
      }
    },
    // eslint-disable-next-line @eslint-react/exhaustive-deps
    [executionId, stateEndpoint, respondEndpoint, isFeatureEnabled, push]
  );

  // Cancel execution
  const cancelExecution = useCallback(
    async (reason = 'user_cancelled') => {
      if (!executionId) return;

      if (!isFeatureEnabled()) {
        throw new Error(featureDisabledMessage());
      }

      try {
        const result = await apiClient.post(`/${stateEndpoint}/${executionId}/${cancelEndpoint}`, {
          reason
        });

        // Optimistic: mark the root run cancelled; the server's run/ended confirms.
        const now = new Date().toISOString();
        push({
          v: 2,
          runId: executionId,
          ts: now,
          type: RUN_EVENTS.RUN_ENDED,
          data: { status: 'aborted', finishReason: 'cancelled' }
        });
        setBaseState(prev => (prev ? { ...prev, status: 'cancelled' } : prev));

        return result.data;
      } catch (err) {
        console.error('Failed to cancel execution:', err);
        throw err;
      }
    },
    // eslint-disable-next-line @eslint-react/exhaustive-deps
    [executionId, stateEndpoint, cancelEndpoint, isFeatureEnabled, push]
  );

  // Initial fetch
  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Track mount status so timers can bail out after unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, []);

  // Stream while the execution is running or paused (one connection across
  // pause/resume; closed once the execution reaches a terminal status).
  const shouldStream = !!state && isActiveWorkflowStatus(state.status) && !!state.canReconnect;
  useEffect(() => {
    if (shouldStream) {
      connectSSE();
    }

    return () => {
      disconnect();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [shouldStream, connectSSE, disconnect]);

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
