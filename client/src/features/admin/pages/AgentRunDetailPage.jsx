import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import useWorkflowExecution from '../../workflows/hooks/useWorkflowExecution';
import { approveAgentRun, cancelAgentRun, fetchRunArtifacts } from '../../../api/agentsAdminApi';

const AGENT_EXECUTION_OPTIONS = {
  requireFeature: ['agentFactory', 'workflows'],
  stateEndpoint: 'agents/runs',
  streamEndpoint: 'agents/runs'
};

export default function AgentRunDetailPage() {
  const navigate = useNavigate();
  const { runId } = useParams();
  const {
    state: run,
    loading,
    connected,
    error,
    refetch
  } = useWorkflowExecution(runId, AGENT_EXECUTION_OPTIONS);

  const [artifacts, setArtifacts] = useState([]);
  const [artifactsError, setArtifactsError] = useState(null);

  // Artifacts list is its own endpoint; refresh whenever the SSE indicates a
  // new one was written (we re-fetch on state changes that touch artifacts).
  useEffect(() => {
    let mounted = true;
    fetchRunArtifacts(runId)
      .then(res => {
        if (!mounted) return;
        setArtifacts(res?.data || []);
      })
      .catch(err => {
        if (mounted) setArtifactsError(err.message);
      });
    return () => {
      mounted = false;
    };
  }, [runId, run?.data?._agent?.artifacts?.length, run?.status]);

  async function handleCancel() {
    if (!window.confirm('Cancel this run?')) return;
    try {
      await cancelAgentRun(runId, 'user_cancelled');
      refetch();
    } catch (err) {
      alert(err?.response?.data?.message || err.message);
    }
  }

  async function handleApprove(response) {
    const checkpoint = run?.pendingCheckpoint || run?.data?.pendingCheckpoint;
    if (!checkpoint) return;
    try {
      await approveAgentRun(runId, { checkpointId: checkpoint.id, response });
      refetch();
    } catch (err) {
      alert(err?.response?.data?.message || err.message);
    }
  }

  if (loading && !run) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="p-8">Loading…</div>
      </AdminAuth>
    );
  }

  const status = run?.status;
  const profileId =
    run?.data?._agent?.profileId || (run?.data?._workflow?.startedBy || '').replace(/^agent:/, '');
  const dynamicTasks = run?.data?._taskQueue || [];
  // Planner-emitted plan (static tasks materialized into the sub-workflow).
  const planTasks = run?.data?.planCreated?.tasks || [];
  // Sub-workflow node lifecycle, used to derive live status for planner tasks.
  // Each task node fires workflow.node.start / .complete events with its own
  // nodeId — and that nodeId matches the planner task id (SubWorkflowMaterializer
  // uses `task.id || task-${index}`).
  const subWorkflowState = (() => {
    const subworkflows = run?.data?.subworkflows || {};
    const ids = Object.keys(subworkflows);
    if (ids.length === 0) return null;
    // For V1 there's only one planner sub-workflow at a time.
    return subworkflows[ids[ids.length - 1]] || null;
  })();
  // Build a single unified tasks list. Planner tasks first (with their plan
  // metadata + live status derived from history), then dynamic tasks
  // (from create_task) — both displayed the same way per user feedback:
  // "planned and dynamic are the same. both are added at runtime."
  const taskHistory = (run?.history || []).filter(
    h =>
      typeof h.nodeId === 'string' &&
      (h.event === 'workflow.node.start' ||
        h.event === 'workflow.node.complete' ||
        h.event === 'workflow.node.error')
  );
  const taskStatusByNodeId = (() => {
    const map = {};
    for (const h of taskHistory) {
      if (h.event === 'workflow.node.start') map[h.nodeId] = 'in_progress';
      else if (h.event === 'workflow.node.complete') map[h.nodeId] = 'done';
      else if (h.event === 'workflow.node.error') map[h.nodeId] = 'failed';
    }
    return map;
  })();
  const unifiedTasks = [
    ...planTasks.map((t, i) => ({
      key: `plan:${t.id || i}`,
      kind: 'planner',
      title: t.title,
      description: t.description,
      status: taskStatusByNodeId[t.id || `task-${i}`] || 'open',
      depth: 0
    })),
    ...dynamicTasks.map(t => ({
      key: `dyn:${t.id}`,
      kind: 'dynamic',
      title: t.title,
      description: t.description || t.brief,
      status: t.status || 'open',
      depth: t.depth ?? 0
    }))
  ];
  const isPaused = status === 'paused';
  const pendingCheckpoint = run?.pendingCheckpoint || run?.data?.pendingCheckpoint;
  const toolErrors = run?.data?._toolErrors || [];
  const history = run?.history || [];
  const isInFlight = status === 'running' || status === 'paused';
  const currentTaskId = run?.data?._currentTask?.id;
  // Artifacts: prefer disk listing (real file metadata), fall back to
  // state.data._agent.artifacts (event-driven, available before disk fetch
  // completes or when disk endpoint hasn't populated yet).
  const stateArtifacts = run?.data?._agent?.artifacts || [];
  const displayArtifacts = artifacts.length > 0 ? artifacts : stateArtifacts;

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-6xl mx-auto py-8 px-4">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h1 className="text-2xl font-bold">Run {runId}</h1>
              <p className="text-sm text-gray-600 font-mono">{profileId}</p>
              <div className="flex items-center gap-2 mt-2 text-xs">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    connected
                      ? 'bg-green-500 animate-pulse'
                      : isInFlight
                        ? 'bg-yellow-500'
                        : 'bg-gray-400'
                  }`}
                />
                <span className="text-gray-700">
                  {connected ? 'Live' : isInFlight ? 'Reconnecting…' : 'Disconnected'}
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigate(-1)}
                className="px-3 py-2 border bg-white rounded text-sm"
              >
                Back
              </button>
              {status === 'running' && (
                <button
                  onClick={handleCancel}
                  className="px-3 py-2 bg-red-600 text-white rounded text-sm"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}
          {artifactsError && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              Artifacts: {artifactsError}
            </div>
          )}

          {isPaused && pendingCheckpoint && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-300 rounded">
              <h2 className="font-semibold text-yellow-900 mb-2">⏸ Awaiting approval</h2>
              <p className="text-sm text-yellow-800 mb-3">{pendingCheckpoint.message}</p>
              <div className="flex gap-2">
                {(
                  pendingCheckpoint.options || [
                    { value: 'approve', label: 'Approve' },
                    { value: 'reject', label: 'Reject' }
                  ]
                ).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => handleApprove(opt.value)}
                    className={`px-3 py-2 text-sm rounded ${
                      opt.value === 'approve' || opt.style === 'primary'
                        ? 'bg-green-600 text-white'
                        : opt.style === 'danger' || opt.value === 'reject'
                          ? 'bg-red-600 text-white'
                          : 'bg-gray-200 text-gray-800'
                    }`}
                  >
                    {opt.label || opt.value}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-4">
              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Status</h2>
                <div className="text-sm">
                  <div>
                    Status: <span className="font-mono">{status}</span>
                  </div>
                  <div>
                    Current nodes:{' '}
                    <span className="font-mono">{(run?.currentNodes || []).join(', ') || '—'}</span>
                  </div>
                  <div>
                    Completed:{' '}
                    <span className="font-mono">{(run?.completedNodes || []).length}</span>
                  </div>
                </div>
              </div>

              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Tasks ({unifiedTasks.length})</h2>
                {unifiedTasks.length === 0 ? (
                  <p className="text-sm text-gray-500">No tasks yet.</p>
                ) : (
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 uppercase">
                        <th className="text-left py-1">Title</th>
                        <th className="text-left py-1">Source</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-left py-1">Depth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unifiedTasks.map(t => {
                        const isCurrent =
                          t.kind === 'dynamic' && currentTaskId && t.key === `dyn:${currentTaskId}`;
                        const statusColor =
                          t.status === 'done'
                            ? 'text-green-700'
                            : t.status === 'failed'
                              ? 'text-red-700'
                              : t.status === 'in_progress'
                                ? 'text-blue-700'
                                : 'text-gray-600';
                        return (
                          <tr
                            key={t.key}
                            className={`border-t align-top ${isCurrent ? 'bg-indigo-50' : ''}`}
                          >
                            <td className="py-2">
                              {(isCurrent || t.status === 'in_progress') && (
                                <span className="inline-block w-2 h-2 rounded-full bg-indigo-500 mr-2 animate-pulse" />
                              )}
                              <span className="font-medium">{t.title}</span>
                              {t.description && (
                                <div className="text-xs text-gray-500 mt-0.5">
                                  {t.description.length > 200
                                    ? `${t.description.slice(0, 200)}…`
                                    : t.description}
                                </div>
                              )}
                            </td>
                            <td className="py-2 text-xs">
                              <span
                                className={`px-2 py-0.5 rounded ${
                                  t.kind === 'planner'
                                    ? 'bg-purple-100 text-purple-800'
                                    : 'bg-orange-100 text-orange-800'
                                }`}
                              >
                                {t.kind}
                              </span>
                            </td>
                            <td className={`py-2 ${statusColor}`}>{t.status}</td>
                            <td className="py-2">{t.depth ?? 0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {run?.data?.planCreated?.reasoning && (
                  <p className="mt-3 text-xs text-gray-500 italic">
                    Planner reasoning: {run.data.planCreated.reasoning}
                  </p>
                )}
              </div>

              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Artifacts ({displayArtifacts.length})</h2>
                {displayArtifacts.length === 0 ? (
                  <p className="text-sm text-gray-500">No artifacts produced.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {displayArtifacts.map((a, i) => (
                      <li key={`${a.name}-${i}`}>
                        <a
                          href={`/api/agents/runs/${runId}/artifacts/${a.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 hover:underline"
                        >
                          {a.name}
                        </a>
                        {typeof a.bytes === 'number' && (
                          <span className="text-xs text-gray-500 ml-2">{a.bytes} bytes</span>
                        )}
                        {a.writtenAt && (
                          <span className="text-xs text-gray-400 ml-2">
                            {new Date(a.writtenAt).toLocaleTimeString()}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {toolErrors.length > 0 && (
                <div className="bg-white border rounded p-4">
                  <h2 className="font-semibold mb-2 text-amber-800">
                    Tool issues ({toolErrors.length})
                  </h2>
                  <p className="text-xs text-gray-500 mb-2">
                    The agent attempted to call tools it does not have access to. Each attempt was
                    returned to the model as a tool-error so it can self-correct.
                  </p>
                  <ul className="text-xs space-y-2">
                    {toolErrors.slice(-10).map((e, i) => (
                      <li key={i} className="border-l-2 border-amber-300 pl-2">
                        <div>
                          <span className="font-mono">{e.requestedName}</span>
                        </div>
                        <div className="text-gray-500">
                          available: {(e.availableTools || []).join(', ') || '(none)'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {history.length > 0 && (
                <div className="bg-white border rounded p-4">
                  <h2 className="font-semibold mb-2">Recent events</h2>
                  <ul className="text-xs space-y-1 max-h-64 overflow-y-auto">
                    {history
                      .slice(-30)
                      .reverse()
                      .map((h, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-gray-400 font-mono">
                            {(h.timestamp || h.at || '').toString().slice(11, 19)}
                          </span>
                          <span className="font-mono">{h.event || h.type || 'node.complete'}</span>
                          {h.nodeId && <span className="text-gray-600">[{h.nodeId}]</span>}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>

            <div>
              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Metadata</h2>
                <pre className="text-xs overflow-x-auto">
                  {JSON.stringify(run?.data?._agent || {}, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
}
