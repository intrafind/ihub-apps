/**
 * Run access — who may read or act on a run (concept §5.4).
 *
 * The recorded principal (in the current identity mode) owns a run; admins
 * see every run; an anonymous run is readable by whoever presents its random
 * id. Workflow executions and agent runs the ledger does not know (persistence
 * off, or a run restored from a checkpoint before it was re-registered) are
 * authorized against their execution record: the launching principal or, for
 * agent runs, the human who triggered the run.
 *
 * Both checks read the `runs` namespace — the shared, owner-indexed record of
 * every run — so a run started on one worker authorizes on any of them. The
 * two older sources are kept as fallbacks and nothing else: the ledger's
 * `run/start` line for runs written before the namespace existed, and the
 * execution registry for an installation with no storage provider.
 *
 * Shared by the run routes and by every other route that writes to a run's
 * ledger on behalf of a request (chat feedback), so the same check guards
 * every entry.
 *
 * @module services/loop/runAccess
 */
import logger from '../../utils/logger.js';
import runLog from './RunLog.js';
import { resolvePrincipal, isAnonymousUser, isAdminUser } from './runIdentity.js';
import { getExecutionRegistry } from '../workflow/ExecutionRegistry.js';
import { getRunSummaryRepository } from '../runtime/RunSummaryRepository.js';

/**
 * The run's summary, or null when the store cannot answer.
 *
 * A storage failure must not turn a request into a 500: the older records
 * below can still decide, and a run none of them vouches for is denied rather
 * than served.
 *
 * @param {string} runId
 * @returns {Promise<Object|null>}
 */
async function readRunSummary(runId) {
  try {
    return await getRunSummaryRepository().get(runId);
  } catch (error) {
    logger.warn('Run summary lookup failed; falling back to the older records', {
      component: 'RunAccess',
      runId,
      error: error.message
    });
    return null;
  }
}

/**
 * The execution's authorization facts: its owning principal, who triggered it
 * and when it started.
 *
 * The registry read stays as the fallback because it is the only source left
 * when storage is unavailable — a supported state — and because a run started
 * before the import has no summary yet.
 *
 * @param {string} executionId
 * @returns {Promise<{ownerId:string|null, kind:string|null, anonymous:boolean,
 *   startedAt:string|null, triggeredBy:Object|null}|null>} null when neither
 *   source knows the execution
 */
async function resolveExecutionRecord(executionId) {
  const summary = await readRunSummary(executionId);
  if (summary) {
    return {
      ownerId: typeof summary.ownerId === 'string' ? summary.ownerId : null,
      kind: summary.kind || null,
      anonymous: summary.anonymous === true,
      startedAt: summary.startedAt || null,
      triggeredBy: summary.triggeredBy || null
    };
  }
  let execution = null;
  try {
    execution = await getExecutionRegistry().get(executionId);
  } catch (error) {
    logger.warn('Execution registry lookup failed', {
      component: 'RunAccess',
      executionId,
      error: error.message
    });
  }
  if (!execution) return null;
  return {
    ownerId: typeof execution.userId === 'string' ? execution.userId : null,
    kind: null,
    anonymous: false,
    startedAt: execution.startedAt || null,
    triggeredBy: execution.triggeredBy || null
  };
}

/**
 * Authorize against the execution record (workflow / agent executions).
 * @returns {Promise<{ok:boolean, meta:Object}|null>} null when no execution
 *   record can decide
 */
export async function authorizeExecution(executionId, user) {
  if (!executionId || isAnonymousUser(user)) return null;
  const execution = await resolveExecutionRecord(executionId);
  if (!execution) return null;
  const userId = String(user.id);
  const { ownerId } = execution;
  const isAgentRun = typeof ownerId === 'string' && ownerId.startsWith('agent:');
  const allowed =
    isAdminUser(user) ||
    ownerId === userId ||
    (execution.triggeredBy && String(execution.triggeredBy.userId) === userId);
  if (!allowed) return null;
  return {
    ok: true,
    meta: {
      runId: executionId,
      kind: execution.kind || (isAgentRun ? 'agent' : 'workflow'),
      anonymous: execution.anonymous,
      startedAt: execution.startedAt,
      principalId: ownerId,
      refs: { executionId }
    }
  };
}

