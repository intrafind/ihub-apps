/**
 * Agent run lifecycle routes:
 *   POST /api/agents/profiles/:id/runs        — manual trigger
 *   GET  /api/agents/runs                     — list agent runs
 *   GET  /api/agents/runs/:runId              — single run state
 *   POST /api/agents/runs/:runId/cancel       — cancel a running run
 *   POST /api/agents/runs/:runId/approve      — HITL approval
 *   GET  /api/agents/approvals                — cross-profile pending queue
 */

import { authRequired } from '../../middleware/authRequired.js';
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
import { HumanNodeExecutor } from '../../services/workflow/executors/HumanNodeExecutor.js';
import { actionTracker } from '../../actionTracker.js';
import logger from '../../utils/logger.js';

// Lazy-shared engine. WorkflowEngine state lives in StateManager (filesystem),
// so multiple instances see the same executions; we use one per-worker.
let _engine = null;
function getEngine() {
  if (!_engine) _engine = new WorkflowEngine();
  return _engine;
}

function lookupProfile(profileId) {
  const { data: profiles = [] } = configCache.getAgentProfiles(true);
  return profiles.find(p => p.id === profileId) || null;
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

export default function registerAgentRunRoutes(app) {
  // ── Manual trigger ────────────────────────────────────────────────────────
  app.post(
    buildServerPath('/api/agents/profiles/:profileId/runs'),
    authRequired,
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

        // Defense in depth: planner nodes saved by older serializer versions
        // may be missing a `goal` or have taskTemplate wrapped in a broken
        // `{type, config: {...}}` shape (which the materializer then expands
        // into a node whose `config.config` causes deepMerge to recurse
        // forever). Fix both shapes at trigger time so legacy profiles run.
        // Also fill in modelId / system / tools / apps / sources from the
        // Profile root so legacy taskTemplates pick up the agent's choices.
        if (Array.isArray(workflow.nodes)) {
          workflow.nodes = workflow.nodes.map(n => {
            if (!n || n.type !== 'planner') return n;
            const cfg = { ...(n.config || {}) };
            if (!cfg.goal) cfg.goal = '${$.data.brief}';
            let tt = cfg.taskTemplate;
            if (tt && typeof tt === 'object' && tt.config && typeof tt.config === 'object') {
              const { type: _t, config: inner, ...rest } = tt;
              tt = { ...rest, ...inner };
            }
            if (tt) {
              const profileSystem =
                profile.system && Object.keys(profile.system).length > 0 ? profile.system : null;
              if (profileSystem && !tt.system) tt.system = profileSystem;
              if (profile.preferredModel && !tt.modelId) tt.modelId = profile.preferredModel;
              if (
                Array.isArray(profile.tools) &&
                (!Array.isArray(tt.tools) || tt.tools.length === 0)
              )
                tt.tools = profile.tools;
              if (Array.isArray(profile.apps) && (!Array.isArray(tt.apps) || tt.apps.length === 0))
                tt.apps = profile.apps;
              if (
                Array.isArray(profile.sources) &&
                (!Array.isArray(tt.sources) || tt.sources.length === 0)
              )
                tt.sources = profile.sources;
              cfg.taskTemplate = tt;
            }
            if (profile.preferredModel && !cfg.modelId) cfg.modelId = profile.preferredModel;
            return { ...n, config: cfg };
          });
        }

        const principal = buildAgentPrincipal(profile, {
          userId: req.user?.id || 'anonymous',
          kind: 'manual'
        });

        // Pre-populate the brief from (in priority order):
        //   1. operator-supplied brief in the POST body
        //   2. the Profile's system instructions (English)
        //   3. an inbox-aware default if the profile has an inboxId
        //   4. a generic fallback so Planner never errors
        const systemFallback =
          (profile.system && (profile.system.en || Object.values(profile.system)[0])) || '';
        let resolvedBrief = brief && brief.trim().length > 0 ? brief : systemFallback;
        if (!resolvedBrief && profile.inboxId) {
          resolvedBrief = `Read the "${profile.inboxId}" inbox via read_inbox, pick the highest-priority open item, plan how to handle it, then execute the plan. When finished, call write_inbox(mode='markDone') for the item and write_artifact with a summary.`;
        }
        if (!resolvedBrief) {
          resolvedBrief = `You are agent ${profileId}. Plan and execute the work this agent is configured for.`;
        }

        const initialData = {
          brief: resolvedBrief,
          variables: variables || {},
          _agent: {
            profileId,
            triggeredBy: { userId: req.user?.id || 'anonymous', kind: 'manual' },
            artifacts: []
          }
        };

        // Calculate wall-time deadline via workflow config
        const maxWallTimeSec = profile.budgets?.maxWallTimeSec ?? 600;
        workflow.config = {
          ...(workflow.config || {}),
          maxExecutionTime: maxWallTimeSec * 1000
        };

        const state = await getEngine().start(workflow, initialData, {
          user: principal
        });
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
  app.get(buildServerPath('/api/agents/runs'), authRequired, async (req, res) => {
    try {
      const registry = getExecutionRegistry();
      const all = registry.getAll ? registry.getAll() : [];
      const { profileId, status } = req.query;
      let runs = all.filter(r => typeof r?.userId === 'string' && r.userId.startsWith('agent:'));
      if (profileId) runs = runs.filter(r => r.userId === `agent:${profileId}`);
      if (status) runs = runs.filter(r => r.status === status);
      res.json(runs);
    } catch (error) {
      sendFailedOperationError(res, 'list agent runs', error);
    }
  });

  // ── Single run ────────────────────────────────────────────────────────────
  // Returns the enriched shape `useWorkflowExecution()` expects (canReconnect,
  // pendingCheckpoint, etc.) so the agent run detail page can reuse the
  // workflow execution hook without forking.
  app.get(buildServerPath('/api/agents/runs/:runId'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
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
  });

  // ── SSE stream ────────────────────────────────────────────────────────────
  // Mirrors /api/workflows/executions/:executionId/stream so the agent run
  // detail page gets live updates without forcing operators to enable the
  // workflows feature flag.
  const agentClients = new Map();

  app.get(buildServerPath('/api/agents/runs/:runId/stream'), authRequired, (req, res) => {
    const { runId } = req.params;
    if (!validateIdForPath(runId, 'run', res)) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    agentClients.set(runId, { response: res, lastActivity: new Date() });
    const myEntry = agentClients.get(runId);

    res.write(`event: connected\ndata: ${JSON.stringify({ runId })}\n\n`);

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

      const client = agentClients.get(runId);
      if (client) client.lastActivity = new Date();

      try {
        // Always tag the event with the parent runId so the client can route
        // it consistently regardless of which (sub)workflow emitted it.
        const payload = { ...eventData, _parentRunId: runId };
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (error) {
        logger.error('Error sending agent SSE event', {
          component: 'AgentRuns',
          runId,
          eventType,
          error: error.message
        });
      }
    };

    actionTracker.on('fire-sse', handleEvent);

    const heartbeatInterval = setInterval(() => {
      if (agentClients.get(runId) !== myEntry) {
        clearInterval(heartbeatInterval);
        return;
      }
      try {
        res.write(`: heartbeat\n\n`);
      } catch (_err) {
        clearInterval(heartbeatInterval);
        if (agentClients.get(runId) === myEntry) agentClients.delete(runId);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      actionTracker.off('fire-sse', handleEvent);
      if (agentClients.get(runId) === myEntry) agentClients.delete(runId);
      logger.info('SSE connection closed for agent run', { component: 'AgentRuns', runId });
    });
  });

  // ── Cancel ────────────────────────────────────────────────────────────────
  app.post(buildServerPath('/api/agents/runs/:runId/cancel'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const state = await getEngine().cancel(runId, req.body?.reason || 'user_cancelled');
      res.json({ ok: true, status: state.status });
    } catch (error) {
      sendFailedOperationError(res, 'cancel agent run', error);
    }
  });

  // ── HITL approval ─────────────────────────────────────────────────────────
  app.post(buildServerPath('/api/agents/runs/:runId/approve'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
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
  });

  // ── Cross-profile pending approvals queue ────────────────────────────────
  app.get(buildServerPath('/api/agents/approvals'), authRequired, async (req, res) => {
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
  });
}
