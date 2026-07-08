/**
 * Agent run lifecycle routes:
 *   POST /api/agents/profiles/:id/runs        — manual trigger
 *   GET  /api/agents/runs                     — list agent runs
 *   GET  /api/agents/runs/:runId              — single run state
 *   POST /api/agents/runs/:runId/cancel       — cancel a running run
 *   POST /api/agents/runs/:runId/approve      — HITL approval
 *   GET  /api/agents/approvals                — cross-profile pending queue
 */

import { authRequired, authenticatedOnly } from '../../middleware/authRequired.js';
import {
  sendBadRequest,
  sendNotFound,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import { WorkflowEngine, getExecutionRegistry } from '../../services/workflow/index.js';
import { buildAgentPrincipal } from '../../utils/authorization.js';
import { serializeProfile } from '../../agents/profile/profileWorkflowSerializer.js';
import { resolveReviewSettings } from '../../agents/profile/reviewSettings.js';
import { generateRunTitleAsync } from '../../agents/runtime/titleGenerator.js';
import { HumanNodeExecutor } from '../../services/workflow/executors/HumanNodeExecutor.js';
import { actionTracker } from '../../actionTracker.js';
import { createSseChannel, startInactiveClientSweep } from '../../utils/sseChannel.js';
import logger from '../../utils/logger.js';

// Lazy-shared engine. WorkflowEngine state lives in StateManager (filesystem),
// so multiple instances see the same executions; we use one per-worker.
// 30-minute default node timeout: the phased planner node blocks while its
// entire sub-workflow runs (up to 6 tasks × several minutes each), so the
// 5-minute DEFAULT_NODE_TIMEOUT would kill it mid-run. 30 min matches
// MAX_NODE_TIMEOUT in WorkflowEngine and is the ceiling _normalizeTimeout allows.
let _engine = null;
function getEngine() {
  if (!_engine) _engine = new WorkflowEngine({ defaultTimeout: 30 * 60 * 1000 });
  return _engine;
}

function lookupProfile(profileId) {
  const { data: profiles = [] } = configCache.getAgentProfiles(true);
  return profiles.find(p => p.id === profileId) || null;
}

/**
 * Apply a profile's per-step model overrides onto the resolved workflow.
 * `nodeModels` maps node id → model id; each match sets that node's
 * `config.modelId`, which the executors honor first (above the run-wide
 * default). Mutates and returns the workflow. No-op when nodeModels is empty.
 *
 * @param {Object} workflow
 * @param {Object<string,string>} [nodeModels]
 * @returns {Object} the same workflow
 */
export function applyNodeModels(workflow, nodeModels) {
  if (!workflow || !Array.isArray(workflow.nodes) || !nodeModels) return workflow;
  for (const node of workflow.nodes) {
    if (node && typeof node.id === 'string' && nodeModels[node.id]) {
      node.config = { ...(node.config || {}), modelId: nodeModels[node.id] };
    }
  }
  return workflow;
}

/**
 * Inject resolved review knobs onto every verifier node's config. Mirrors
 * applyNodeModels: external workflows ignore profile flags, so the run-start
 * code wires per-node config. Mutates and returns the workflow.
 * @param {Object} workflow
 * @param {Object} resolved - from resolveReviewSettings()
 */
export function applyReviewSettings(workflow, resolved) {
  if (!workflow || !Array.isArray(workflow.nodes) || !resolved) return workflow;
  for (const node of workflow.nodes) {
    if (node?.type !== 'verifier') continue;
    node.config = {
      ...(node.config || {}),
      maxRetries: resolved.maxRetries,
      stallLimit: resolved.stallLimit,
      acceptPartial: resolved.acceptPartial,
      acceptPartialAfterStall: resolved.acceptPartialAfterStall,
      requirePass: resolved.requirePass,
      ...(resolved.criteria ? { criteria: resolved.criteria } : {})
    };
  }
  return workflow;
}

function countRunningProfileRuns(profileId) {
  try {
    const registry = getExecutionRegistry();
    const all = registry.getAll ? registry.getAll() : [];
    return all.filter(
      r => r?.userId === `agent:${profileId}` && ['running', 'pending', 'paused'].includes(r.status)
    ).length;
  } catch {
    return 0;
  }
}

function isAdminUser(user) {
  if (!user) return false;
  if (user.permissions?.adminAccess === true) return true;
  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.includes('admin') || groups.includes('admins');
}

/**
 * Authorize the requesting user against a specific agent run. The run was
 * triggered by a specific human (recorded in
 * `state.data._agent.triggeredBy.userId`); only that user — or an
 * administrator — should be able to read its state, stream its events, or
 * download its artifacts. Anyone else gets 403 even though anonymous auth
 * may be globally enabled for chat.
 *
 * Returns true when access is allowed. When denied, the response has
 * already been sent (404 if the run doesn't exist, 403 otherwise) and the
 * caller must return immediately.
 */
async function authorizeRunAccess(req, res, runId) {
  if (isAdminUser(req.user)) return true;
  try {
    const state = await getEngine().getState(runId);
    if (!state) {
      sendNotFound(res, `Run ${runId} not found`);
      return false;
    }
    const triggeredByUserId = state.data?._agent?.triggeredBy?.userId;
    const requestingUserId = req.user?.id;
    if (
      triggeredByUserId &&
      requestingUserId &&
      requestingUserId !== 'anonymous' &&
      triggeredByUserId === requestingUserId
    ) {
      return true;
    }
    res.status(403).json({
      error: 'forbidden',
      message: 'You are not allowed to access this run.'
    });
    return false;
  } catch (err) {
    logger.warn('Run authorization check failed', {
      component: 'AgentRuns',
      runId,
      error: err.message
    });
    res.status(403).json({
      error: 'forbidden',
      message: 'Authorization check failed.'
    });
    return false;
  }
}

export default function registerAgentRunRoutes(app) {
  // ── Manual trigger ────────────────────────────────────────────────────────
  app.post(
    buildServerPath('/api/agents/profiles/:profileId/runs'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;

        const profile = lookupProfile(profileId);
        if (!profile) return sendNotFound(res, `Profile ${profileId} not found`);
        if (profile.enabled === false) {
          return sendBadRequest(res, `Profile ${profileId} is disabled`);
        }

        // Concurrency guard
        const maxConcurrent = profile.concurrency?.maxConcurrent ?? 1;
        const running = countRunningProfileRuns(profileId);
        if (running >= maxConcurrent) {
          return res.status(409).json({
            error: 'CONCURRENCY_LIMIT',
            message: `Profile ${profileId} already has ${running} running run(s); limit is ${maxConcurrent}`,
            runningRuns: running
          });
        }

        const { brief, variables } = req.body || {};
        const serialized = serializeProfile(profile);

        // Resolve workflow: either the profile's embedded definition or a
        // reference to a hand-authored workflow in contents/workflows/.
        // External refs let authors wire complex workflows (e.g.
        // iterative-research-auto) to an agent profile without having to
        // inline the whole definition into the profile file.
        let workflow;
        if (
          serialized.workflow?.ref === 'external' &&
          typeof serialized.workflow.workflowId === 'string'
        ) {
          const wf = configCache.getWorkflowById(serialized.workflow.workflowId);
          if (!wf) {
            return sendBadRequest(
              res,
              `External workflow ${serialized.workflow.workflowId} not found`
            );
          }
          workflow = JSON.parse(JSON.stringify(wf));
        } else {
          workflow = serialized.workflow.definition || {};
        }
        workflow.id = workflow.id || `agent:${profileId}`;

        const principal = buildAgentPrincipal(profile, {
          userId: req.user?.id || 'anonymous',
          kind: 'manual'
        });

        // Pre-populate the brief from (in priority order):
        //   1. operator-supplied brief in the POST body
        //   2. for inbox-bound profiles: empty — the runtime reads the inbox
        //      item from disk and the agent / planner prompts reference
        //      {{currentInboxItem}} directly. Forcing a brief here previously
        //      defaulted to profile.system, which made the system prompt end
        //      up as the user message and starved the agent of its actual
        //      question.
        //   3. for non-inbox profiles: a generic fallback so the planner /
        //      simple-agent prompt isn't empty.
        let resolvedBrief = brief && brief.trim().length > 0 ? brief : '';
        if (!resolvedBrief && !profile.inboxId) {
          resolvedBrief = `You are agent ${profileId}. Plan and execute the work this agent is configured for.`;
        }

        const initialData = {
          brief: resolvedBrief,
          variables: variables || {},
          _agent: {
            profileId,
            triggeredBy: { userId: req.user?.id || 'anonymous', kind: 'manual' },
            artifacts: []
          },
          // DURABLE model config for the whole run. `applyNodeModels` and
          // `workflow.config.defaultModelId` mutate the shared cached workflow
          // object, which the config cache's TTL refresh later discards —
          // dropping every node back to the global default (local-vllm). Stash
          // the agent's configured model in run state (which survives the
          // refresh) so resolvers always land on the configured model. Copied
          // into child sub-workflows automatically (see PlannerNodeExecutor's
          // childInitial copy), so planner sub-tasks inherit it too.
          _agentModelConfig: {
            defaultModelId: profile.preferredModel || null,
            nodeModels: profile.nodeModels || {}
          },
          // DURABLE review config — stashed in run state so it survives workflow
          // config-cache refreshes and is available to all verifier nodes throughout
          // the run (including in child sub-workflows via PlannerNodeExecutor copy).
          _agentReviewConfig: resolveReviewSettings(profile.review),
          // Pre-initialize mutable state slots so they're shared by reference
          // between any state-snapshot that an in-flight async caller (e.g.
          // the fire-and-forget title generator) may have captured before
          // an inner mutation. Without this, the first `create_task` /
          // citation-capture / skill-activation on a brand-new run creates
          // the slot on the OLD orphaned data object and the mutation
          // never reaches the live activeStates entry.
          _taskQueue: [],
          _citations: [],
          _activatedSkills: {},
          _stepLogs: {},
          _taskTimings: {}
        };

        // Calculate wall-time deadline via workflow config. Also publish the
        // profile's preferred model as the run's workflow-level default so EVERY
        // LLM node inherits it (the prompt/agent node via getModel step 3, and
        // the verifier via the same defaultModelId) — without this, an EXTERNAL
        // workflow's nodes fall back to the global default model and the
        // operator has no single place to set the run's model. A node may still
        // override per-node with its own `config.modelId`.
        const maxWallTimeSec = profile.budgets?.maxWallTimeSec ?? 600;
        workflow.config = {
          ...(workflow.config || {}),
          maxExecutionTime: maxWallTimeSec * 1000,
          ...(profile.preferredModel ? { defaultModelId: profile.preferredModel } : {})
        };
        // Per-step model overrides (profile.nodeModels) win over the run-wide
        // default for the listed nodes.
        applyNodeModels(workflow, profile.nodeModels);
        // Inject resolved review knobs onto every verifier node so EXTERNAL
        // workflows (which don't reference profile flags directly) pick up the
        // operator's strictness / retry / acceptance configuration.
        applyReviewSettings(workflow, initialData._agentReviewConfig);

        // Persist a checkpoint after every node completes. Agent runs are
        // long-lived (each task is a multi-minute LLM call) and otherwise
        // exist only in-memory until the run reaches a terminal state.
        // Without per-node checkpoints, a server restart mid-run loses the
        // plan, task results, and progress — the UI then shows "no run
        // found" even though the artifacts on disk indicate work happened.
        // The state-file write is a deepMerge-after-update; cost is
        // dominated by the LLM call time, so the I/O is negligible.
        const state = await getEngine().start(workflow, initialData, {
          user: principal,
          checkpointOnNode: true
        });

        // Register the run in the ExecutionRegistry so the /api/agents/runs
        // listing (and per-profile filter) actually finds it. Without this
        // the registry only knows about runs started via workflowRoutes /
        // workflowRunner — agent runs are invisible to GET /api/agents/runs
        // and the "Runs" tab on the profile page comes up empty.
        //
        // userId follows the agent principal convention `agent:<profileId>`
        // so the route's filter `r.userId === \`agent:${profileId}\`` matches.
        try {
          const registry = getExecutionRegistry();
          registry.register(state.executionId, {
            userId: principal.id, // `agent:${profileId}`
            workflowId: workflow.id || `agent:${profileId}`,
            workflowName: workflow.name || profile.name || profileId,
            status: state.status,
            startedAt: state.createdAt || state.startedAt || new Date().toISOString(),
            source: 'agent',
            inputPreview:
              typeof resolvedBrief === 'string' ? resolvedBrief.slice(0, 240) : undefined,
            models: profile.preferredModel ? [profile.preferredModel] : undefined,
            // Carry the human who triggered the run so per-user filtering
            // on the list endpoint doesn't need a separate state read.
            triggeredBy: { userId: req.user?.id || 'anonymous', kind: 'manual' }
          });
        } catch (regErr) {
          logger.warn('Failed to register agent run in ExecutionRegistry', {
            component: 'AgentRuns',
            profileId,
            executionId: state.executionId,
            error: regErr.message
          });
        }

        // Fire-and-forget LLM title generation. Runs in background; never
        // blocks the trigger response. Title appears in the UI header once
        // the LLM call returns (typically <2s).
        try {
          let inboxTextHint;
          if (profile.inboxId) {
            try {
              const { default: inboxStore } = await import('../../agents/inbox/inboxStore.js');
              const inbox = await inboxStore.readInbox(profile.inboxId, { status: 'open' });
              const top = (inbox.items || []).find(i => i.status === 'open');
              if (top) inboxTextHint = top.text;
            } catch {
              // Title generator will fall back to the brief.
            }
          }
          generateRunTitleAsync({
            executionId: state.executionId,
            brief: resolvedBrief,
            inboxText: inboxTextHint,
            preferredModelId: profile.preferredModel,
            language: req.user?.language || 'en'
          });
        } catch (titleErr) {
          logger.warn('Failed to kick off title generation', {
            component: 'AgentRuns',
            executionId: state.executionId,
            error: titleErr.message
          });
        }

        logger.info('Started agent run', {
          component: 'AgentRuns',
          profileId,
          executionId: state.executionId,
          actor: req.user?.id
        });
        res.status(202).json({
          ok: true,
          executionId: state.executionId,
          status: state.status,
          profileId
        });
      } catch (error) {
        sendFailedOperationError(res, 'start agent run', error);
      }
    }
  );

  // ── List runs ─────────────────────────────────────────────────────────────
  app.get(
    buildServerPath('/api/agents/runs'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const registry = getExecutionRegistry();
        const all = registry.getAll ? registry.getAll() : [];
        const { profileId, status } = req.query;
        let runs = all.filter(r => {
          if (typeof r?.userId !== 'string' || !r.userId.startsWith('agent:')) return false;
          // Children inherit userId from the parent — the only reliable way
          // to distinguish a parent agent run from a planner-spawned child
          // sub-workflow is the executionId prefix (children start with
          // `wf-child-`) plus the `source: 'agent'` tag the route writes
          // when registering a fresh trigger. Drop everything else so the
          // UI list shows only top-level runs.
          if (typeof r.executionId === 'string' && r.executionId.startsWith('wf-child-')) {
            return false;
          }
          if (r.source && r.source !== 'agent') return false;
          return true;
        });
        if (profileId) runs = runs.filter(r => r.userId === `agent:${profileId}`);
        if (status) runs = runs.filter(r => r.status === status);
        // Per-user filter: a regular operator should only see runs they
        // triggered. Admins see everything. The registry record's
        // triggeredBy is mirrored from state.data._agent.triggeredBy, but
        // we keep it on the registry too via the register payload below —
        // legacy entries from before this commit may not have it, so we
        // fall back to a state lookup for those.
        if (!isAdminUser(req.user)) {
          const myId = req.user?.id;
          const filtered = [];
          let unknownMetadataSkipped = 0;
          for (const r of runs) {
            const trig = r.triggeredBy?.userId;
            if (trig && myId && trig === myId) {
              filtered.push(r);
              continue;
            }
            if (trig) {
              // Belongs to another user — quietly exclude.
              continue;
            }
            // Fall back to checking state.data._agent.triggeredBy for runs
            // registered before this filter shipped.
            try {
              const st = await getEngine().getState(r.executionId);
              const stTrig = st?.data?._agent?.triggeredBy?.userId;
              if (stTrig && myId && stTrig === myId) {
                filtered.push(r);
              } else if (!stTrig) {
                // No triggeredBy anywhere — quarantine this run; surface
                // the count so operators notice broken metadata instead of
                // wondering why their list is short.
                unknownMetadataSkipped += 1;
              }
            } catch {
              unknownMetadataSkipped += 1;
            }
          }
          if (unknownMetadataSkipped > 0) {
            logger.warn('Agent runs without triggeredBy metadata excluded from list', {
              component: 'AgentRuns',
              userId: myId,
              count: unknownMetadataSkipped
            });
          }
          runs = filtered;
        }
        res.json(runs);
      } catch (error) {
        sendFailedOperationError(res, 'list agent runs', error);
      }
    }
  );

  // ── Single run ────────────────────────────────────────────────────────────
  // Returns the enriched shape `useWorkflowExecution()` expects (canReconnect,
  // pendingCheckpoint, etc.) so the agent run detail page can reuse the
  // workflow execution hook without forking.
  app.get(
    buildServerPath('/api/agents/runs/:runId'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { runId } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!(await authorizeRunAccess(req, res, runId))) return;
        const state = await getEngine().getState(runId);
        if (!state) return sendNotFound(res, `Run ${runId} not found`);

        const canReconnect = state.status === 'running' || state.status === 'paused';
        const pendingCheckpoint = state.data?.pendingCheckpoint || null;
        const workflowName = state.data?._workflowDefinition?.name || null;

        res.json({
          executionId: state.executionId,
          workflowId: state.workflowId,
          workflowName,
          status: state.status,
          currentNodes: state.currentNodes,
          completedNodes: state.completedNodes,
          failedNodes: state.failedNodes,
          createdAt: state.createdAt,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          history: state.history,
          errors: state.errors,
          checkpoints: state.checkpoints?.map(cp => ({ id: cp.id, timestamp: cp.timestamp })),
          data: state.data,
          canReconnect,
          pendingCheckpoint
        });
      } catch (error) {
        sendFailedOperationError(res, 'read agent run', error);
      }
    }
  );

  // ── SSE stream ────────────────────────────────────────────────────────────
  // Mirrors /api/workflows/executions/:executionId/stream so the agent run
  // detail page gets live updates without forcing operators to enable the
  // workflows feature flag.
  const agentClients = new Map();
  startInactiveClientSweep(agentClients, { component: 'AgentRuns' });

  app.get(
    buildServerPath('/api/agents/runs/:runId/stream'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      if (!(await authorizeRunAccess(req, res, runId))) return;

      const channel = createSseChannel({
        req,
        res,
        id: runId,
        map: agentClients,
        component: 'AgentRuns',
        onClose: () => actionTracker.off('fire-sse', handleEvent)
      });

      channel.send('connected', { runId });

      logger.info('SSE connection established for agent run', {
        component: 'AgentRuns',
        runId
      });

      // Event prefixes we forward to the client.
      const forwardedPrefixes = ['workflow.', 'agent.'];

      // Track this run and any descendant sub-workflow executionIds. The
      // planner spawns a child workflow whose events fire with
      // `chatId = childExecutionId` (not the parent runId) — without this
      // bookkeeping the UI sees only the parent's start/planner/end nodes and
      // none of the task work done in the sub-workflow.
      const trackedIds = new Set([runId]);

      // Seed from existing state in case the SSE client connects after some
      // child workflows have already been spawned.
      (async () => {
        try {
          const state = await getEngine().getState(runId);
          const seed = ids => {
            if (Array.isArray(ids)) {
              for (const id of ids) trackedIds.add(id);
            }
          };
          seed(state?.data?._childExecutionIds);
          // Walk descendants one level deep at minimum
          for (const childId of state?.data?._childExecutionIds || []) {
            const childState = await getEngine().getState(childId);
            seed(childState?.data?._childExecutionIds);
          }
        } catch (err) {
          logger.warn('Could not seed child execution ids for SSE', {
            component: 'AgentRuns',
            runId,
            error: err.message
          });
        }
      })();

      const handleEvent = eventData => {
        const eventType = eventData.event;
        if (typeof eventType !== 'string') return;
        if (!forwardedPrefixes.some(p => eventType.startsWith(p))) return;

        // Auto-track new child executions as they're spawned mid-run.
        if (eventType === 'workflow.subworkflow.start') {
          const childId = eventData.data?.executionId || eventData.executionId;
          if (childId) trackedIds.add(childId);
        }

        const matchesRun =
          (eventData.chatId && trackedIds.has(eventData.chatId)) ||
          (eventData.executionId && trackedIds.has(eventData.executionId));
        if (!matchesRun) return;

        // Always tag the event with the parent runId so the client can route
        // it consistently regardless of which (sub)workflow emitted it.
        channel.send(eventType, { ...eventData, _parentRunId: runId });
      };

      actionTracker.on('fire-sse', handleEvent);
    }
  );

  // ── Cancel ────────────────────────────────────────────────────────────────
  app.post(
    buildServerPath('/api/agents/runs/:runId/cancel'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { runId } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!(await authorizeRunAccess(req, res, runId))) return;
        const state = await getEngine().cancel(runId, req.body?.reason || 'user_cancelled');
        res.json({ ok: true, status: state.status });
      } catch (error) {
        sendFailedOperationError(res, 'cancel agent run', error);
      }
    }
  );

  // ── Resume from terminated state ──────────────────────────────────────────
  // Mirrors POST /api/workflows/executions/:executionId/resume-from-terminated.
  // Used to restart an agent run that ended with failed/cancelled/timed-out
  // status — typically after raising the wall-time budget. Picks up at the
  // last checkpoint so completed task work is preserved.
  //
  // Unlike standard workflow runs, agent runs don't persist `_workflowDefinition`
  // into state (the embedded workflow can be hefty — full system prompts etc),
  // so we rebuild it here from the agent profile and pass it via options.
  // Same logic used at run-start above (lines ~138-161).
  app.post(
    buildServerPath('/api/agents/runs/:runId/resume'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { runId } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!(await authorizeRunAccess(req, res, runId))) return;

        // Recover the profile id from state (preferred) or registry entry.
        const state = await getEngine().stateManager.get(runId);
        if (!state) return sendNotFound(res, 'Run');
        let profileId = state.data?._agent?.profileId;
        if (!profileId) {
          const registry = getExecutionRegistry();
          const entry = registry.get ? registry.get(runId) : null;
          if (typeof entry?.userId === 'string' && entry.userId.startsWith('agent:')) {
            profileId = entry.userId.slice('agent:'.length);
          }
        }
        if (!profileId) {
          return sendBadRequest(
            res,
            'Cannot identify agent profile for this run — refusing to resume without a workflow definition.'
          );
        }

        const profile = lookupProfile(profileId);
        if (!profile) return sendBadRequest(res, `Agent profile ${profileId} no longer exists`);

        const serialized = serializeProfile(profile);
        let workflow;
        if (
          serialized.workflow?.ref === 'external' &&
          typeof serialized.workflow.workflowId === 'string'
        ) {
          const wf = configCache.getWorkflowById(serialized.workflow.workflowId);
          if (!wf) {
            return sendBadRequest(
              res,
              `External workflow ${serialized.workflow.workflowId} not found`
            );
          }
          workflow = JSON.parse(JSON.stringify(wf));
        } else {
          workflow = serialized.workflow?.definition || {};
        }
        workflow.id = workflow.id || `agent:${profileId}`;
        // Refresh the wall-time budget from the (possibly updated) profile so
        // the resumed run uses the operator's current setting, not whatever
        // was baked in when the run originally started.
        const maxWallTimeSec = profile.budgets?.maxWallTimeSec ?? 600;
        workflow.config = {
          ...(workflow.config || {}),
          maxExecutionTime: maxWallTimeSec * 1000,
          ...(profile.preferredModel ? { defaultModelId: profile.preferredModel } : {})
        };
        applyNodeModels(workflow, profile.nodeModels);
        // Re-inject review knobs on resume so the re-fetched workflow's verifier
        // nodes reflect the operator's current profile settings.
        applyReviewSettings(workflow, resolveReviewSettings(profile.review));

        const newState = await getEngine().resumeFromTerminated(runId, {
          user: req.user,
          workflow,
          checkpointOnNode: true
        });
        logger.info('Agent run resumed from terminated state', {
          component: 'AgentRunsRoute',
          runId,
          profileId,
          userId: req.user?.id
        });
        res.json({
          ok: true,
          executionId: newState.executionId,
          status: newState.status,
          currentNodes: newState.currentNodes
        });
      } catch (error) {
        if (error.code === 'EXECUTION_NOT_FOUND') return sendNotFound(res, 'Run');
        if (
          error.code === 'INVALID_STATE_FOR_RESUME' ||
          error.code === 'WORKFLOW_NOT_AVAILABLE' ||
          error.code === 'NO_RESUME_POINT' ||
          error.code === 'USER_CANCELLED'
        ) {
          return sendBadRequest(res, error.message);
        }
        sendFailedOperationError(res, 'resume agent run', error);
      }
    }
  );

  // ── HITL approval ─────────────────────────────────────────────────────────
  app.post(
    buildServerPath('/api/agents/runs/:runId/approve'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { runId } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!(await authorizeRunAccess(req, res, runId))) return;
        const { checkpointId, response, data, note } = req.body || {};
        if (!checkpointId || !response) {
          return sendBadRequest(res, 'checkpointId and response are required');
        }

        const state = await getEngine().getState(runId);
        if (!state) return sendNotFound(res, `Run ${runId} not found`);
        if (state.status !== 'paused') {
          return sendBadRequest(res, `Run is not paused (status=${state.status})`);
        }

        const checkpoint = state.data?.pendingCheckpoint;
        if (!checkpoint || checkpoint.id !== checkpointId) {
          return sendBadRequest(res, 'pendingCheckpoint mismatch');
        }

        const workflow = state.data?._workflowDefinition;
        if (!workflow) return sendBadRequest(res, 'Workflow definition not available');
        const humanNode = workflow.nodes.find(n => n.id === checkpoint.nodeId);
        if (!humanNode) return sendBadRequest(res, 'Human node not found');

        // HumanNodeExecutor.resume enforces approver-group validation when the
        // workflow is an agent run.
        const executor = new HumanNodeExecutor();
        const resumeResult = await executor.resume(
          humanNode,
          state,
          { checkpointId, response, data, note },
          { executionId: runId, user: req.user }
        );

        if (resumeResult.status === 'failed') {
          return res.status(403).json({ error: 'NOT_AUTHORIZED', message: resumeResult.error });
        }

        const scheduler = getEngine().scheduler;
        const branch = resumeResult.branch;
        const humanResult = { branch, response, ...resumeResult.output };
        const nextNodes = scheduler.getNextNodes(humanNode.id, humanResult, workflow, state);

        await getEngine().stateManager.update(runId, {
          completedNodes: [...(state.completedNodes || []), humanNode.id],
          currentNodes: nextNodes,
          data: {
            ...state.data,
            ...(resumeResult.stateUpdates || {}),
            [`_humanResult_${humanNode.id}`]: humanResult,
            nodeResults: {
              ...(state.data?.nodeResults || {}),
              [humanNode.id]: humanResult
            }
          }
        });

        const newState = await getEngine().resume(runId, {}, { user: req.user, workflow });
        res.json({ ok: true, status: newState.status });
      } catch (error) {
        if (error.code === 'EXECUTION_NOT_FOUND') return sendNotFound(res, 'Run');
        sendFailedOperationError(res, 'approve agent run', error);
      }
    }
  );

  // ── Cross-profile pending approvals queue ────────────────────────────────
  app.get(
    buildServerPath('/api/agents/approvals'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const registry = getExecutionRegistry();
        const all = registry.getAll ? registry.getAll() : [];
        const pending = [];
        for (const r of all) {
          if (typeof r?.userId !== 'string' || !r.userId.startsWith('agent:')) continue;
          if (r.status !== 'paused' || !r.pendingCheckpoint) continue;
          pending.push({
            runId: r.executionId,
            profileId: r.userId.slice('agent:'.length),
            checkpoint: r.pendingCheckpoint,
            pausedAt: r.pausedAt || null
          });
        }
        res.json(pending);
      } catch (error) {
        sendFailedOperationError(res, 'list pending approvals', error);
      }
    }
  );
}
