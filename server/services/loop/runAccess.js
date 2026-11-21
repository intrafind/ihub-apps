// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Run access: who may do what with a run (concept §5.4).
 *
 * Every check names what the caller is about to do, its **intent**. There is
 * no default: a call without a known intent throws, so a new route cannot
 * inherit the widest rule by leaving the argument out.
 *
 * | Intent     | Owner | Admin who is not the owner      | Anonymous run, id only |
 * | ---------- | ----- | ------------------------------- | ---------------------- |
 * | `read`     | yes   | yes                             | yes                    |
 * | `stop`     | yes   | yes (`viaAdmin`, audited)       | no                     |
 * | `delete`   | yes   | yes (`viaAdmin`, audited)       | no                     |
 * | `feedback` | yes   | no                              | no                     |
 * | `answer`   | yes   | only for a run of no person     | no                     |
 * | `steer`    | yes   | no                              | no                     |
 * | `rerun`    | yes   | no                              | no                     |
 *
 * **Owner.** The recorded principal, resolved in the identity mode the run
 * was written in. `steer` and `rerun` speak in the owner's voice, so they
 * also need the write right on the run's chat when one is stored
 * (`authorizeChat(..., { intent: 'write' })`), and the person who triggered an
 * agent run does not count for them.
 *
 * **Anonymous run.** Its principal is a random id that nobody can present
 * again, so its owner is the guest who owns the run's chat: the caller whose
 * guest cookie hashes to the chat's `ownerId`. Reading stays possible for
 * whoever holds the run id. A run of an anonymous caller without a stored chat
 * has no owner anybody can prove to be, and only an admin stops or deletes it.
 *
 * **Admin.** An admin reads every run and may stop or delete it; the decision
 * is marked `viaAdmin` so the route writes it to the audit log. Through this
 * module an admin never steers, re-runs, rates or answers in somebody else's
 * name.
 *
 * **Where this holds.** In the routes that ask this module: `/api/runs/*`,
 * `/api/interactions/pending`, the chat routes that answer an approval or a
 * question, `POST /api/feedback` and the approval of an MCP app view's call.
 * Two older surfaces keep a check of their own and are NOT covered: the
 * workflow execution routes (`/api/workflows/executions/:executionId/_cancel`,
 * `/_restart` and `DELETE`, `loadOwnedExecution`) and the agent run routes
 * (`/api/agents/runs/:runId/_cancel` and `/_resume`). There an admin still
 * cancels, restarts, resumes and deletes somebody else's run, and nothing is
 * written to the audit log.
 *
 * **A run of no person.** A run whose principal is an agent's own identity
 * (`agent:<profileId>`) or the system principal of a triggered workflow has no
 * person who could answer its questions, and an answer continues it with that
 * identity's rights, not with a user's. An admin answers those, as before; the
 * person who triggered an agent run does too.
 *
 * Workflow executions and agent runs the ledger does not know (persistence
 * off, or a run restored from a checkpoint before it was re-registered) are
 * authorized against their execution record: the launching principal or, for
 * agent runs, the human who triggered the run. The execution record adds
 * callers (whoever triggered an agent run); it never overrules a refusal that
 * rests on the run's chat or on the guest of an anonymous run, and it applies
 * the chat rule of `steer` and `rerun` itself.
 *
 * Both checks read the `runs` namespace, the shared, owner-indexed record of
 * every run, so a run started on one worker authorizes on any of them. The
 * two older sources are kept as fallbacks and nothing else: the ledger's
 * `run/start` line for runs written before the namespace existed, and the
 * execution registry for an installation with no storage provider.
 *
 * Shared by the run routes and by every other route that writes to a run's
 * ledger on behalf of a request (chat feedback), so the same check guards
 * every entry. `server/tests/routeInventory.table.js` lists each route with
 * its intent.
 *
 * @module services/loop/runAccess
 */
