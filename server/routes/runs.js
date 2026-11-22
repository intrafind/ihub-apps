// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Run routes — the unified runtime's HTTP surface (concept §5.4–§5.6).
 *
 *   GET    /api/runs                                  admin: list runs from the ledger index
 *   GET    /api/runs/:runId                           run metadata (owner, admin, or anonymous-run id possession)
 *   GET    /api/runs/:runId/events?cursor=&lt;c&gt;       ledger events (`view=sse` → SSE v2 envelopes for re-sync)
 *   DELETE /api/runs/:runId                           erase a run with cascade (owner, or admin: audited)
 *   GET    /api/runs/:runId/interactions              pending interactions of a run
 *   POST   /api/runs/:runId/interactions/:id/answer   THE one answer endpoint (owner or approver group)
 *   POST   /api/runs/:runId/human-events              steer / feedback (owner), stop (owner, or admin: audited)
 *   DELETE /api/runs/:runId/human-events/:id          remove a queued message before it is read (owner)
 *   GET    /api/interactions/pending                  the interactions queue (approver-group filtered)
 *
 * Every access check names its intent (`services/loop/runAccess.js`); a new
 * route under `/api/runs` needs its row in `server/tests/routeInventory.table.js`.
 *
 * Workflow executions and agent runs are ledger runs too (runId === executionId),
 * so a paused `human` node is answered here; the answer resumes the execution
 * (services/workflow/checkpointResume.js).
 *
 * @module routes/runs
 */