/**
 * Authorize against the run's own record: memory (this worker, then the
 * owning worker over the bus), then the `runs` namespace, then the persisted
 * `run/start` line.
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object}>}
 */
export async function authorizeLedgerRun(runId, user) {
  const mem = await runLog.resolveRunMeta(runId);
  let principalId = mem?.principalId ?? null;
  let anonymous = mem?.anonymous ?? null;
  let kind = mem?.kind ?? null;
  let startedAt = mem?.startedAt ?? null;
  let refs = mem?.refs ?? null;
  let identityMode = mem?.identityMode ?? null;
  if (principalId === null) {
    // One indexed document read, and it answers for runs this worker never
    // saw — which the per-worker memory never could.
    const summary = await readRunSummary(runId);
    if (summary?.ownerId) {
      principalId = summary.ownerId;
      anonymous = summary.anonymous === true;
      identityMode = summary.identityMode ?? null;
      kind = summary.kind ?? null;
      startedAt = summary.startedAt ?? null;
      refs = summary.refs || {};
    }
  }
  if (principalId === null) {
    // Runs written before the namespace existed: only the first line of the
    // run file is needed here.
    const start = await runLog.readStart(runId);
    if (!start) return { ok: false, status: 404 };
    principalId = start.data.principal?.id ?? null;
    anonymous = start.data.principal?.anonymous === true;
    identityMode = start.data.principal?.mode ?? null;
    kind = start.data.kind;
    startedAt = start.ts;
    refs = start.data.refs || {};
  }
  const meta = {
    runId,
    kind,
    anonymous,
    startedAt,
    principalId,
    refs: refs || {},
    /** Identity mode the run's principal was recorded in (actor ids on the run use the same). */
    identityMode: identityMode || null
  };
  if (isAdminUser(user) || anonymous) return { ok: true, meta };
  if (isAnonymousUser(user)) return { ok: false, status: 403 };
  // Resolve the caller in the mode the run's principal was recorded in — a run
  // written under `pseudonymized` keeps matching its owner after an admin
  // switches the global mode.
  const me = await resolvePrincipal(user, { mode: identityMode || runLog.identityMode() });
  if (me.id === principalId) return { ok: true, meta };
  return { ok: false, status: 403 };
}

/**
 * Decide whether `user` may access run `runId`: the run's own record first,
 * then its execution record.
 *
 * @param {string} runId
 * @param {Object} user - req.user
 * @param {Object} [opts]
 * @param {string} [opts.executionId] - execution to fall back to (default: runId)
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object}>}
 */
export async function authorizeRun(runId, user, { executionId } = {}) {
  const ledger = await authorizeLedgerRun(runId, user);
  if (ledger.ok) return ledger;
  return (await authorizeExecution(executionId || runId, user)) || ledger;
}

/**
 * Decide whether `user` may act on an interaction (answer or cancel it):
 * admins may; the principal recorded on the interaction's `source` (resolved
 * in that source's identity mode, so this works without the ledger and across
 * workers) may; an interaction of an anonymous run is settled by whoever holds
 * its ids, like the run itself; otherwise whoever may access the interaction's
 * run.
 *
 * @param {Object} interaction
 * @param {Object} user - req.user
 * @returns {Promise<boolean>}
 */
export async function authorizeInteraction(interaction, user) {
  if (!interaction || typeof interaction.runId !== 'string') return false;
  if (isAdminUser(user)) return true;
  const source = interaction.source || {};
  if (source.anonymous === true) return true;
  if (source.principalId && !isAnonymousUser(user)) {
    const me = await resolvePrincipal(user, {
      mode: source.identityMode || runLog.identityMode()
    });
    if (me.id === source.principalId) return true;
  }
  const access = await authorizeRun(interaction.runId, user, {
    executionId: source.executionId
  });
  return access.ok === true;
}
