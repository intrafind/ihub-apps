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
        const workflow = serialized.workflow.definition || {};
        workflow.id = workflow.id || `agent:${profileId}`;

        const principal = buildAgentPrincipal(profile, {
          userId: req.user?.id || 'anonymous',
          kind: 'manual'
        });

        // Pre-populate the brief from the operator input, falling back to the
        // Profile's system instructions (in English) so Planner-based agents
        // always have a goal to plan against even when no brief is supplied.
        const systemFallback =
          (profile.system && (profile.system.en || Object.values(profile.system)[0])) || '';
        const resolvedBrief = brief && brief.trim().length > 0 ? brief : systemFallback;

        const initialData = {
          brief: resolvedBrief || '',
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
  app.get(buildServerPath('/api/agents/runs/:runId'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const state = await getEngine().getState(runId);
      if (!state) return sendNotFound(res, `Run ${runId} not found`);
      res.json(state);
    } catch (error) {
      sendFailedOperationError(res, 'read agent run', error);
    }
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
