/**
 * Run routes — the unified runtime's HTTP surface (concept §5.4–§5.6).
 *
 *   GET    /api/runs                                  admin: list runs from the ledger index
 *   GET    /api/runs/:runId                           run metadata (owner, admin, or anonymous-run id possession)
 *   GET    /api/runs/:runId/events?after=&lt;seq&gt;        ledger events (`view=sse` → SSE v2 envelopes for re-sync)
 *   DELETE /api/runs/:runId                           erase a run with cascade (owner or admin)
 *   GET    /api/runs/:runId/interactions              pending interactions of a run
 *   POST   /api/runs/:runId/interactions/:id/answer   THE one answer endpoint
 *   GET    /api/interactions/pending                  the interactions queue (approver-group filtered)
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
import { interactionAnswerRequestSchema } from '../services/loop/contracts/interaction.js';
import { resolvePrincipal, isAnonymousUser } from '../services/loop/runIdentity.js';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { projectLedgerEvent } from '../services/loop/RunStream.js';

function isAdminUser(user) {
  if (!user) return false;
  if (user.permissions?.adminAccess === true) return true;
  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.includes('admin') || groups.includes('admins');
}

/**
 * Resolve the run's start record (memory first, then ledger) and decide whether
 * `user` may access it. Anonymous runs are accessible by id possession only.
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object}>}
 */
async function authorizeRun(runId, user) {
  const mem = runLog.getRunMeta(runId);
  let principalId = mem?.principalId ?? null;
  let anonymous = mem?.anonymous ?? null;
  let kind = mem?.kind ?? null;
  let startedAt = mem?.startedAt ?? null;
  if (principalId === null) {
    const events = await runLog.readEvents(runId, { limit: 1 });
    const start = events.find(e => e.type === RUN_LOG_EVENTS.RUN_START);
    if (!start) return { ok: false, status: 404 };
    principalId = start.data.principal?.id ?? null;
    anonymous = start.data.principal?.anonymous === true;
    kind = start.data.kind;
    startedAt = start.ts;
  }
  const meta = { runId, kind, anonymous, startedAt, principalId };
  if (isAdminUser(user) || anonymous) return { ok: true, meta };
  if (isAnonymousUser(user)) return { ok: false, status: 403 };
  const me = await resolvePrincipal(user, { mode: runLog.identityMode() });
  if (me.id === principalId) return { ok: true, meta };
  return { ok: false, status: 403 };
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
          const auth = await authorizeRun(runId, req.user);
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
