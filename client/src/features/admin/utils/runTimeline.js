/**
 * Run-timeline derivation for the agent run detail page.
 *
 * This is the most complex and most frequently patched part of
 * AgentRunDetailPage: normalizing node-lifecycle events (which surface in a
 * live-SSE shape and a different persisted-API shape), detecting which
 * orchestrator nodes a workflow contains, counting retry/review rounds, and
 * assembling all of that into the single "unified tasks" list the page
 * renders. Extracted into a pure function so each heuristic can be covered
 * by fixture-based tests instead of "click through a live run and eyeball
 * it" — the inline comments below document several past regressions that
 * motivated the current behavior; keep them close to the logic they explain.
 */

import { aggregateTokenUsage } from './tokenStats.js';

/**
 * Derive the full step-by-step run timeline (planner/task/agent/orchestrator
 * rows) plus token-usage totals from a run's live or persisted state.
 *
 * @param {Object|null|undefined} run - the workflow execution state, as
 *   returned by useWorkflowExecution (either the live SSE shape or the
 *   persisted API shape)
 * @returns {{
 *   unifiedTasks: Array<Object>,
 *   tokenUsage: ReturnType<typeof aggregateTokenUsage>,
 *   stepLogs: Object,
 *   stepLogHistory: Object
 * }}
 */
