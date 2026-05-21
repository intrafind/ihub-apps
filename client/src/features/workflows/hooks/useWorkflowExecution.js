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
function useWorkflowExecution(executionId, options = {}) {
  const {
    // Feature flag(s) required to enable fetching/streaming. Either a single
    // flag id (string) or an array of acceptable flag ids — any one being
    // enabled is sufficient. Defaults to the workflows feature.
    requireFeature = 'workflows',
    // Base path for the state endpoint (apiClient.get is relative to the API
    // root, so no leading `/api/`).
    stateEndpoint = 'workflows/executions',
    // Base path for the SSE stream endpoint (buildApiUrl prepends /api).
    streamEndpoint = 'workflows/executions',
    // Suffix for the respond (HITL) endpoint.
    respondEndpoint = 'respond',
    // Suffix for the cancel endpoint.
    cancelEndpoint = 'cancel'
  } = options;

  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  // Tracks whether the hook is still mounted. Used by the reconnect setTimeout
  // to bail out if the component unmounted while the timer was pending —
  // otherwise the reconnect creates a fresh EventSource that no cleanup path
  // will ever close (per-page-visit leak).
  const mountedRef = useRef(true);
  const featureFlags = useFeatureFlags();

  const requiredFeatures = Array.isArray(requireFeature) ? requireFeature : [requireFeature];
  const isFeatureEnabled = () => requiredFeatures.some(id => featureFlags.isEnabled(id, true));

  // Fetch initial execution state
  const fetchState = useCallback(async () => {
    if (!executionId) return;

    if (!isFeatureEnabled()) {
      setState(null);
      setLoading(false);
      setError(`Required feature(s) ${requiredFeatures.join(' or ')} disabled`);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(`/${stateEndpoint}/${executionId}`);
      setState(response.data);
    } catch (err) {
      console.error('Failed to fetch execution state:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load execution');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [executionId, featureFlags, stateEndpoint]);

  // Connect to SSE stream
  const connectSSE = useCallback(() => {
    if (!executionId) return;

    if (!isFeatureEnabled()) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const url = buildApiUrl(`${streamEndpoint}/${executionId}/stream`);
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
      'workflow.checkpoint.saved',
      'workflow.plan.created',
      'workflow.subworkflow.start',
      'workflow.subworkflow.complete',
      // Agent-specific events (only fire on agent runs, harmless otherwise)
      'agent.task.created',
      'agent.task.completed',
      'agent.task.failed',
      'agent.artifact.written',
      'agent.memory.read',
      'agent.memory.write',
      'agent.inbox.read',
      'agent.inbox.empty',
      'agent.inbox.write',
      'agent.inbox.marked_done',
      'agent.skill.activated',
      'agent.step.completed',
      'agent.tool.hallucinated',
      'agent.hitl.requested',
      'agent.hitl.approved',
      'agent.hitl.rejected'
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
          // Also push to history so the Steps table can derive
          // in_progress status from history events. Without this only
          // workflow.node.complete made it into history — and the UI
          // ended up with rows that flipped straight from open to done,
          // never showing in_progress.
          setState(prev => ({
            ...prev,
            currentNodes: data.nodeId ? [data.nodeId] : prev?.currentNodes || [],
            history: [
              ...(prev?.history || []),
              { event: eventType, nodeId: data.nodeId, at: new Date().toISOString() }
            ]
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
          eventSourceRef.current = null;
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
          eventSourceRef.current = null;
          setConnected(false);
          break;

        case 'workflow.cancelled':
          setState(prev => ({
            ...prev,
            status: 'cancelled'
          }));
          eventSource.close();
          eventSourceRef.current = null;
          setConnected(false);
          break;

        case 'workflow.checkpoint.saved':
          // Checkpoint saved - this is informational, no state update needed
          break;

        case 'workflow.plan.created':
          setState(prev => ({
            ...prev,
            data: {
              ...prev?.data,
              planCreated: data.plan
            }
          }));
          break;

        case 'workflow.subworkflow.start':
          setState(prev => ({
            ...prev,
            data: {
              ...prev?.data,
              subworkflows: {
                ...prev?.data?.subworkflows,
                [data.executionId]: {
                  status: 'running',
                  depth: data.depth,
                  taskCount: data.taskCount
                }
              }
            }
          }));
          break;

        case 'workflow.subworkflow.complete':
          setState(prev => ({
            ...prev,
            data: {
              ...prev?.data,
              subworkflows: {
                ...prev?.data?.subworkflows,
                [data.executionId]: {
                  ...prev?.data?.subworkflows?.[data.executionId],
                  status: 'completed',
                  completedAt: new Date().toISOString()
                }
              }
            }
          }));
          break;

        case 'agent.task.created':
          setState(prev => ({
            ...prev,
            data: {
              ...prev?.data,
              _taskQueue: [
                ...(prev?.data?._taskQueue || []),
                {
                  id: data.taskId,
                  title: data.title,
                  parentTaskId: data.parentTaskId || null,
                  depth: data.depth ?? 0,
                  status: 'open'
                }
              ]
            }
          }));
          break;

        case 'agent.task.completed':
        case 'agent.task.failed':
          setState(prev => {
            const next = {
              ...prev,
              data: {
                ...prev?.data,
                _taskQueue: (prev?.data?._taskQueue || []).map(t =>
                  t.id === data.taskId
                    ? { ...t, status: eventType === 'agent.task.failed' ? 'failed' : 'done' }
                    : t
                )
              }
            };
            // Mirror the timing into state.data._taskTimings so the step
            // timeline shows Started + Duration the moment the task ends,
            // without waiting for a refetch.
            if (eventType === 'agent.task.completed' && data.taskId && data.durationMs != null) {
              next.data._taskTimings = {
                ...(prev?.data?._taskTimings || {}),
                [data.taskId]: {
                  startedAt: data.startedAt,
                  completedAt: data.completedAt,
                  durationMs: data.durationMs
                }
              };
            }
            return next;
          });
          break;

        case 'agent.artifact.written':
          setState(prev => ({
            ...prev,
            data: {
              ...prev?.data,
              _agent: {
                ...(prev?.data?._agent || {}),
                artifacts: [
                  ...(prev?.data?._agent?.artifacts || []),
                  {
                    name: data.name || data.artifactName,
                    bytes: data.bytes,
                    at: new Date().toISOString()
                  }
                ]
              }
            }
          }));
          break;

        case 'agent.tool.hallucinated':
          setState(prev => ({
            ...prev,
            data: {
              ...prev?.data,
              _toolErrors: [
                ...(prev?.data?._toolErrors || []),
                {
                  ts: new Date().toISOString(),
                  requestedName: data.requestedName,
                  availableTools: data.availableTools,
                  reason: 'not_registered'
                }
              ]
            }
          }));
          break;

        case 'agent.inbox.read':
          // The deterministic inbox-load executor includes a `picked` field
          // with the item it injected into state. Mirror it into state.data
          // live so the UI's Inbox-item card pops in without waiting for a
          // full refetch. (The LLM read_inbox tool emits this event WITHOUT
          // `picked` — we just append to history in that case.)
          setState(prev => {
            const next = {
              ...prev,
              history: [
                ...(prev?.history || []),
                { event: eventType, ...data, at: new Date().toISOString() }
              ]
            };
            if (data?.picked && typeof data.picked === 'object') {
              next.data = {
                ...prev?.data,
                currentInboxItem: {
                  id: data.picked.line != null ? `line-${data.picked.line}` : null,
                  line: data.picked.line,
                  text: data.picked.text,
                  priority: data.picked.priority,
                  raw: data.picked.raw
                },
                _inboxMeta: {
                  ...(prev?.data?._inboxMeta || {}),
                  inboxId: data.inboxId
                }
              };
            }
            return next;
          });
          break;

        case 'agent.step.completed':
          // Live timing for orchestrator steps (planner LLM-only,
          // synthesizer, inbox-load, inbox-finalize). Merges into
          // state.data._taskTimings so the UI's Step timeline shows
          // Started + Duration before the run completes.
          if (data.nodeId && data.durationMs != null) {
            setState(prev => ({
              ...prev,
              data: {
                ...prev?.data,
                _taskTimings: {
                  ...(prev?.data?._taskTimings || {}),
                  [data.nodeId]: {
                    startedAt: data.startedAt,
                    completedAt: data.completedAt,
                    durationMs: data.durationMs
                  }
                }
              }
            }));
          }
          break;

        case 'agent.skill.activated':
          // Mirror the planner/tool-call activation into state so the run
          // detail page can render an "Activated skills" card live. We only
          // store metadata here — the body is server-side state.
          setState(prev => ({
            ...prev,
            history: [
              ...(prev?.history || []),
              { event: eventType, ...data, at: new Date().toISOString() }
            ],
            data: {
              ...prev?.data,
              _activatedSkills: {
                ...(prev?.data?._activatedSkills || {}),
                [data.skillName]: {
                  description: data.description || '',
                  activatedAt: new Date().toISOString(),
                  activatedBy: data.activatedBy || 'unknown'
                }
              }
            }
          }));
          break;

        case 'agent.inbox.marked_done':
          // The inbox-finalize executor marks the picked item done. Keep the
          // currentInboxItem visible in the UI but flag it as completed so
          // the operator sees the lifecycle close.
          setState(prev => ({
            ...prev,
            history: [
              ...(prev?.history || []),
              { event: eventType, ...data, at: new Date().toISOString() }
            ],
            data: {
              ...prev?.data,
              currentInboxItem: prev?.data?.currentInboxItem
                ? { ...prev.data.currentInboxItem, _markedDone: true }
                : prev?.data?.currentInboxItem
            }
          }));
          break;

        case 'agent.memory.read':
        case 'agent.memory.write':
        case 'agent.inbox.empty':
        case 'agent.inbox.write':
        case 'agent.hitl.requested':
        case 'agent.hitl.approved':
        case 'agent.hitl.rejected':
          // Append to history so the UI can show a chronological tape.
          setState(prev => ({
            ...prev,
            history: [
              ...(prev?.history || []),
              { event: eventType, ...data, at: new Date().toISOString() }
            ]
          }));
          break;

        default:
          // Only log truly unhandled events, not expected internal events
          if (!eventType.startsWith('workflow.') && !eventType.startsWith('agent.')) {
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
        // Bail out if the component unmounted while we were waiting — without
        // this guard, the reconnect creates a brand-new EventSource that no
        // cleanup function references, leaking the connection for the rest of
        // the page session.
        if (!mountedRef.current) return;
        // Only reconnect if execution is still running/paused
        if (state?.status === 'running' || state?.status === 'paused') {
          console.log('Attempting SSE reconnection...');
          connectSSE();
        }
      }, 3000);
    };
  }, [executionId, state?.status, featureFlags]);

  // Respond to human checkpoint
  const respondToCheckpoint = useCallback(
    async ({ checkpointId, response, data }) => {
      if (!executionId) return;

      if (!isFeatureEnabled()) {
        throw new Error(`Required feature(s) ${requiredFeatures.join(' or ')} disabled`);
      }

      try {
        const result = await apiClient.post(`/${stateEndpoint}/${executionId}/${respondEndpoint}`, {
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

      if (!isFeatureEnabled()) {
        throw new Error(`Required feature(s) ${requiredFeatures.join(' or ')} disabled`);
      }

      try {
        const result = await apiClient.post(`/${stateEndpoint}/${executionId}/${cancelEndpoint}`, {
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

  // Track mount status so the reconnect setTimeout in connectSSE can bail out
  // if the component has unmounted before its 3s timer fires.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
        reconnectTimeoutRef.current = null;
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