import logger from '../../utils/logger.js';
import runLog from './RunLog.js';
import { resolvePrincipal, isAnonymousUser } from './runIdentity.js';
import { isAdmin } from '../../utils/authorization.js';
import { getExecutionRegistry } from '../workflow/ExecutionRegistry.js';
import { getRunSummaryRepository } from '../runtime/RunSummaryRepository.js';
import { authorizeChat } from '../chat/chatAccess.js';

/** The principal of a workflow run a trigger started (`TriggerManager`). */
const SYSTEM_PRINCIPAL_ID = 'system';

/** Prefix of an agent's own identity (`buildAgentPrincipal`). */
const AGENT_PRINCIPAL_PREFIX = 'agent:';

/**
 * The rule of one intent: what it lets through besides the owner.
 *
 * @param {Object} [allow]
 * @param {boolean} [allow.admin] - an admin who is not the owner passes (marked `viaAdmin`)
 * @param {boolean} [allow.adminOfNoPerson] - an admin passes for a run that belongs to no
 *   person (an agent's own identity, the system principal of a triggered run)
 * @param {boolean} [allow.idHolder] - whoever holds the id of an anonymous run passes
 * @param {boolean} [allow.triggeredBy] - the human who triggered an agent run counts as its owner
 * @param {boolean} [allow.chatWrite] - the owner also needs the write right on the run's chat
 * @returns {Readonly<{admin: boolean, adminOfNoPerson: boolean, idHolder: boolean,
 *   triggeredBy: boolean, chatWrite: boolean}>}
 */
function intentRule({
  admin = false,
  adminOfNoPerson = false,
  idHolder = false,
  triggeredBy = false,
  chatWrite = false
} = {}) {
  return Object.freeze({ admin, adminOfNoPerson, idHolder, triggeredBy, chatWrite });
}

const RUN_INTENT_RULES = Object.freeze({
  read: intentRule({ admin: true, idHolder: true, triggeredBy: true }),
  stop: intentRule({ admin: true, triggeredBy: true }),
  delete: intentRule({ admin: true, triggeredBy: true }),
  feedback: intentRule({ triggeredBy: true }),
  answer: intentRule({ adminOfNoPerson: true, triggeredBy: true }),
  steer: intentRule({ chatWrite: true }),
  rerun: intentRule({ chatWrite: true })
});

/** The intents `authorizeRun` knows. */
export const RUN_INTENTS = Object.freeze(Object.keys(RUN_INTENT_RULES));

/** The intents `authorizeInteraction` knows. */
export const INTERACTION_INTENTS = Object.freeze(['read', 'answer', 'cancel']);

/**
 * The rule of a run intent. A missing or unknown intent is a programming
 * error and throws: an access check never falls back to `read`.
 *
 * @param {unknown} intent
 * @returns {ReturnType<typeof intentRule>}
 * @throws {TypeError} when `intent` is not one of {@link RUN_INTENTS}
 */
function runIntentRule(intent) {
  if (typeof intent !== 'string' || !Object.hasOwn(RUN_INTENT_RULES, intent)) {
    throw new TypeError(
      `Run access needs an intent (${RUN_INTENTS.join(', ')}); got ${JSON.stringify(intent ?? null)}`
    );
  }
  return RUN_INTENT_RULES[intent];
}

/**
 * A known interaction intent, as it was passed. A missing or unknown intent is
 * a programming error and throws, like {@link runIntentRule}.
 *
 * @param {unknown} intent
 * @returns {string} one of {@link INTERACTION_INTENTS}
 * @throws {TypeError} when `intent` is not one of them
 */
function interactionIntent(intent) {
  if (typeof intent !== 'string' || !INTERACTION_INTENTS.includes(intent)) {
    throw new TypeError(
      `Interaction access needs an intent (${INTERACTION_INTENTS.join(', ')}); got ${JSON.stringify(intent ?? null)}`
    );
  }
  return intent;
}

/**
 * Whether `user` may write the chat a run belongs to, as that chat's owner.
 *
 * A storage failure is a refusal, not an error: the caller is asking to act,
 * and an owner nobody could read is not proven.
 *
 * @param {string} chatId
 * @param {Object} user
 * @returns {Promise<{stored: boolean, owner: boolean}>} `stored` is false when
 *   no chat document exists for the id
 */