export function deriveRunTimeline(run) {
  const dynamicTasks = run?.data?._taskQueue || [];
  // Planner-emitted plan (static tasks materialized into the sub-workflow).
  // planCreated.tasks is accumulated across review rounds server-side
  // (PlannerNodeExecutor._mergePlanTasks). Backstop for older runs — and any
  // case where planCreated lags the results — recover tasks that have a result
  // in _taskResults but are missing from planCreated.tasks, so a re-plan
  // round's prior tasks stay visible. _taskResults entries carry
  // { taskId, title, ... }; recovered tasks render as done (they're in
  // taskResultsMap) and are listed before the current plan to preserve order.
  const planCreatedTasks = run?.data?.planCreated?.tasks || [];
  const planCreatedTaskIds = new Set(planCreatedTasks.map(t => t.id));
  const recoveredPlanTasks = Object.values(run?.data?._taskResults || {})
    .filter(r => r && r.taskId && !planCreatedTaskIds.has(r.taskId))
    .map(r => ({
      id: r.taskId,
      title: r.title || r.taskId,
      description: r.title || '',
      _recoveredFromResults: true
    }));
  const planTasks = [...recoveredPlanTasks, ...planCreatedTasks];
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
        // A `start` is normally only set when the slot is empty. The
        // exception is the resume / retry case: when a node previously
        // ended in `failed` and the run was resumed, the engine fires
        // `node_start` again — we want the UI to reflect the new
        // in-flight attempt rather than the stale failure. We do NOT
        // override `done` (a completed node won't legitimately re-start
        // outside of cycles, and we don't want late SSE to flicker the
        // UI back to in-progress).
        const prev = map[h.nodeId];
        if (!prev || prev === 'failed') map[h.nodeId] = 'in_progress';
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
  // A review-loop in the workflow summary implies a planner+reviewer pair
  // inside its body (built by profileWorkflowSerializer.buildPlannerWorkflow).
  // Use that fact so the Planning row appears even when the planner LLM call
  // failed before producing any tasks — operators can then click the row
  // and see the persisted planner failure step log instead of wondering why
  // the timeline jumped straight from inbox-load to synthesize.
  const hasReviewLoopWrapper = wfSummaryNodes.some(
    n => n?.id === 'review-loop' && n?.type === 'loop'
  );
  const hasPlanner =
    wfSummaryNodes.some(n => n?.type === 'planner') ||
    hasReviewLoopWrapper ||
    taskStatusByNodeId.planner ||
    completedNodes.has('planner') ||
    !!run?.data?._stepLogs?.planner ||
    planTasks.length > 0;
  const hasSynthesizer =
    wfSummaryNodes.some(n => n?._isSynthesizer === true || n?.id === 'synthesize') ||
    taskStatusByNodeId.synthesize ||
    completedNodes.has('synthesize');
  // Plan-and-review loop: surface the reviewer's verdict as its own step so
  // operators can see if/why the loop closed (or replanned). The reviewer
  // node lives inside the loop body, so we detect it by step-log presence
  // or by the round counter being set — both only happen AFTER the reviewer
  // actually ran. Previously this row appeared the moment the workflow had
  // a review-loop in its summary, which made it show even before the
  // planner had produced any tasks (the planner runs first inside the body,
  // and only on success does the reviewer fire).
  const hasReviewer =
    completedNodes.has('reviewer') ||
    !!run?.data?._stepLogs?.reviewer ||
    typeof run?.data?._reviewRound === 'number';
  // Memory pipeline: composer (LLM decides what to remember) → finalize
  // (deterministic write). Both nodes have step logs that carry skip/write
  // decisions and write counts; we want each visible as its own row.
  const hasMemoryCompose =
    wfSummaryNodes.some(n => n?.id === 'memory-compose') ||
    completedNodes.has('memory-compose') ||
    !!run?.data?._stepLogs?.['memory-compose'];
  const hasMemoryFinalize =
    wfSummaryNodes.some(n => n?.type === 'memory-finalize' || n?.id === 'memory-finalize') ||
    completedNodes.has('memory-finalize') ||
    !!run?.data?._stepLogs?.['memory-finalize'];

  // How many times each node actually executed. In a cyclic workflow (the
  // adversarial agent → verify → retry → agent loop) the same node id runs
  // multiple times. Without surfacing this, the agent row looks like it
  // "completed" once while the run inexplicably keeps going — or, live, like
  // it completed several times over. We turn the count into an explicit
  // attempt/round badge so the retry loop is legible instead of confusing.
  const nodeIterations =
    run?.data?._nodeIterations && typeof run.data._nodeIterations === 'object'
      ? run.data._nodeIterations
      : {};
  // The adversarial verifier node (type 'verifier'). It drives the retry loop
  // but was never surfaced as its own step, so the loop was invisible.
  const hasVerifier = wfSummaryNodes.some(n => n?.type === 'verifier');

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
  // Full per-iteration history for a node (the agent / verifier re-run across
  // rounds). Falls back to the single latest transcript for nodes that run once
  // (inbox-load / finalize). Used to render every round, not just the last.
  const stepLogHistory = run?.data?._stepLogHistory || {};
  // Run-level token usage rolled up from every step's recorded tokens, for the
  // Token usage summary card. Pass the per-round history so multi-round nodes
  // (agent → verify → retry) count EVERY round, not just the latest snapshot
  // that _stepLogs holds. Per-step numbers also render in the steps table.
  const tokenUsage = aggregateTokenUsage(stepLogs, stepLogHistory);

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
  // isn't the synthesizer / memory-composer / reviewer is treated as an
  // agent step. Without the explicit exclusions, the memory-composer (a
  // prompt node by type) showed up as a duplicate "Running memory-compose"
  // row alongside its own orchestrator-kind "Composing memory" row.
  const NON_PRODUCER_PROMPT_IDS = new Set(['memory-compose', 'reviewer']);
  const primaryProducerNodes = wfSummaryNodes.filter(
    n =>
      n?._persistAsArtifact === true ||
      (n?.type === 'prompt' &&
        n?._isSynthesizer !== true &&
        n?.id !== 'synthesize' &&
        !NON_PRODUCER_PROMPT_IDS.has(n?.id) &&
        n?._isMemoryComposer !== true &&
        n?._isReviewer !== true)
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
      const runs = nodeIterations[n.id] || 1;
      const baseTitle = isDecomposer
        ? 'Planning sub-tasks'
        : isAgentNode
          ? 'Agent answering'
          : `Running ${n.id}`;
      const baseDescription = isDecomposer
        ? 'Analysing the request and queueing sub-tasks for the drain loop to execute'
        : 'Generating the answer for this run';
      return {
        key: `agent:${n.id}`,
        nodeId: n.id,
        kind: 'agent',
        // When the verifier sent the work back, this node ran more than once.
        // Make that explicit instead of letting repeated completions read as
        // the agent "finishing" several times.
        title: runs > 1 ? `${baseTitle} · attempt ${runs}` : baseTitle,
        description:
          runs > 1
            ? `${baseDescription} — revised ${runs - 1} time${runs - 1 === 1 ? '' : 's'} after adversarial review`
            : baseDescription,
        status: orchestratorStatus(n.id),
        timing: timingFor(n.id),
        log: logFor(n.id),
        depth: 0
      };
    }),
    // Dynamic tasks the agent created at runtime (set_plan / create_task) are
    // the breakdown of the agent's own work — it plans, then executes them, all
    // WITHIN the agent node, before the verifier runs. Render them nested
    // directly under "Agent answering" (and before the review) rather than
    // appended after it, which read as "answering happened before the tasks".
    ...dynamicTasks.map(t => ({
      key: `dyn:${t.id}`,
      nodeId: t.id,
      kind: 'dynamic',
      title: t.title,
      description: t.description || t.brief,
      status: t.status || 'open',
      timing: timingFor(t.id),
      log: logFor(t.id),
      depth: (t.depth ?? 0) + 1
    })),
    ...(hasVerifier
      ? (() => {
          const rounds = nodeIterations.verify || (run?.data?._verifier_retries_verify ?? 0) + 1;
          const vr = run?.data?.verificationResult;
          const verdict = typeof vr?.verdict === 'string' ? vr.verdict : null;
          // A forced verdict means the retry budget ran out. Post-fix that
          // fails the run, but older runs may still carry forced:true — call
          // it out either way so a green PASS isn't read as a clean pass.
          const description = verdict
            ? `${rounds} round${rounds === 1 ? '' : 's'} — verdict ${verdict}${vr?.forced ? ' (forced: retries exhausted)' : ''}`
            : 'Adversarially probing the deliverable for gaps before accepting it';
          return [
            {
              key: 'orch:verify',
              nodeId: 'verify',
              kind: 'orchestrator',
              title: rounds > 1 ? `Adversarial review · ${rounds} rounds` : 'Adversarial review',
              description,
              status: orchestratorStatus('verify'),
              timing: timingFor('verify'),
              log: logFor('verify'),
              depth: 0
            }
          ];
        })()
      : []),
    ...(hasReviewer
      ? (() => {
          const reviewerLog = logFor('reviewer');
          const loopLog = logFor('review-loop');
          const verdict =
            reviewerLog && typeof reviewerLog.output === 'string'
              ? (() => {
                  try {
                    return JSON.parse(reviewerLog.output);
                  } catch {
                    return null;
                  }
                })()
              : null;
          const rounds = Number.isFinite(run?.data?._reviewRound) ? run.data._reviewRound : null;
          const description = verdict
            ? verdict.needs_more_work
              ? `Round ${rounds || 1}: more work needed — ${(verdict.gaps || []).length} gap(s)`
              : `Round ${rounds || 1}: complete — no material gaps`
            : 'Judging whether the agent gathered enough evidence';
          return [
            {
              key: 'orch:reviewer',
              nodeId: 'reviewer',
              kind: 'orchestrator',
              title: 'Reviewing',
              description,
              status: orchestratorStatus('reviewer'),
              timing: timingFor('reviewer'),
              // Prefer the reviewer's own step log (with verdict output); fall
              // back to the loop log so the row at least shows iteration count.
              log: reviewerLog || loopLog,
              depth: 0
            }
          ];
        })()
      : []),
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
    ...(hasMemoryCompose
      ? (() => {
          const composeLog = logFor('memory-compose');
          const composerOut =
            composeLog && typeof composeLog.output === 'string'
              ? (() => {
                  try {
                    return JSON.parse(composeLog.output);
                  } catch {
                    return null;
                  }
                })()
              : null;
          const description = composerOut
            ? composerOut.skip
              ? `Composer chose to skip${composerOut.summary ? ` — ${composerOut.summary}` : ''}`
              : `Composer ${composerOut.mode || 'append'}${composerOut.summary ? ` — ${composerOut.summary}` : ''}`
            : 'Deciding what (if anything) to commit to long-term memory';
          return [
            {
              key: 'orch:memory-compose',
              nodeId: 'memory-compose',
              kind: 'orchestrator',
              title: 'Composing memory',
              description,
              status: orchestratorStatus('memory-compose'),
              timing: timingFor('memory-compose'),
              log: composeLog,
              depth: 0
            }
          ];
        })()
      : []),
    ...(hasMemoryFinalize
      ? (() => {
          const finalizeLog = logFor('memory-finalize');
          const written =
            finalizeLog && typeof finalizeLog.written === 'number' ? finalizeLog.written : null;
          const noopReason = finalizeLog?.noopReason;
          const composerSummary = finalizeLog?.composerSummary;
          let description;
          if (written === null) {
            description = 'Writing memory to the agent profile file';
          } else if (written === 0) {
            description = noopReason
              ? composerSummary
                ? `Skipped — ${noopReason} (${composerSummary})`
                : `Skipped — ${noopReason}`
              : 'Skipped — no pending memory updates';
          } else {
            description = `Wrote ${written} memory update${written === 1 ? '' : 's'}`;
          }
          return [
            {
              key: 'orch:memory-finalize',
              nodeId: 'memory-finalize',
              kind: 'orchestrator',
              title: written === 0 ? 'Memory skipped' : 'Memory written',
              description,
              status: orchestratorStatus('memory-finalize'),
              timing: timingFor('memory-finalize'),
              log: finalizeLog,
              depth: 0
            }
          ];
        })()
      : []),
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

  return { unifiedTasks, tokenUsage, stepLogs, stepLogHistory };
}
