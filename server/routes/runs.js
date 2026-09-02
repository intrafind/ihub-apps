/**
 * Run routes — the unified runtime's HTTP surface (concept §5.4–§5.6).
 *
 *   GET    /api/runs                                  admin: list runs from the ledger index
 *   GET    /api/runs/:runId                           run metadata (owner, admin, or anonymous-run id possession)
 *   GET    /api/runs/:runId/events?after=&lt;seq&gt;        ledger events (`view=sse` → SSE v2 envelopes for re-sync)
 *   DELETE /api/runs/:runId                           erase a run with cascade (owner or admin)
 *   GET    /api/runs/:runId/interactions              pending interactions of a run
 *   POST   /api/runs/:runId/interactions/:id/answer   THE one answer endpoint
 *   POST   /api/runs/:runId/human-events              steer / stop / feedback into a run
 *   GET    /api/interactions/pending                  the interactions queue (approver-group filtered)
 *
 * Workflow executions and agent runs are ledger runs too (runId === executionId),
 * so a paused `human` node is answered here; the answer resumes the execution
 * (services/workflow/checkpointResume.js).
 *
 * @module routes/runs
 */
import { authRequired } from '../middleware/authRequired.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendNotFound,
  sendInsufficientPermissions,
  sendFailedOperationError
} from '../utils/responseHelpers.js';
import runLog from '../services/loop/RunLog.js';
import interactionService, { InteractionError } from '../services/loop/InteractionService.js';
import {
  interactionAnswerRequestSchema,
  humanEventRequestSchema
} from '../services/loop/contracts/interaction.js';
import { resolvePrincipal, isAnonymousUser } from '../services/loop/runIdentity.js';
import { authorizeRun, isAdminUser } from '../services/loop/runAccess.js';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { projectLedgerEvent } from '../services/loop/RunStream.js';
import { getExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { getWorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { abortChatRequest } from '../sse.js';
import { cancelChatWorkflow } from '../tools/workflowRunner.js';
import logger from '../utils/logger.js';

/**
 * `stop` is the one human event with a side effect: abort the run. A chat run
 * aborts its active model call (and any workflow it launched); a workflow or
 * agent run is cancelled on the engine.
 * @returns {Promise<string|null>} what was stopped
 */
async function stopRun(runId, meta) {
  const refs = runLog.getRunMeta(runId)?.refs || {};
  if (meta?.kind === 'chat' && refs.chatId) {
    abortChatRequest(refs.chatId);
    await cancelChatWorkflow(refs.chatId);
    return 'chat_aborted';
  }
  if (meta?.kind === 'workflow' || meta?.kind === 'agent' || getExecutionRegistry().get(runId)) {
    try {
      await getWorkflowEngine().cancel(runId, 'user_stop');
      return 'execution_cancelled';
    } catch (err) {
      if (err.code === 'EXECUTION_NOT_FOUND') return null;
      throw err;
    }
  }
  logger.debug('human/event stop recorded without an abortable target', {
    component: 'RunRoutes',
    runId,
    kind: meta?.kind || null
  });
  return null;
}

function sendInteractionError(res, err, operation) {
  if (err instanceof InteractionError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  return sendFailedOperationError(res, operation, err);
}

export default function registerRunRoutes(app) {
  app.get(buildServerPath('/api/runs'), adminAuth, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
      const runs = await runLog.listRuns({
        from: req.query.from,
        to: req.query.to,
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        principalId: typeof req.query.principalId === 'string' ? req.query.principalId : undefined,
        limit
      });
      res.json({ runs, persisted: runLog.isEnabled() });
    } catch (error) {
      sendFailedOperationError(res, 'list runs', error);
    }
  });

  app.get(buildServerPath('/api/runs/:runId'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const auth = await authorizeRun(runId, req.user);
      if (!auth.ok) {
        return auth.status === 404
          ? sendNotFound(res, 'Run')
          : sendInsufficientPermissions(res, 'access run');
      }
      res.json({ ...auth.meta, seq: await runLog.lastSeq(runId), persisted: runLog.isEnabled() });
    } catch (error) {
      sendFailedOperationError(res, 'get run', error);
    }
  });

  app.get(buildServerPath('/api/runs/:runId/events'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const auth = await authorizeRun(runId, req.user);
      if (!auth.ok) {
        return auth.status === 404
          ? sendNotFound(res, 'Run')
          : sendInsufficientPermissions(res, 'access run');
      }
      const after = Math.max(parseInt(req.query.after, 10) || 0, 0);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
      const events = await runLog.readEvents(runId, { afterSeq: after, limit });
      const lastSeq = await runLog.lastSeq(runId);
      if (req.query.view === 'sse') {
        // Client re-sync: the same envelopes the live stream would have carried.
        return res.json({ runId, after, events: events.flatMap(projectLedgerEvent), lastSeq });
      }
      res.json({ runId, after, events, lastSeq });
    } catch (error) {
      sendFailedOperationError(res, 'read run events', error);
    }
  });

  app.delete(buildServerPath('/api/runs/:runId'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const auth = await authorizeRun(runId, req.user);
      if (!auth.ok) {
        return auth.status === 404
          ? sendNotFound(res, 'Run')
          : sendInsufficientPermissions(res, 'delete run');
      }
      const result = await runLog.deleteRun(runId);
      res.json(result);
    } catch (error) {
      sendFailedOperationError(res, 'delete run', error);
    }
  });

  app.get(buildServerPath('/api/runs/:runId/interactions'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const auth = await authorizeRun(runId, req.user);
      if (!auth.ok) {
        return auth.status === 404
          ? sendNotFound(res, 'Run')
          : sendInsufficientPermissions(res, 'access run');
      }
      res.json({ runId, interactions: await interactionService.listPending({ runId }) });
    } catch (error) {
      sendFailedOperationError(res, 'list run interactions', error);
    }
  });

  /**
   * @swagger
   * /runs/{runId}/interactions/{interactionId}/answer:
   *   post:
   *     summary: Answer an interaction (question, approval, review)
   *     description: |
   *       The one answer endpoint for every human touchpoint: a chat clarification
   *       (`ask_user`), a workflow `human` node checkpoint or an agent approval.
   *       For a checkpoint the run id is the execution id and the interaction id is
   *       the checkpoint id; the answer is validated against the node, the workflow
   *       routes on the chosen branch and the execution resumes before the answer is
   *       accepted. A rejected answer (invalid option, missing form field,
   *       unauthorized approver, execution not paused on this checkpoint) returns
   *       4xx with a `code` and leaves the interaction pending.
   *     tags:
   *       - Runs
   *       - Human Checkpoint
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: runId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: interactionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               value:
   *                 description: Chosen option value, free text or decision keyword
   *               data:
   *                 type: object
   *                 description: Structured payload (form data) when the prompt has an inputSchema
   *               decision:
   *                 type: string
   *                 enum: [approve, edit, reject, respond]
   *               reason:
   *                 type: string
   *               skipped:
   *                 type: boolean
   *               channel:
   *                 type: string
   *                 enum: [chat, run_page, queue, api]
   *     responses:
   *       200:
   *         description: Answer accepted; the interaction is returned with its answer
   *       400:
   *         description: Invalid answer, or the execution rejected it
   *       403:
   *         description: Not an approver / not the run's owner
   *       404:
   *         description: Run or interaction not found
   *       409:
   *         description: Interaction already answered, or the execution is not paused on it
   *       410:
   *         description: Interaction expired
   */
  app.post(
    buildServerPath('/api/runs/:runId/interactions/:interactionId/answer'),
    authRequired,
    async (req, res) => {
      try {
        const { runId, interactionId } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!validateIdForPath(interactionId, 'interaction', res)) return;
        const parsed = interactionAnswerRequestSchema.safeParse(req.body || {});
        if (!parsed.success) {
          return sendBadRequest(res, 'Invalid answer body', parsed.error.flatten());
        }
        const interaction = await interactionService.get(interactionId);
        if (!interaction || interaction.runId !== runId) return sendNotFound(res, 'Interaction');
        // Approver groups are enforced by the service; otherwise the run's owner (or
        // anyone holding an anonymous run id) may answer.
        const hasApproverPolicy =
          Array.isArray(interaction.policy?.approverGroups) &&
          interaction.policy.approverGroups.length > 0;
        if (!hasApproverPolicy) {
          const auth = await authorizeRun(runId, req.user, {
            executionId: interaction.source?.executionId
          });
          if (!auth.ok) {
            return auth.status === 404
              ? sendNotFound(res, 'Run')
              : sendInsufficientPermissions(res, 'answer interaction');
          }
        }
        const channel = typeof req.body?.channel === 'string' ? req.body.channel : 'api';
        const answered = await interactionService.answer(interactionId, parsed.data, {
          user: req.user,
          channel: ['chat', 'run_page', 'queue', 'api'].includes(channel) ? channel : 'api'
        });
        res.json({ success: true, interaction: answered });
      } catch (error) {
        sendInteractionError(res, error, 'answer interaction');
      }
    }
  );

  /**
   * @swagger
   * /runs/{runId}/human-events:
   *   post:
   *     summary: Deliver a human event (steer, stop, feedback) into a run
   *     description: |
   *       Records a `human/event` on the run's ledger. `stop` also aborts the run:
   *       a chat run's active model call (and any workflow it launched), or the
   *       engine cancels the workflow / agent execution.
   *     tags:
   *       - Runs
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: runId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [kind]
   *             properties:
   *               kind:
   *                 type: string
   *                 enum: [steer, stop, feedback]
   *               message:
   *                 type: string
   *               messageId:
   *                 type: string
   *               rating:
   *                 oneOf:
   *                   - type: number
   *                   - type: string
   *     responses:
   *       200:
   *         description: Event recorded (`effect` names what a stop aborted)
   *       400:
   *         description: Invalid body
   *       403:
   *         description: Not the run's owner
   *       404:
   *         description: Run not found
   */
  app.post(buildServerPath('/api/runs/:runId/human-events'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const parsed = humanEventRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendBadRequest(res, 'Invalid human event body', parsed.error.flatten());
      }
      const auth = await authorizeRun(runId, req.user);
      if (!auth.ok) {
        return auth.status === 404
          ? sendNotFound(res, 'Run')
          : sendInsufficientPermissions(res, 'send human event');
      }
      const { kind, message, messageId, rating } = parsed.data;
      const event = runLog.append(runId, RUN_LOG_EVENTS.HUMAN_EVENT, {
        kind,
        ...(message !== undefined ? { message } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        ...(rating !== undefined ? { rating } : {}),
        by: isAnonymousUser(req.user) ? 'anonymous' : String(req.user.id),
        at: new Date().toISOString()
      });
      const effect = kind === 'stop' ? await stopRun(runId, auth.meta) : null;
      res.json({ success: true, runId, seq: event?.seq ?? null, ...(effect ? { effect } : {}) });
    } catch (error) {
      sendFailedOperationError(res, 'send human event', error);
    }
  });

  /**
   * @swagger
   * /interactions/pending:
   *   get:
   *     summary: The interactions queue
   *     description: |
   *       Every pending interaction the caller may answer — admins see all,
   *       approvers those of their groups, users their own runs'. Filter with
   *       `kind` (question | approval | review | notify).
   *     tags:
   *       - Runs
   *       - Human Checkpoint
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: query
   *         name: kind
   *         schema:
   *           type: string
   *           enum: [question, approval, review, notify]
   *     responses:
   *       200:
   *         description: Pending interactions
   *       403:
   *         description: Anonymous users have no queue
   */
  app.get(buildServerPath('/api/interactions/pending'), authRequired, async (req, res) => {
    try {
      if (isAnonymousUser(req.user)) return sendInsufficientPermissions(res, 'list interactions');
      const admin = isAdminUser(req.user);
      const all = await interactionService.listPending({
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined
      });
      const groups = Array.isArray(req.user.groups) ? req.user.groups : [];
      const me = await resolvePrincipal(req.user, { mode: runLog.identityMode() });
      const visible = admin
        ? all
        : all.filter(i => {
            const approvers = i.policy?.approverGroups;
            if (Array.isArray(approvers) && approvers.length > 0) {
              return approvers.some(g => groups.includes(g));
            }
            return i.source?.principalId === me.id;
          });
      res.json({ interactions: visible });
    } catch (error) {
      sendFailedOperationError(res, 'list pending interactions', error);
    }
  });
}
