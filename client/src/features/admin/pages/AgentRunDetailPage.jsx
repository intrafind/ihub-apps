import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ArtifactViewer from '../components/ArtifactViewer';
import ArtifactDownloadMenu from '../components/ArtifactDownloadMenu';
import StepDetails from '../components/StepDetails';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useWorkflowExecution from '../../workflows/hooks/useWorkflowExecution';
import { approveAgentRun, cancelAgentRun, fetchRunArtifacts } from '../../../api/agentsAdminApi';

const AGENT_EXECUTION_OPTIONS = {
  requireFeature: ['agentFactory', 'workflows'],
  stateEndpoint: 'agents/runs',
  streamEndpoint: 'agents/runs'
};

export default function AgentRunDetailPage() {
  const { t } = useTranslation();
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
  // Local error banner state for action failures (cancel/approve).
  const [actionError, setActionError] = useState(null);
  // Controls the cancel-run confirmation dialog.
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  // Live-updating clock for the run progress indicator (only ticks while running).
  const [now, setNow] = useState(Date.now());
  // ArtifactViewer modal target: null when closed, artifact name when open.
  const [viewingArtifact, setViewingArtifact] = useState(null);
  // Long ledgers — start collapsed past N entries.
  const [citationsExpanded, setCitationsExpanded] = useState(false);
  const CITATIONS_VISIBLE = 5;
  // Per-step transcript expansion state: Set of nodeIds currently expanded.
  const [expandedSteps, setExpandedSteps] = useState(() => new Set());
  function toggleStep(nodeId) {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

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

  // Tick the local clock once a second while the run is in flight so the
  // progress indicator's elapsed time stays current without depending on
  // backend updates.
  useEffect(() => {
    if (run?.status !== 'running' || !run?.startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [run?.status, run?.startedAt]);

  async function confirmCancel() {
    setConfirmCancelOpen(false);
    setActionError(null);
    try {
      await cancelAgentRun(runId, 'user_cancelled');
      refetch();
    } catch (err) {
      setActionError(err?.response?.data?.message || err.message);
    }
  }

  async function handleApprove(response) {
    const checkpoint = run?.pendingCheckpoint || run?.data?.pendingCheckpoint;
    if (!checkpoint) return;
    setActionError(null);
    try {
      await approveAgentRun(runId, { checkpointId: checkpoint.id, response });
      refetch();
    } catch (err) {
      setActionError(err?.response?.data?.message || err.message);
    }
  }

  if (loading && !run) {
    return <div className="p-8 text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading…')}</div>;
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
  // Node lifecycle events surface in two shapes depending on whether the
  // run state came over SSE (live) or via the API after a refresh:
  //   - Live (SSE): { event: 'workflow.node.start' | 'workflow.node.complete' | 'workflow.node.error', nodeId, ... }
  //   - Persisted (API): { type: 'node_start' | 'node_complete' | 'node_error', nodeId, ... }
  // Accept both so post-refresh statuses stay accurate.
  const NODE_START_KEYS = new Set(['workflow.node.start', 'node_start']);
  const NODE_COMPLETE_KEYS = new Set(['workflow.node.complete', 'node_complete']);
  const NODE_ERROR_KEYS = new Set(['workflow.node.error', 'node_error']);
  function eventKind(h) {
    const key = h?.event || h?.type;
    if (!key) return null;
    if (NODE_START_KEYS.has(key)) return 'start';
    if (NODE_COMPLETE_KEYS.has(key)) return 'complete';
    if (NODE_ERROR_KEYS.has(key)) return 'error';
    return null;
  }
  const taskHistory = (run?.history || []).filter(
    h => typeof h.nodeId === 'string' && eventKind(h) !== null
  );
  const taskStatusByNodeId = (() => {
    const map = {};
    for (const h of taskHistory) {
      const kind = eventKind(h);
      if (kind === 'start') {
        // Don't downgrade a 'done' or 'failed' from a later event.
        if (!map[h.nodeId]) map[h.nodeId] = 'in_progress';
      } else if (kind === 'complete') {
        map[h.nodeId] = 'done';
      } else if (kind === 'error') {
        map[h.nodeId] = 'failed';
      }
    }
    return map;
  })();
  // The bubble-up from child sub-workflows populates state.data._taskResults
  // keyed by task id. That's the authoritative "this task finished" signal
  // — it survives page refresh (history events from SSE do not, because
  // persisted history uses `type` not `event`). Treat any task with an
  // entry in _taskResults as done. Live SSE events still win for
  // in-progress / failed because they fire before the result is persisted.
  const taskResultsMap = run?.data?._taskResults || {};
  const completedNodes = new Set(run?.completedNodes || []);

  // Derive status for the orchestration steps (planner, synthesize) that
  // are NOT in the plan but are still real work the user waits on.
  //
  // We deliberately do NOT fall back to `run.currentNodes`. The engine
  // can list a node in currentNodes when it's been QUEUED but hasn't
  // actually started — which made the synth row flash "in_progress"
  // immediately after the planner finished even while the sub-workflow
  // was still running. Trust only the explicit start/complete history
  // events (plus completedNodes for post-refresh resilience).
  function orchestratorStatus(nodeId) {
    if (taskStatusByNodeId[nodeId]) return taskStatusByNodeId[nodeId];
    if (completedNodes.has(nodeId)) return 'done';
    return 'open';
  }
  // Once the planner has emitted its plan (workflow.plan.created event,
  // mirrored to state.data.planCreated), the "Planning" phase is done —
  // the rest of the planner node's wall-clock is spent waiting on the
  // sub-workflow's task executors, which surface as their own rows. We
  // don't want "Planning" stuck at in_progress for the entire run.
  const plannerStatus =
    Array.isArray(run?.data?.planCreated?.tasks) && run.data.planCreated.tasks.length > 0
      ? 'done'
      : orchestratorStatus('planner');
  const synthesizerStatus = orchestratorStatus('synthesize');

  // Detect which orchestrator nodes the workflow CONTAINS — drive this
  // off the workflow summary the engine persists at start time. That
  // gives stable orchestrator-row visibility across all run phases.
  // Previously we inferred from runtime state (history / completedNodes /
  // currentNodes), which made the synth row vanish between
  // planner-complete and synth-start.
  const wfSummaryNodes = Array.isArray(run?.data?._workflowSummary?.nodes)
    ? run.data._workflowSummary.nodes
    : [];
  const hasPlanner =
    wfSummaryNodes.some(n => n?.type === 'planner') ||
    taskStatusByNodeId.planner ||
    completedNodes.has('planner') ||
    planTasks.length > 0;
  const hasSynthesizer =
    wfSummaryNodes.some(n => n?._isSynthesizer === true || n?.id === 'synthesize') ||
    taskStatusByNodeId.synthesize ||
    completedNodes.has('synthesize');

  // Per-step timings populated by every executor (planner records its LLM
  // call only, NOT the sub-workflow wait; planner-tasks bubble up from the
  // child; inbox-load/finalize record directly). Map keyed by node id.
  const taskTimings = run?.data?._taskTimings || {};
  function timingFor(nodeId) {
    return taskTimings[nodeId] || null;
  }
  // Per-step transcripts: model, prompts, tools, tool calls, tokens. Used
  // by the expandable detail panel under each step row so operators can
  // audit exactly what the agent saw and did at each step.
  const stepLogs = run?.data?._stepLogs || {};
  function logFor(nodeId) {
    return stepLogs[nodeId] || null;
  }

  // Inbox load / finalize are deterministic runtime steps that produce
  // step logs (which tools they called, what they read / wrote). Surface
  // them so operators get full transparency, not just the LLM steps.
  const hasInboxLoad = wfSummaryNodes.some(n => n?.type === 'inbox-load');
  const hasInboxFinalize = wfSummaryNodes.some(n => n?.type === 'inbox-finalize');
  // Primary-producer prompt nodes: simple-agent / inbox-worker-without-synth
  // mark their answer-producing prompt node with `_persistAsArtifact: true`.
  // Surface those nodes so the operator sees what the agent actually did,
  // even when there's no planner to materialize tasks. Fall back to type-
  // based detection for runs whose summary was written before the
  // `_persistAsArtifact` marker existed — any top-level prompt node that
  // isn't the synthesizer is treated as an agent step.
  const primaryProducerNodes = wfSummaryNodes.filter(
    n =>
      n?._persistAsArtifact === true ||
      (n?.type === 'prompt' && n?._isSynthesizer !== true && n?.id !== 'synthesize')
  );
  // When a drain loop is present, the agent prompt node is a DECOMPOSER —
  // its job is to enqueue sub-tasks via create_task, not produce the final
  // answer directly. Distinguish this from the simple-agent shape so the
  // UI label matches what's actually happening on this step.
  const hasDrain = wfSummaryNodes.some(n => n?.type === 'loop' && n?.id === 'drain');

  const unifiedTasks = [
    ...(hasInboxLoad
      ? [
          {
            key: 'orch:inbox-load',
            nodeId: 'inbox-load',
            kind: 'orchestrator',
            title: 'Reading inbox',
            description: 'Picking the highest-priority open inbox item',
            status: orchestratorStatus('inbox-load'),
            timing: timingFor('inbox-load'),
            log: logFor('inbox-load'),
            depth: 0
          }
        ]
      : []),
    ...(hasPlanner
      ? [
          {
            key: 'orch:planner',
            nodeId: 'planner',
            kind: 'orchestrator',
            title: 'Planning',
            description: 'Decomposing the brief into sub-tasks',
            status: plannerStatus,
            timing: timingFor('planner'),
            log: logFor('planner'),
            depth: 0
          }
        ]
      : []),
    ...planTasks.map((t, i) => {
      const taskId = t.id || `task-${i}`;
      let s = taskStatusByNodeId[taskId];
      if (!s && taskResultsMap[taskId]) s = 'done';
      return {
        key: `plan:${taskId}`,
        nodeId: taskId,
        kind: 'planner',
        title: t.title,
        description: t.description,
        status: s || 'open',
        timing: timingFor(taskId),
        log: logFor(taskId),
        depth: 0
      };
    }),
    ...primaryProducerNodes.map(n => {
      const isAgentNode = n.id === 'agent';
      // Agent in a drain workflow = planner / decomposer; agent in a
      // simple-agent or inbox-worker-without-drain = direct answerer.
      const isDecomposer = isAgentNode && hasDrain;
      return {
        key: `agent:${n.id}`,
        nodeId: n.id,
        kind: 'agent',
        title: isDecomposer
          ? 'Planning sub-tasks'
          : isAgentNode
            ? 'Agent answering'
            : `Running ${n.id}`,
        description: isDecomposer
          ? 'Analysing the request and queueing sub-tasks for the drain loop to execute'
          : 'Generating the answer for this run',
        status: orchestratorStatus(n.id),
        timing: timingFor(n.id),
        log: logFor(n.id),
        depth: 0
      };
    }),
    ...(hasSynthesizer
      ? [
          {
            key: 'orch:synthesize',
            nodeId: 'synthesize',
            kind: 'orchestrator',
            title: 'Composing final report',
            description: 'Synthesizing all sub-task results into the final artifact',
            status: synthesizerStatus,
            timing: timingFor('synthesize'),
            log: logFor('synthesize'),
            depth: 0
          }
        ]
      : []),
    ...dynamicTasks.map(t => ({
      key: `dyn:${t.id}`,
      nodeId: t.id,
      kind: 'dynamic',
      title: t.title,
      description: t.description || t.brief,
      status: t.status || 'open',
      timing: timingFor(t.id),
      log: logFor(t.id),
      depth: t.depth ?? 0
    })),
    ...(hasInboxFinalize
      ? [
          {
            key: 'orch:inbox-finalize',
            nodeId: 'inbox-finalize',
            kind: 'orchestrator',
            title: 'Marking inbox item done',
            description: 'Writing the completion note back to the inbox file',
            status: orchestratorStatus('inbox-finalize'),
            timing: timingFor('inbox-finalize'),
            log: logFor('inbox-finalize'),
            depth: 0
          }
        ]
      : [])
  ];
  const isPaused = status === 'paused';
  const pendingCheckpoint = run?.pendingCheckpoint || run?.data?.pendingCheckpoint;
  const toolErrors = run?.data?._toolErrors || [];
  const isInFlight = status === 'running' || status === 'paused';
  const isFailed = status === 'failed';
  const runErrors = Array.isArray(run?.errors) ? run.errors : [];
  // Child sub-workflow executions (one per planner / nested decomposition).
  // The runs detail endpoint serves them too, so we deep-link straight to
  // the child run page — operators can drill in to see the per-task LLM
  // history without leaving the agents area.
  const childExecutionIds = Array.isArray(run?.data?._childExecutionIds)
    ? run.data._childExecutionIds
    : [];
  // Inbox item the deterministic inbox-load node picked at the start of
  // the run. Surfaced live via the `agent.inbox.read` SSE event (mirrored
  // into state.data.currentInboxItem by the workflow execution hook).
  const currentInboxItem = run?.data?.currentInboxItem || null;
  const inboxMeta = run?.data?._inboxMeta || null;
  // Skills activated during this run (either by the planner pre-activation
  // or by an LLM calling the activate_skill tool mid-run). Each entry
  // carries description + when + who activated it. The body is server-side
  // only — the UI shows the metadata so operators can see what knowledge
  // shaped the run.
  const activatedSkills = run?.data?._activatedSkills || {};
  const activatedSkillNames = Object.keys(activatedSkills);
  // Citations ledger: URLs the agent actually consulted during research,
  // captured from tool-call results in PromptNodeExecutor and bubbled up
  // from child sub-workflows. Each entry has { url, title?, snippet?,
  // toolId, query?, capturedAt }.
  //
  // Naming: `_citations` (NOT `_sources`) so it doesn't shadow
  // `profile.sources`, which is the catalog of configured knowledge bases
  // the agent CAN look up via `source_*` tools. Citations are the run-time
  // record of what the agent actually visited.
  const runCitations = Array.isArray(run?.data?._citations) ? run.data._citations : [];
  const dedupedCitations = (() => {
    const seen = new Set();
    const out = [];
    for (const c of runCitations) {
      if (!c || typeof c.url !== 'string' || seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
    return out;
  })();

  // LLM-generated run title (populated by titleGenerator soon after the
  // run starts). Falls back to the inbox item text → brief → "Agent run".
  // The raw inbox text can be a multi-sentence paragraph; truncate so the
  // header stays one line until the LLM title arrives.
  function shortFallback(s) {
    if (typeof s !== 'string') return '';
    const trimmed = s.replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    if (trimmed.length <= 60) return trimmed;
    // Prefer a sentence boundary near the cut point.
    const cut = trimmed.slice(0, 60);
    const lastDot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    if (lastDot > 20) return cut.slice(0, lastDot + 1);
    return `${cut.replace(/\s+\S*$/, '')}…`;
  }
  const runTitle =
    (typeof run?.data?._title === 'string' && run.data._title.trim()) ||
    shortFallback(currentInboxItem?.text) ||
    shortFallback(run?.data?.brief) ||
    'Agent run';

  // Who triggered this run and how. Sourced from state.data._agent which the
  // route pre-initialises with profileId + triggeredBy.
  const triggeredBy = run?.data?._agent?.triggeredBy || null;

  // Total run time. Live runs tick on every refetch / SSE update. We
  // compute from explicit timestamps rather than summing per-node
  // durations because the planner's per-node duration is misleading (it
  // includes the sub-workflow wait); the run-level startedAt → completedAt
  // gives a true wall-clock figure.
  const totalDurationMs = (() => {
    const start = run?.startedAt ? new Date(run.startedAt).getTime() : null;
    if (!start) return null;
    const end = run?.completedAt
      ? new Date(run.completedAt).getTime()
      : isInFlight
        ? Date.now()
        : null;
    if (!end) return null;
    return end - start;
  })();
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  function formatTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleTimeString();
    } catch {
      return '—';
    }
  }
  const currentTaskId = run?.data?._currentTask?.id;
  // Artifacts: prefer disk listing (real file metadata), fall back to
  // state.data._agent.artifacts (event-driven, available before disk fetch
  // completes or when disk endpoint hasn't populated yet). Dedupe by
  // name+writtenAt so any legacy shared-reference profiles or transient
  // double-bubble-ups don't produce duplicate rows.
  const stateArtifacts = run?.data?._agent?.artifacts || [];
  const rawArtifacts = artifacts.length > 0 ? artifacts : stateArtifacts;

  // Run-level progress indicator: "{done}/{total} tasks · {elapsed}".
  // Surfaced only when there's either a populated task queue or a recorded
  // start time, so completed runs still show wall-clock and runs that never
  // got a task queue (inbox-empty) just hide the line.
  const progressTaskQueue = Array.isArray(run?.data?._taskQueue) ? run.data._taskQueue : [];
  const progressTotal = progressTaskQueue.length;
  const progressDone = progressTaskQueue.filter(tk => tk.status === 'done').length;
  const progressStartedAt = run?.startedAt ? new Date(run.startedAt).getTime() : null;
  const progressEndTs = run?.completedAt
    ? new Date(run.completedAt).getTime()
    : isInFlight
      ? now
      : null;
  const progressElapsedMs =
    progressStartedAt && progressEndTs ? progressEndTs - progressStartedAt : null;
  const showProgress = progressTotal > 0 || !!progressStartedAt;
  const displayArtifacts = (() => {
    const seen = new Set();
    const out = [];
    for (const a of rawArtifacts) {
      if (!a || !a.name) continue;
      const key = `${a.name}|${a.writtenAt || ''}|${a.bytes || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  })();

  return (
    <>
      <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
        <div className="max-w-6xl mx-auto py-8 px-4">
          <div className="flex justify-between items-start mb-6 gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{runTitle}</h1>
              {showProgress && (
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1" aria-live="polite">
                  {t('admin.agents.runs.progress', '{{done}}/{{total}} tasks · {{elapsed}}', {
                    done: progressDone,
                    total: progressTotal,
                    elapsed: formatDuration(progressElapsedMs)
                  })}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="font-mono">{profileId}</span>
                <span className="text-gray-300 dark:text-gray-600">·</span>
                <span className="font-mono text-gray-400 dark:text-gray-500" title={runId}>
                  {runId.length > 18 ? `${runId.slice(0, 18)}…` : runId}
                </span>
                {triggeredBy?.userId && (
                  <>
                    <span className="text-gray-300 dark:text-gray-600">·</span>
                    <span>
                      triggered by{' '}
                      <span className="font-medium text-gray-800 dark:text-gray-200">{triggeredBy.userId}</span>
                      {triggeredBy.kind && (
                        <span className="ml-1 text-gray-500 dark:text-gray-400">({triggeredBy.kind})</span>
                      )}
                    </span>
                  </>
                )}
                {typeof totalDurationMs === 'number' && (
                  <>
                    <span className="text-gray-300 dark:text-gray-600">·</span>
                    <span>
                      total{' '}
                      <span className="font-medium text-gray-800 dark:text-gray-200">
                        {formatDuration(totalDurationMs)}
                      </span>
                    </span>
                  </>
                )}
                <span className="text-gray-300 dark:text-gray-600">·</span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${
                      connected
                        ? 'bg-green-500 animate-pulse'
                        : isInFlight
                          ? 'bg-yellow-500'
                          : 'bg-gray-400'
                    }`}
                  />
                  {connected ? 'Live' : isInFlight ? 'Reconnecting…' : 'Disconnected'}
                </span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => navigate(-1)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Back
              </button>
              {status === 'running' && (
                <button
                  onClick={() => setConfirmCancelOpen(true)}
                  className="px-3 py-2 bg-red-600 text-white rounded text-sm"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
              {error}
            </div>
          )}
          {actionError && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
              {actionError}
            </div>
          )}
          {artifactsError && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
              {t('admin.agents.runs.artifactsErrorPrefix', 'Artifacts: {{message}}', {
                message: artifactsError
              })}
            </div>
          )}

          {run?.data?._inboxEmpty === true && (
            <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">No work to do.</span> The inbox was empty when this run
              started, so the planner and synthesizer were skipped. The next trigger will pick up
              new items.
            </div>
          )}

          {isFailed && runErrors.length > 0 && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded">
              <h2 className="font-semibold text-red-900 dark:text-red-300 mb-2">
                Run failed ({runErrors.length} error{runErrors.length === 1 ? '' : 's'})
              </h2>
              <ul className="text-sm text-red-800 dark:text-red-300 space-y-3">
                {runErrors.map((err, i) => (
                  <li
                    key={`${err.nodeId || 'err'}-${err.timestamp || i}`}
                    className="border-l-2 border-red-400 dark:border-red-600 pl-3"
                  >
                    {err.nodeId && (
                      <div className="text-xs text-red-700 dark:text-red-400 font-mono mb-0.5">
                        node: {err.nodeId}
                        {err.code && <span className="ml-2 text-red-600 dark:text-red-400">[{err.code}]</span>}
                      </div>
                    )}
                    <div>{err.message}</div>
                    {err.timestamp && (
                      <div className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                        {new Date(err.timestamp).toLocaleString()}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isPaused && pendingCheckpoint && (
            <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded">
              <h2 className="font-semibold text-yellow-900 dark:text-yellow-300 mb-2">⏸ Awaiting approval</h2>
              <p className="text-sm text-yellow-800 dark:text-yellow-300 mb-3">{pendingCheckpoint.message}</p>
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
                    className={`px-3 py-2 text-sm rounded transition-colors ${
                      opt.value === 'approve' || opt.style === 'primary'
                        ? 'bg-green-600 hover:bg-green-700 text-white'
                        : opt.style === 'danger' || opt.value === 'reject'
                          ? 'bg-red-600 hover:bg-red-700 text-white'
                          : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200'
                    }`}
                  >
                    {opt.label || opt.value}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-6">
            <div className="space-y-4">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <h2 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">Status</h2>
                <div className="text-sm text-gray-700 dark:text-gray-300">
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

              {currentInboxItem && (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h2 className="font-semibold mb-2 flex items-center gap-2 text-gray-900 dark:text-gray-100">
                    Inbox item
                    {currentInboxItem._markedDone && (
                      <span className="text-xs font-normal px-2 py-0.5 bg-green-100 text-green-800 rounded">
                        marked done
                      </span>
                    )}
                  </h2>
                  <div className="flex items-start gap-3">
                    {currentInboxItem.priority && (
                      <span
                        className={`text-xs font-mono px-2 py-0.5 rounded ${
                          currentInboxItem.priority === 'p1'
                            ? 'bg-red-100 text-red-800'
                            : currentInboxItem.priority === 'p2'
                              ? 'bg-yellow-100 text-yellow-800'
                              : currentInboxItem.priority === 'p3'
                                ? 'bg-gray-100 text-gray-800'
                                : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {currentInboxItem.priority.toUpperCase()}
                      </span>
                    )}
                    <p className="text-sm text-gray-900 dark:text-gray-100 flex-1">{currentInboxItem.text}</p>
                  </div>
                  {(inboxMeta?.inboxId || currentInboxItem.line != null) && (
                    <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 font-mono">
                      {inboxMeta?.inboxId && <span>inbox: {inboxMeta.inboxId}</span>}
                      {inboxMeta?.inboxId && currentInboxItem.line != null && (
                        <span className="mx-1">·</span>
                      )}
                      {currentInboxItem.line != null && <span>line {currentInboxItem.line}</span>}
                    </div>
                  )}
                </div>
              )}

              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <h2 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">Steps ({unifiedTasks.length})</h2>
                {unifiedTasks.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No steps yet.</p>
                ) : (
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                        <th className="text-left py-1 w-6"></th>
                        <th className="text-left py-1">Step</th>
                        <th className="text-left py-1">Source</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-left py-1 whitespace-nowrap">Started</th>
                        <th className="text-left py-1 whitespace-nowrap">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unifiedTasks.map(t => {
                        const isCurrent =
                          t.kind === 'dynamic' && currentTaskId && t.key === `dyn:${currentTaskId}`;
                        const statusColor =
                          t.status === 'done'
                            ? 'text-green-700 dark:text-green-400'
                            : t.status === 'failed'
                              ? 'text-red-700 dark:text-red-400'
                              : t.status === 'in_progress'
                                ? 'text-blue-700 dark:text-blue-400'
                                : 'text-gray-600 dark:text-gray-400';
                        const isExpanded = expandedSteps.has(t.nodeId);
                        const hasDetails = !!t.log;
                        return (
                          <Fragment key={t.key}>
                            <tr
                              className={`border-t border-gray-100 dark:border-gray-700 align-top ${isCurrent ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''} ${
                                hasDetails ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50' : ''
                              }`}
                              onClick={hasDetails ? () => toggleStep(t.nodeId) : undefined}
                            >
                              <td className="py-2 pr-1 text-xs text-gray-400 dark:text-gray-500 select-none">
                                {hasDetails ? (isExpanded ? '▾' : '▸') : ''}
                              </td>
                              <td className="py-2 pr-3">
                                {(isCurrent || t.status === 'in_progress') && (
                                  <span className="inline-block w-2 h-2 rounded-full bg-indigo-500 mr-2 animate-pulse" />
                                )}
                                <span className="font-medium">{t.title}</span>
                                {t.description && (
                                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                    {t.description.length > 200
                                      ? `${t.description.slice(0, 200)}…`
                                      : t.description}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-xs">
                                <span
                                  className={`px-2 py-0.5 rounded ${
                                    t.kind === 'planner'
                                      ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300'
                                      : t.kind === 'orchestrator'
                                        ? 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                                        : t.kind === 'agent'
                                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300'
                                          : 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300'
                                  }`}
                                >
                                  {t.kind}
                                </span>
                              </td>
                              <td className={`py-2 pr-3 ${statusColor}`}>{t.status}</td>
                              <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                                {t.timing?.startedAt ? formatTime(t.timing.startedAt) : '—'}
                              </td>
                              <td className="py-2 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
                                {typeof t.timing?.durationMs === 'number'
                                  ? formatDuration(t.timing.durationMs)
                                  : '—'}
                              </td>
                            </tr>
                            {hasDetails && isExpanded && (
                              <tr className="bg-gray-50/50 dark:bg-gray-700/30">
                                <td colSpan={6} className="px-0 pt-0 pb-2">
                                  <StepDetails log={t.log} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {run?.data?.planCreated?.reasoning && (
                  <p className="mt-3 text-xs text-gray-500 dark:text-gray-400 italic">
                    Planner reasoning: {run.data.planCreated.reasoning}
                  </p>
                )}
              </div>

              {/* Artifacts come first under Tasks — the report is the
                  primary deliverable, citations are supporting evidence. */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <h2 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">Artifacts ({displayArtifacts.length})</h2>
                {displayArtifacts.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No artifacts produced.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {displayArtifacts.map((a, i) => (
                      <li key={`${a.name}-${i}`} className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setViewingArtifact(a.name)}
                          className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
                          title="Open viewer"
                        >
                          {a.name}
                        </button>
                        <ArtifactDownloadMenu
                          runId={runId}
                          name={a.name}
                          size="sm"
                          onError={err =>
                            setActionError(
                              t(
                                'admin.agents.runs.downloadFailed',
                                'Download failed: {{message}}',
                                {
                                  message: err.message
                                }
                              )
                            )
                          }
                        />
                        {typeof a.bytes === 'number' && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">{a.bytes} bytes</span>
                        )}
                        {a.writtenAt && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {new Date(a.writtenAt).toLocaleTimeString()}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {dedupedCitations.length > 0 && (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h2 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">Citations ({dedupedCitations.length})</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    URLs the agent actually consulted during this run, captured from every search /
                    extract tool call. The synthesizer cites these by number in the final report.
                    Distinct from the profile's configured knowledge-base sources — citations are
                    what was visited, sources are what could be queried.
                  </p>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    {(citationsExpanded
                      ? dedupedCitations
                      : dedupedCitations.slice(0, CITATIONS_VISIBLE)
                    ).map(c => (
                      <li key={c.url} className="text-gray-800 dark:text-gray-200">
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 dark:text-indigo-400 hover:underline break-all"
                        >
                          {c.title || c.url}
                        </a>
                        {c.title && (
                          <span className="text-xs text-gray-400 dark:text-gray-500 ml-2 break-all">{c.url}</span>
                        )}
                        {c.toolId && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                            ({c.toolId}
                            {c.query ? `: "${c.query}"` : ''})
                          </span>
                        )}
                        {c.snippet && (
                          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 ml-5">
                            {String(c.snippet).slice(0, 240)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                  {dedupedCitations.length > CITATIONS_VISIBLE && (
                    <button
                      type="button"
                      onClick={() => setCitationsExpanded(v => !v)}
                      className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      {citationsExpanded
                        ? `Show less`
                        : `Show all ${dedupedCitations.length} citations`}
                    </button>
                  )}
                </div>
              )}

              {activatedSkillNames.length > 0 && (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h2 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">
                    Activated skills ({activatedSkillNames.length})
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Skills loaded into the agent's context during this run. The full SKILL.md body
                    of each activated skill is folded into the system prompt of every subsequent
                    prompt node.
                  </p>
                  <ul className="text-sm space-y-2">
                    {activatedSkillNames.map(name => {
                      const skill = activatedSkills[name] || {};
                      return (
                        <li key={name} className="border-l-2 border-indigo-300 dark:border-indigo-600 pl-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{name}</span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${
                                skill.activatedBy === 'planner'
                                  ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300'
                                  : skill.activatedBy === 'llm'
                                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300'
                                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {skill.activatedBy || 'unknown'}
                            </span>
                            {skill.activatedAt && (
                              <span className="text-xs text-gray-400 dark:text-gray-500">
                                {new Date(skill.activatedAt).toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                          {skill.description && (
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{skill.description}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {childExecutionIds.length > 0 && (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h2 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">Child runs ({childExecutionIds.length})</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Sub-workflow executions spawned by this run (one per planner decomposition).
                    Open one to see its per-task LLM history.
                  </p>
                  <ul className="text-sm space-y-1">
                    {childExecutionIds.map(childId => (
                      <li key={childId}>
                        <a
                          href={`/admin/agents/runs/${childId}`}
                          className="text-indigo-600 dark:text-indigo-400 hover:underline font-mono text-xs"
                        >
                          {childId}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {toolErrors.length > 0 && (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h2 className="font-semibold mb-2 text-amber-800 dark:text-amber-400">
                    Tool issues ({toolErrors.length})
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    The agent attempted to call tools it does not have access to. Each attempt was
                    returned to the model as a tool-error so it can self-correct.
                  </p>
                  <ul className="text-xs space-y-2">
                    {toolErrors.slice(-10).map((e, i) => (
                      <li key={i} className="border-l-2 border-amber-300 dark:border-amber-600 pl-2">
                        <div>
                          <span className="font-mono text-gray-800 dark:text-gray-200">{e.requestedName}</span>
                        </div>
                        <div className="text-gray-500 dark:text-gray-400">
                          available: {(e.availableTools || []).join(', ') || '(none)'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {viewingArtifact && (
        <ArtifactViewer
          runId={runId}
          name={viewingArtifact}
          onClose={() => setViewingArtifact(null)}
        />
      )}
      <ConfirmDialog
        isOpen={confirmCancelOpen}
        danger
        title={t('admin.agents.runs.cancelTitle', 'Cancel run')}
        message={t(
          'admin.agents.runs.cancelMessage',
          "Cancel this run? In-flight LLM calls won't be billed for completed turns."
        )}
        confirmLabel={t('admin.agents.runs.confirmCancel', 'Cancel run')}
        denyLabel={t('admin.agents.runs.keepRunning', 'Keep running')}
        onConfirm={confirmCancel}
        onDeny={() => setConfirmCancelOpen(false)}
      />
    </>
  );
}