async function chatOwnership(chatId, user) {
  try {
    const access = await authorizeChat(chatId, user, { intent: 'write' });
    if (!access.ok) return { stored: true, owner: false };
    return { stored: Boolean(access.chat), owner: Boolean(access.chat) };
  } catch (error) {
    logger.warn('Chat owner lookup failed; the run action is refused', {
      component: 'RunAccess',
      chatId,
      error: error.message
    });
    return { stored: true, owner: false };
  }
}

/**
 * Whether a recorded principal is no person: the system principal of a
 * triggered run, or the own identity of the agent the run belongs to.
 *
 * The comparison is made in the identity mode the principal was recorded in,
 * so it holds for a pseudonymized ledger too, where the stored id is a hash.
 *
 * @param {unknown} principalId - the principal as the run or the interaction records it
 * @param {Object} [options]
 * @param {string|null} [options.identityMode] - the mode it was recorded in
 * @param {unknown} [options.profileId] - the agent profile the run belongs to, when it has one
 * @returns {Promise<boolean>}
 */
async function isPrincipalOfNoPerson(principalId, { identityMode, profileId } = {}) {
  if (typeof principalId !== 'string' || !principalId) return false;
  const mode = identityMode || runLog.identityMode();
  const candidates = [{ id: SYSTEM_PRINCIPAL_ID }];
  if (typeof profileId === 'string' && profileId) {
    candidates.push({ id: `${AGENT_PRINCIPAL_PREFIX}${profileId}`, isAgent: true });
  }
  for (const candidate of candidates) {
    if ((await resolvePrincipal(candidate, { mode })).id === principalId) return true;
  }
  return false;
}

/**
 * Whether `user` owns the run described by `meta`.
 *
 * A refusal is `final` when it rests on a fact the execution record cannot
 * check: the run is anonymous (its owner is proven by the chat alone), or the
 * caller is the run's principal and the run's chat is stored for somebody
 * else. The execution record must not turn such a refusal into a grant.
 *
 * @param {Object} meta - the run's record (`principalId`, `anonymous`, `identityMode`, `refs`)
 * @param {Object} user - req.user
 * @param {Object} rule - the intent's rule
 * @returns {Promise<{owner: boolean, final: boolean}>}
 */
async function ledgerOwnership(meta, user, rule) {
  const chatId =
    typeof meta.refs?.chatId === 'string' && meta.refs.chatId ? meta.refs.chatId : null;
  if (meta.anonymous) {
    // Nobody can present the random principal of an anonymous run again. Its
    // owner is the guest who owns its chat; without a stored chat there is none.
    if (!chatId) return { owner: false, final: true };
    return { owner: (await chatOwnership(chatId, user)).owner, final: true };
  }
  if (isAnonymousUser(user)) return { owner: false, final: false };
  // Resolve the caller in the mode the run's principal was recorded in: a run
  // written under `pseudonymized` keeps matching its owner after an admin
  // switches the global mode.
  const me = await resolvePrincipal(user, { mode: meta.identityMode || runLog.identityMode() });
  if (me.id !== meta.principalId) return { owner: false, final: false };
  if (!rule.chatWrite || !chatId) return { owner: true, final: false };
  // A chat that is stored and somebody else's refuses; one that is not stored
  // (a headless chat id, a deleted chat) leaves the principal as the owner.
  const chat = await chatOwnership(chatId, user);
  return { owner: chat.owner || !chat.stored, final: true };
}

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
 *   startedAt:string|null, triggeredBy:Object|null, chatId:string|null}|null>} null when
 *   neither source knows the execution
 */