import { limitFrom, offsetCursor, offsetFromCursor } from '../utils/pagination.js';
import { authRequired } from '../middleware/authRequired.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { buildServerPath } from '../utils/basePath.js';
import { assertValidId } from '../utils/pathSecurity.js';
import { ServiceError } from '../utils/ServiceError.js';
import runLog from '../services/loop/RunLog.js';
import interactionService from '../services/loop/InteractionService.js';
import {
  interactionAnswerRequestSchema,
  humanEventRequestSchema
} from '../services/loop/contracts/interaction.js';
import { resolvePrincipal, resolveActorId, isAnonymousUser } from '../services/loop/runIdentity.js';
import { isAdmin } from '../utils/authorization.js';
// Local names: the access check is the run's own ownership rule, and the API is rate-limited as a whole.
import {
  authorizeRun as loadRunAccess,
  authorizeInteraction as loadInteractionAccess
} from '../services/loop/runAccess.js';
import { isChatToolApproval } from '../services/chat/chatToolApproval.js';
import { isViewToolApproval } from '../services/mcp/mcpViewToolApproval.js';
import { redactInteractionForViewer } from '../utils/toolApproval.js';
import { cancelSteer, newSteerId, steerRun } from '../services/loop/steering.js';
import { createRunSteerLimiter } from '../middleware/rateLimiting.js';
import { logAudit } from '../services/AuditLogService.js';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { projectLedgerEvent, getStreamRun } from '../services/loop/RunStream.js';
import { clientEnvelope } from '../services/loop/clientProjection.js';
import { getExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { getWorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { abortChatRequest } from '../sse.js';
import { userAbortCause } from '../services/chat/abortCause.js';
import { cancelChatWorkflow } from '../tools/workflowRunner.js';
import logger from '../utils/logger.js';
import { getChatEvidenceRepository } from '../services/chat/ChatEvidenceRepository.js';
import {
  readEvidenceContent,
  readEvidenceRecord,
  sendEvidence
} from '../services/chat/evidenceRecord.js';

/**
 * `stop` is the one human event with a side effect: abort the run. A chat run
 * aborts its active model call (and any workflow it launched); a workflow or
 * agent run is cancelled on the engine.
 *
 * Abortable chat work is keyed by chat id, so the side effect is applied only
 * when the addressed run is the one currently producing on that chat: a run
 * that already ended, or that is no longer the run bound to the chat's stream,
 * records the event without aborting a newer turn of the same chat.
 * @returns {Promise<string|null>} what was stopped
 */
async function stopRun(runId, meta, cause) {
  const refs = runLog.getRunMeta(runId)?.refs || meta?.refs || {};
  if (meta?.kind === 'chat' && refs.chatId) {
    if (await runLog.hasEnded(runId)) return null;
    const bound = getStreamRun(refs.chatId);
    if (bound && bound.runId !== runId) return null;
    abortChatRequest(refs.chatId, cause);
    await cancelChatWorkflow(refs.chatId);
    return 'chat_aborted';
  }
  // The registry read is async now that execution records live in the shared
  // `runs` namespace instead of a per-worker Map. Left inside the `||` chain
  // unawaited it would be a promise — always truthy — and every chat run
  // would try to cancel a workflow. `||` still short-circuits, so a run the
  // metadata already identifies never pays for the read.
  const targetsExecution =
    meta?.kind === 'workflow' ||
    meta?.kind === 'agent' ||
    Boolean(await getExecutionRegistry().get(runId));
  if (targetsExecution) {
    try {
      // The execution may run on another worker: the engine relays the
      // cancellation to whoever holds its abort controller.
      const state = await getWorkflowEngine().cancelAnywhere(runId, 'user_stop');
      return state?.cancelRelayed ? 'execution_cancel_relayed' : 'execution_cancelled';
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

/**
 * The 404 of a finished run whose journal was deleted after its grace period.
 * @returns {ServiceError}
 */
function journalNotKept() {
  return new ServiceError(
    'JOURNAL_NOT_KEPT',
    'The events of this run are no longer kept; read its evidence record instead'
  );
}

/**
 * The refusal of a caller who knows a run and may not do `intent` with it.
 * A steer has its own code: the client shows why the message was not sent. Its
 * text names neither a chat nor an owner: the same code answers for an agent
 * run and a workflow run, which have no chat and take no message from anybody.
 *
 * @param {string} intent - a run intent, or a human event kind
 * @returns {ServiceError}
 */
function runForbidden(intent) {
  if (intent === 'steer') {
    return new ServiceError(
      'RUN_STEER_FORBIDDEN',
      'Only the person this answer is written for can send a message while it is being written'
    );
  }
  const action =
    { read: 'access run', delete: 'delete run', stop: 'stop run', feedback: 'rate run' }[intent] ||
    'access run';
  return new ServiceError('FORBIDDEN', `Insufficient permissions: ${action} required`);
}

/**
 * The run access of the request for `intent`, or the refusal as an error.
 *
 * @param {string} runId
 * @param {Object} user - req.user
 * @param {string} intent - one of `RUN_INTENTS`
 * @returns {Promise<{ok: true, meta: Object, viaAdmin?: boolean}>}
 * @throws {ServiceError} `NOT_FOUND`, `FORBIDDEN` or `RUN_STEER_FORBIDDEN`
 */
async function requireRunAccess(runId, user, intent) {
  const auth = await loadRunAccess(runId, user, { intent });
  if (auth.ok) return auth;
  throw auth.status === 404 ? new ServiceError('NOT_FOUND', 'Run not found') : runForbidden(intent);
}

/**
 * The audit summary of an admin's stop of a run that is not their own.
 *
 * The entry is written for every such stop, also when nothing was running any
 * more: the summary says which of the two happened, so the audit log never
 * shows a stop that stopped nothing as an intervention. The run may belong to
 * no person (an agent's own identity, a trigger's system principal), so the
 * wording names no user.
 *
 * @param {boolean} completed - false when stopping threw
 * @param {string|null} effect - what `stopRun` stopped, null for nothing
 * @returns {string}
 */
function adminStopSummary(completed, effect) {
  if (!completed) return 'Admin stop of a run that is not their own failed';
  if (!effect) return 'Admin sent a stop to a run that is not their own; nothing was running';
  return 'Admin stopped a run that is not their own';
}

/**
 * Write what an admin did to somebody else's run to the audit log.
 *
 * @param {import('express').Request} req
 * @param {'update'|'delete'} action
 * @param {string} runId
 * @param {Object} meta - the run's record
 * @param {string} summary
 * @param {Object} [details]
 * @param {'success'|'failure'} [result='success']
 */
function auditAdminRunAction(req, action, runId, meta, summary, details = {}, result = 'success') {
  logAudit({
    req,
    action,
    resource: 'run',
    resourceId: runId,
    summary,
    result,
    details: {
      runKind: meta?.kind || null,
      // The run's owner as the ledger records it (a pseudonym in that mode).
      principalId: meta?.principalId || null,
      anonymous: meta?.anonymous === true,
      ...details
    }
  });
}

export default function registerRunRoutes(app) {
  const steerLimiter = createRunSteerLimiter();

  app.get(buildServerPath('/api/runs'), adminAuth, async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 1000);
    const runs = await runLog.listRuns({
      from: req.query.from,
      to: req.query.to,
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      principalId: typeof req.query.principalId === 'string' ? req.query.principalId : undefined,
      limit
    });
    res.json({ items: runs, persisted: runLog.isEnabled() });
  });

  app.get(buildServerPath('/api/runs/:runId'), authRequired, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    const auth = await requireRunAccess(runId, req.user, 'read');
    res.json({ ...auth.meta, seq: await runLog.lastSeq(runId), persisted: runLog.isEnabled() });
  });

  app.get(buildServerPath('/api/runs/:runId/events'), authRequired, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    await requireRunAccess(runId, req.user, 'read');
    const after = offsetFromCursor(req.query.cursor);
    const limit = limitFrom(req.query.limit, { fallback: 1000, max: 5000 });
    const events = await runLog.readEvents(runId, { afterSeq: after, limit });
    // A finished chat or inference run keeps its journal for 15 minutes only;
    // what it did is in its evidence record (`/evidence`) from then on.
    if (events.length === 0 && (await runLog.isJournalDeleted(runId))) throw journalNotKept();
    // The cursor stands for the last raw ledger sequence this page read. A
    // projected page can be empty (headers and budget events produce no
    // envelopes) while more of the ledger remains, so the walk
    // follows the cursor, never the items: it ends on a page that read nothing.
    const nextCursor = events.length ? offsetCursor(events[events.length - 1].seq) : null;
    // No `lastSeq`. It used to be answered per page, and on a provider whose
    // append log cannot stop early — the filesystem one cannot, since a
    // record's position need not follow its sequence number — that was a
    // second full parse of the stream on top of the one `readEvents` just
    // did. Replaying a 20k-event run in 1000-event pages paid for it twenty
    // times. The client only ever used it to stop one page early: the walk
    // terminates on a page that makes no progress (`ledgerPages.js`), so
    // dropping it costs one empty request at the end of a re-sync and halves
    // the reads for the whole of it.
    if (req.query.view === 'sse') {
      // Client re-sync: the same envelopes the live stream would have carried.
      return res.json({
        runId,
        items: events.flatMap(projectLedgerEvent).map(clientEnvelope),
        nextCursor
      });
    }
    res.json({ runId, items: events, nextCursor });
  });

  app.delete(buildServerPath('/api/runs/:runId'), authRequired, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    // The owner, or an admin. An anonymous run is deleted by the guest who owns
    // its chat; holding its id is not enough.
    const auth = await requireRunAccess(runId, req.user, 'delete');
    let result;
    let deleted = false;
    try {
      result = await runLog.deleteRun(runId);
      deleted = true;
    } finally {
      // An admin's delete of somebody else's run is on record whatever became of it.
      if (auth.viaAdmin) {
        auditAdminRunAction(
          req,
          'delete',
          runId,
          auth.meta,
          'Admin deleted a run that is not their own',
          {},
          deleted ? 'success' : 'failure'
        );
      }
    }
    // A run without a chat keeps its evidence record beside the ledger (#3687).
    try {
      await getChatEvidenceRepository().deleteRun(runId);
    } catch (error) {
      logger.error('Run evidence not deleted', {
        component: 'RunRoutes',
        runId,
        error: error.message
      });
    }
    res.json(result);
  });

  /**
   * @swagger
   * /api/runs/{runId}/evidence:
   *   get:
   *     summary: The evidence record of a run without a chat
   *     description: >-
   *       For `/v1/chat/completions` and Responses API runs without a conversation: what went
   *       into and came out of every model call and tool call. Content is referenced as
   *       `sha256:<hex>` and read through `/api/runs/{runId}/evidence/content/{sha256}`. The
   *       run's caller only. See docs/chat-evidence.md.
   *     tags: [Runs]
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: The evidence record }
   *       404:
   *         description: >-
   *           No record, not the caller's, or the record is switched off (EVIDENCE_NOT_RECORDED)
   */
  app.get(buildServerPath('/api/runs/:runId/evidence'), authRequired, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    sendEvidence(
      res,
      await readEvidenceRecord({ kind: 'run', id: runId, ownerId: req.user?.id ?? null })
    );
  });

  /**
   * @swagger
   * /api/runs/{runId}/evidence/content/{sha256}:
   *   get:
   *     summary: One piece of content a run's evidence record refers to
   *     description: The canonical JSON of the item named `sha256:<hex>`. The run's caller only.
   *     tags: [Runs]
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *       - { in: path, name: sha256, required: true, schema: { type: string, pattern: '^[a-f0-9]{64}$' } }
   *     responses:
   *       200: { description: The content, application/json }
   *       400: { description: Not a lower-case hex SHA-256 (BAD_REQUEST) }
   *       404: { description: No such content, not the caller's, or switched off (EVIDENCE_NOT_RECORDED) }
   */
  app.get(
    buildServerPath('/api/runs/:runId/evidence/content/:sha256'),
    authRequired,
    async (req, res) => {
      const { runId, sha256 } = req.params;
      assertValidId(runId, 'run');
      sendEvidence(
        res,
        await readEvidenceContent({ kind: 'run', id: runId, sha256, ownerId: req.user?.id ?? null })
      );
    }
  );

  app.get(buildServerPath('/api/runs/:runId/interactions'), authRequired, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    const auth = await loadRunAccess(runId, req.user, { intent: 'read' });
    const interactions = await interactionService.listPending({ runId });
    // The run may be gone from memory (persistence off, restart) while its
    // interactions are still on record: the principal recorded on them decides.
    if (
      !auth.ok &&
      !(
        interactions.length &&
        (await loadInteractionAccess(interactions[0], req.user, { intent: 'read' }))
      )
    ) {
      throw auth.status === 404
        ? new ServiceError('NOT_FOUND', 'Run not found')
        : new ServiceError('FORBIDDEN', 'Insufficient permissions: access run required');
    }
    // Tool approval arguments in full only for their requester (#2945).
    const visible = [];
    for (const i of interactions) {
      const mode = i.source?.identityMode || runLog.identityMode();
      const mine =
        !!i.source?.principalId &&
        i.source.principalId === (await resolvePrincipal(req.user, { mode })).id;
      visible.push(mine ? i : redactInteractionForViewer(i));
    }
    res.json({ items: visible });
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
   *         description: >-
   *           Not an approver, or not the run's owner. An admin does not answer an interaction of
   *           another user's run unless it names an approver group; an admin does answer for a run
   *           that belongs to no person (an agent's own identity, a workflow a trigger started). An
   *           interaction of an anonymous run is answered from the browser session that owns its
   *           chat.
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
      const { runId, interactionId } = req.params;
      assertValidId(runId, 'run');
      assertValidId(interactionId, 'interaction');
      const parsed = interactionAnswerRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw parsed.error;
      }
      const interaction = await interactionService.get(interactionId);
      if (!interaction || interaction.runId !== runId) {
        throw new ServiceError('NOT_FOUND', 'Interaction not found');
      }
      // Approver groups are enforced by the service. Otherwise only the owner
      // of the run answers: the answer continues the run with the owner's
      // rights, so an admin does not give it (except for a run that belongs to
      // no person), and for an anonymous run the ids are not enough (the guest
      // who owns its chat answers). The interaction outlives the run's
      // in-memory record, so it is authorized from its own source first.
      const hasApproverPolicy =
        Array.isArray(interaction.policy?.approverGroups) &&
        interaction.policy.approverGroups.length > 0;
      if (
        !hasApproverPolicy &&
        !(await loadInteractionAccess(interaction, req.user, { intent: 'answer' }))
      ) {
        throw new ServiceError(
          'FORBIDDEN',
          'Insufficient permissions: answer interaction required'
        );
      }
      // A chat tool approval is answered with the next chat message, which
      // also runs the approved call (#2945). Answered here, the interaction
      // would be settled while nothing ran the call.
      if (isChatToolApproval(interaction) || isViewToolApproval(interaction)) {
        throw new ServiceError('ANSWER_IN_CHAT', 'Answer this approval in its chat');
      }
      const channel = typeof req.body?.channel === 'string' ? req.body.channel : 'api';
      const answered = await interactionService.answer(interactionId, parsed.data, {
        user: req.user,
        channel: ['chat', 'run_page', 'queue', 'api'].includes(channel) ? channel : 'api'
      });
      res.json(answered);
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
   *
   *       Who may send which kind: `steer` and `feedback` only the run's owner;
   *       `stop` the owner, and an admin (written to the audit log). For a run of
   *       an anonymous visitor the owner is the browser session that owns its chat.
   *       A `steer` is refused while the run waits for an approval, and one caller
   *       sends at most 30 of them per minute.
   *
   *       A `steer` is a message into the running answer. With `mode: 'steer'` (the
   *       default) it is read at the next step; with `mode: 'afterwards'` it is sent
   *       as the next message once the answer ends. The answer names its `id` (for
   *       `DELETE /api/runs/{runId}/human-events/{id}`) when a running answer took
   *       it; without `id` and `effect` no answer is running any more, and the
   *       client sends the text as a new message. A steer the answer did not read
   *       before it ended is sent as the next turn by the server. Only a chat
   *       answer takes `mode: 'afterwards'` (400 otherwise); a workflow, agent or
   *       API run drops what it did not read when it ends (`steer/dropped`).
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
   *               mode:
   *                 type: string
   *                 enum: [steer, afterwards]
   *                 description: '`steer` only: read at the next step (default), or sent after the answer'
   *               messageId:
   *                 type: string
   *               rating:
   *                 oneOf:
   *                   - type: number
   *                   - type: string
   *     responses:
   *       200:
   *         description: >-
   *           Event recorded. `effect` names what a stop aborted, or where a steer went
   *           (`steer_queued`, `steer_relayed`); a steer a running answer took also has its `id`.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 runId: { type: string }
   *                 seq: { type: integer, nullable: true }
   *                 id: { type: string, description: 'A steer a running answer took' }
   *                 effect: { type: string }
   *       400:
   *         description: "Invalid body, or `mode: 'afterwards'` for a run that is not a chat answer"
   *       403:
   *         description: >-
   *           Not the run's owner. `RUN_STEER_FORBIDDEN` for a `steer`, `FORBIDDEN` for the
   *           other kinds.
   *       404:
   *         description: Run not found
   *       409:
   *         description: >-
   *           `RUN_NOT_ACTIVE`: a `steer` for a run that waits for an approval. The approval
   *           stays pending.
   *       429:
   *         description: '`RATE_LIMITED`: more than 30 `steer` events in a minute'
   */
  const humanEventsPath = buildServerPath('/api/runs/:runId/human-events');
  app.post(humanEventsPath, authRequired, steerLimiter, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    const parsed = humanEventRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      throw parsed.error;
    }
    const { kind, message, messageId, rating, mode } = parsed.data;
    // Each kind is its own intent: a steer and a rating are the owner's alone,
    // a stop is also an admin's.
    const auth = await requireRunAccess(runId, req.user, kind);
    // A message is never the answer to an approval. While the run waits for
    // one, nothing is queued and nothing is written: the approval stays pending
    // and is answered where it is shown.
    if (
      kind === 'steer' &&
      (await interactionService.listPending({ runId, kind: 'approval' })).length > 0
    ) {
      throw new ServiceError(
        'RUN_NOT_ACTIVE',
        'This run waits for an approval; answer the approval before sending a message'
      );
    }
    const chatId = auth.meta?.refs?.chatId || runLog.getRunMeta(runId)?.refs?.chatId || null;
    // Only a chat turn has a next turn to send a message with afterwards; a
    // workflow, an agent or an API run would hold it until it expired unseen.
    if (
      kind === 'steer' &&
      mode === 'afterwards' &&
      !(chatId && (auth.meta?.kind || 'chat') === 'chat')
    ) {
      throw new ServiceError(
        'BAD_REQUEST',
        "Only a chat answer takes a message to send afterwards; send it with mode 'steer'"
      );
    }
    // A message into the running answer gets its id here, before it is relayed
    // to the worker that runs the answer: the caller removes it by this id.
    const steer = kind === 'steer' ? { id: newSteerId(), mode: mode || 'steer' } : null;
    // The sender as the run's ledger names it; a removal is checked against it.
    const by = await resolveActorId(req.user, {
      mode: auth.meta?.identityMode || runLog.identityMode()
    });
    const at = new Date().toISOString();
    // The run may live on another worker: continue its persisted sequence.
    const event = await runLog.appendRecovered(
      runId,
      RUN_LOG_EVENTS.HUMAN_EVENT,
      {
        kind,
        ...(message !== undefined ? { message } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(steer ? { steerId: steer.id, mode: steer.mode } : {}),
        by,
        at
      },
      { kind: auth.meta?.kind || 'chat' }
    );
    // Not written because the run finished and its journal is gone.
    if (!event && (await runLog.isJournalDeleted(runId))) throw journalNotKept();
    let effect = null;
    if (kind === 'stop') {
      const cause = await userAbortCause('run_stop', req.user, {
        mode: auth.meta?.identityMode || runLog.identityMode(),
        via: 'POST /api/runs/:runId/human-events (stop)',
        related: { runId }
      });
      let stopped = false;
      try {
        effect = await stopRun(runId, auth.meta, cause);
        stopped = true;
      } finally {
        // An admin's stop of somebody else's run is on record whatever became
        // of it; `effect` and the summary say whether anything was stopped.
        if (auth.viaAdmin) {
          auditAdminRunAction(
            req,
            'update',
            runId,
            auth.meta,
            adminStopSummary(stopped, effect),
            { event: 'stop', effect, stoppedSomething: Boolean(effect) },
            stopped ? 'success' : 'failure'
          );
        }
      }
    }
    // A steer reaches the running loop at its next step boundary (queued on
    // the worker that owns the run, asked there in a cluster); without an
    // active loop it is recorded only, and the answer has no id.
    let id = null;
    if (steer) {
      const routed = await steerRun(runId, {
        ...steer,
        message,
        by,
        at,
        chatId
      });
      effect = routed ? `steer_${routed}` : null;
      id = routed ? steer.id : null;
    }
    // 200, as the route always answered: the event is recorded either way.
    res.json({
      runId,
      seq: event?.seq ?? null,
      ...(id ? { id } : {}),
      ...(effect ? { effect } : {})
    });
  });

  /**
   * @swagger
   * /runs/{runId}/human-events/{id}:
   *   delete:
   *     summary: Remove a queued message before the running answer reads it
   *     description: |
   *       Removes a message sent with `POST /api/runs/{runId}/human-events`
   *       (`kind: 'steer'`, either mode) while it waits. A removed message is never
   *       read and never sent as the next turn. A message the answer already read,
   *       or sent as the next turn, cannot be removed (409 `STEER_ALREADY_APPLIED`).
   *       Only the run's owner removes a message, as only the owner sends one; for a
   *       run of an anonymous visitor the owner is the browser session that owns
   *       its chat. In a cluster the worker that runs the answer is asked. A message
   *       that waits in the next turn's run (it was queued behind the message sent as
   *       that turn) is removed under the run it was sent to, as the chat's `pending[]`
   *       names it (`runId`).
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
   *       - in: path
   *         name: id
   *         required: true
   *         description: The `id` the POST answered with
   *         schema:
   *           type: string
   *     responses:
   *       204:
   *         description: Removed; it will not be read
   *       400:
   *         description: Invalid id
   *       403:
   *         description: '`RUN_STEER_FORBIDDEN`: not the run''s owner (an admin neither)'
   *       404:
   *         description: Run not found, or no such message waits (removed, dropped, or never sent)
   *       409:
   *         description: '`STEER_ALREADY_APPLIED`: the answer already read it or sent it as the next turn'
   *       503:
   *         description: >-
   *           The server process that runs the answer did not answer, or the answer is
   *           ending and what becomes of the message is being decided; try again
   */
  app.delete(
    buildServerPath('/api/runs/:runId/human-events/:id'),
    authRequired,
    async (req, res) => {
      const { runId, id } = req.params;
      assertValidId(runId, 'run');
      assertValidId(id, 'message');
      // The owner's own message: the same right as sending it.
      const auth = await requireRunAccess(runId, req.user, 'steer');
      const by = await resolveActorId(req.user, {
        mode: auth.meta?.identityMode || runLog.identityMode()
      });
      const result = await cancelSteer(runId, id, { by });
      if (result === 'applied') {
        throw new ServiceError(
          'STEER_ALREADY_APPLIED',
          'iHub has already read or sent this message, so it can no longer be removed'
        );
      }
      if (result === 'unavailable') {
        throw new ServiceError(
          'SERVICE_UNAVAILABLE',
          'The message could not be removed right now; try again'
        );
      }
      if (result !== 'removed') throw new ServiceError('NOT_FOUND', 'Message not found');
      // On the ledger beside the event that sent it, so the record says why it was never read.
      await runLog
        .appendRecovered(
          runId,
          RUN_LOG_EVENTS.HUMAN_EVENT,
          { kind: 'steer', steerId: id, removed: true, by, at: new Date().toISOString() },
          { kind: auth.meta?.kind || 'chat' }
        )
        .catch(error =>
          logger.warn('Removal of a queued message not recorded', {
            component: 'RunRoutes',
            runId,
            error: error.message
          })
        );
      res.status(204).end();
    }
  );

  /**
   * @swagger
   * /interactions/pending:
   *   get:
   *     summary: The interactions queue
   *     description: |
   *       The pending interactions the caller may see: users those of their own
   *       runs, approvers those of their groups, admins all of them. An admin
   *       sees more than an admin may answer: an interaction of another user's
   *       run that names no approver group is answered by that user only.
   *       Filter with `kind` (question | approval | review | notify).
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
    if (isAnonymousUser(req.user)) {
      throw new ServiceError('FORBIDDEN', 'Insufficient permissions: list interactions required');
    }
    const admin = isAdmin(req.user);
    const all = await interactionService.listPending({
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined
    });
    const groups = Array.isArray(req.user.groups) ? req.user.groups : [];
    // Owner ids were recorded in the identity mode of their run; resolve the
    // caller in each mode that occurs so runs written before an identityMode
    // change still match.
    const modeOf = i =>
      i.source?.identityMode || runLog.getRunMeta(i.runId)?.identityMode || runLog.identityMode();
    const myIdByMode = new Map();
    for (const mode of new Set(all.map(modeOf))) {
      myIdByMode.set(mode, (await resolvePrincipal(req.user, { mode })).id);
    }
    const ownedByCaller = i =>
      !!i.source?.principalId && i.source.principalId === myIdByMode.get(modeOf(i));
    const visible = admin
      ? all
      : all.filter(i => {
          const approvers = i.policy?.approverGroups;
          if (Array.isArray(approvers) && approvers.length > 0) {
            return approvers.some(g => groups.includes(g));
          }
          return ownedByCaller(i);
        });
    // A tool approval's arguments are the requester's: anyone else (an
    // admin, an approver group) sees secret-looking values redacted (#2945).
    res.json({
      items: visible.map(i => (ownedByCaller(i) ? i : redactInteractionForViewer(i)))
    });
  });
}