async function resolveExecutionRecord(executionId) {
  const summary = await readRunSummary(executionId);
  if (summary) {
    return {
      ownerId: typeof summary.ownerId === 'string' ? summary.ownerId : null,
      kind: summary.kind || null,
      anonymous: summary.anonymous === true,
      startedAt: summary.startedAt || null,
      triggeredBy: summary.triggeredBy || null,
      chatId:
        typeof summary.refs?.chatId === 'string' && summary.refs.chatId ? summary.refs.chatId : null
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
    triggeredBy: execution.triggeredBy || null,
    chatId: null
  };
}

/**
 * Authorize against the execution record (workflow / agent executions).
 *
 * @param {string} executionId
 * @param {Object} user - req.user
 * @param {Object} opts
 * @param {string} opts.intent - one of {@link RUN_INTENTS}; mandatory
 * @returns {Promise<{ok:boolean, meta:Object, viaAdmin?:boolean}|null>} null when no execution
 *   record can decide
 */
export async function authorizeExecution(executionId, user, { intent } = {}) {
  const rule = runIntentRule(intent);
  if (!executionId || isAnonymousUser(user)) return null;
  const execution = await resolveExecutionRecord(executionId);
  if (!execution) return null;
  const userId = String(user.id);
  const { ownerId } = execution;
  const isAgentRun = typeof ownerId === 'string' && ownerId.startsWith(AGENT_PRINCIPAL_PREFIX);
  let owner =
    ownerId === userId ||
    (rule.triggeredBy &&
      Boolean(execution.triggeredBy) &&
      String(execution.triggeredBy.userId) === userId);
  // The same chat rule as on the run's own record: an intent that speaks in the
  // run's chat is refused when that chat is stored for somebody else. The
  // summary of a chat run is an execution record too, so without this the
  // record would grant what the ledger check has just refused.
  if (owner && rule.chatWrite && execution.chatId) {
    const chat = await chatOwnership(execution.chatId, user);
    owner = chat.owner || !chat.stored;
  }
  // The registry and the summary of an execution hold the launching principal
  // as it is, so an agent's own identity and the system principal show.
  const ofNoPerson = isAgentRun || ownerId === SYSTEM_PRINCIPAL_ID;
  const viaAdmin = !owner && isAdmin(user) && (rule.admin || (rule.adminOfNoPerson && ofNoPerson));
  if (!owner && !viaAdmin) return null;
  return {
    ok: true,
    ...(viaAdmin ? { viaAdmin: true } : {}),
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
 * The decision of the run's own record, with what {@link authorizeRun} needs
 * to know about a refusal.
 *
 * @param {string} runId
 * @param {Object} user - req.user
 * @param {ReturnType<typeof intentRule>} rule - the intent's rule
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object, viaAdmin?:boolean,
 *   final?:boolean}>} `final` marks a 403 the execution record must not overrule
 */
async function decideLedgerRun(runId, user, rule) {
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
  const ownership = await ledgerOwnership(meta, user, rule);
  if (ownership.owner) return { ok: true, meta };
  if (rule.admin && isAdmin(user)) return { ok: true, meta, viaAdmin: true };
  if (
    rule.adminOfNoPerson &&
    isAdmin(user) &&
    !anonymous &&
    (await isPrincipalOfNoPerson(principalId, { identityMode, profileId: meta.refs.profileId }))
  ) {
    return { ok: true, meta, viaAdmin: true };
  }
  // Reading an anonymous run stays possible for whoever holds its random id.
  if (rule.idHolder && anonymous) return { ok: true, meta };
  return { ok: false, status: 403, final: ownership.final };
}

/**
 * Authorize against the run's own record: memory (this worker, then the
 * owning worker over the bus), then the `runs` namespace, then the persisted
 * `run/start` line.
 *
 * @param {string} runId
 * @param {Object} user - req.user
 * @param {Object} opts
 * @param {string} opts.intent - one of {@link RUN_INTENTS}; mandatory
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object, viaAdmin?:boolean}>}
 *   `viaAdmin` marks a decision that rests on admin rights and not on ownership.
 */
export async function authorizeLedgerRun(runId, user, { intent } = {}) {
  const decision = await decideLedgerRun(runId, user, runIntentRule(intent));
  return decision.ok ? decision : { ok: false, status: decision.status };
}

/**
 * Decide whether `user` may do `intent` with run `runId`: the run's own record
 * first, then its execution record.
 *
 * @param {string} runId
 * @param {Object} user - req.user
 * @param {Object} opts
 * @param {string} opts.intent - one of {@link RUN_INTENTS}; mandatory, a call
 *   without it throws
 * @param {string} [opts.executionId] - execution to fall back to (default: runId)
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object, viaAdmin?:boolean}>}
 * @throws {TypeError} when `intent` is missing or unknown
 */
export async function authorizeRun(runId, user, { intent, executionId } = {}) {
  const ledger = await decideLedgerRun(runId, user, runIntentRule(intent));
  // A read that rests on admin rights has no side effect to tell apart, so it
  // is not worth the second lookup below.
  if (ledger.ok && (!ledger.viaAdmin || intent === 'read')) return ledger;
  // The execution record adds callers: who launched a run, who triggered it.
  // A refusal that rests on the run's chat, or on the guest behind an
  // anonymous run, is not its to overrule: it stands, and the record is not
  // asked.
  if (ledger.final) return { ok: false, status: 403 };
  const execution = await authorizeExecution(executionId || runId, user, { intent });
  if (!ledger.ok) return execution || { ok: false, status: ledger.status };
  // An admin who triggered the run stops or deletes it as its owner, not as an
  // admin: that is not an entry for the audit log.
  if (execution && !execution.viaAdmin) return { ok: true, meta: ledger.meta };
  return ledger;
}

/**
 * Decide whether `user` may do `intent` with an interaction.
 *
 * - `read`: admins; the principal recorded on the interaction's `source`
 *   (resolved in that source's identity mode, so this works without the ledger
 *   and across workers); whoever holds the ids of an anonymous run's
 *   interaction; otherwise whoever may read the interaction's run.
 * - `answer`: the owner of the run and nobody else. The answer continues the
 *   run with the owner's rights, so an admin does not give it. For an
 *   anonymous run the owner is the guest who owns the run's chat. A run of no
 *   person (an agent's own identity, a triggered workflow's system principal)
 *   is the exception: an admin answers its interactions.
 * - `cancel`: the owner, and an admin. No route cancels in an admin's name
 *   yet; a chat message that supersedes a question or an approval is its
 *   owner's own and takes `answer`.
 *
 * Approver groups are not decided here: an interaction that names them is
 * answered by their members (`InteractionService.assertCanAnswer`).
 *
 * @param {Object} interaction
 * @param {Object} user - req.user
 * @param {Object} opts
 * @param {string} opts.intent - one of {@link INTERACTION_INTENTS}; mandatory,
 *   a call without it throws
 * @returns {Promise<boolean>}
 * @throws {TypeError} when `intent` is missing or unknown
 */
export async function authorizeInteraction(interaction, user, opts = {}) {
  const intent = interactionIntent(opts.intent);
  if (!interaction || typeof interaction.runId !== 'string') return false;
  const source = interaction.source || {};
  if (intent !== 'answer' && isAdmin(user)) return true;
  if (source.anonymous === true) {
    if (intent === 'read') return true;
    // The guest who owns the chat the interaction was raised in.
    if (typeof source.chatId === 'string' && source.chatId) {
      if ((await chatOwnership(source.chatId, user)).owner) return true;
    }
  } else if (source.principalId && !isAnonymousUser(user)) {
    const me = await resolvePrincipal(user, {
      mode: source.identityMode || runLog.identityMode()
    });
    if (me.id === source.principalId) return true;
    // The interaction outlives the run's record, so what it says about its
    // run decides here as well: a run of no person is answered by an admin.
    if (
      intent === 'answer' &&
      isAdmin(user) &&
      (await isPrincipalOfNoPerson(source.principalId, {
        identityMode: source.identityMode,
        profileId: source.profileId
      }))
    ) {
      return true;
    }
  }
  const access = await authorizeRun(interaction.runId, user, {
    intent: intent === 'read' ? 'read' : 'answer',
    executionId: source.executionId
  });
  return access.ok === true;
}
