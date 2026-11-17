// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Resume the call that stopped on a missing connection (intrafind/ihub-apps#3752).
 *
 * ## How it works
 *
 * 1. A tool returns `INTEGRATION_AUTH_REQUIRED` for its **own** installation
 *    *before* it reaches the vendor. The turn goes on as before: the model
 *    explains, the answer carries the Connect card. Additionally the chat
 *    turn keeps what the resume needs on the chat document as
 *    `pendingConnect` ({@link buildPendingConnect}): the failed calls of that
 *    step (taken from the loop's own call objects, never from a tool result),
 *    the bounded transcript up to the end of that step, the turn's question
 *    and the sources it had used.
 * 2. After the connect the client sends one chat message that carries
 *    `connectResume { id }` and nothing else (no tool id, no arguments).
 *    {@link prepareConnectResume} checks it without changing anything; the
 *    route calls `commit()` once the turn is prepared, which takes the record
 *    off the chat (compare-and-set under the chat lock): of two requests (a
 *    double click, a second tab, two workers) exactly one gets it.
 * 3. The continuation turn runs the stored calls through the seams (the
 *    approval policy and the chat's scope apply again; a call that needs
 *    approval asks) and the model continues from the results. No user message
 *    is stored; the answer is a new assistant message.
 *
 * At most once beats at least once: the record is taken before the loop runs,
 * and a turn refused **before** its loop starts puts it back (`restore()`);
 * after that it is never put back, because a write may have happened.
 *
 * Any other message to the chat supersedes the record. It expires after
 * {@link CONNECT_RESUME_TTL_MS}. It only exists for a stored chat of a signed-in
 * owner; scheduled tasks, workflows, agent runs and the inference API never
 * create one.
 *
 * @module services/chat/chatConnectResume
 */
import crypto from 'node:crypto';
import logger from '../../utils/logger.js';
import { pausedTurnQuestion, pausedTurnTranscript } from './chatToolApproval.js';
import { boundCarriedBasis } from './answerBasis.js';
import { logAudit } from '../AuditLogService.js';

const COMPONENT = 'ChatConnectResume';

/** How long a failed call waits for its connection (the time of an OAuth consent). */
export const CONNECT_RESUME_TTL_MS = 15 * 60 * 1000;
/** Most calls one record holds; a step with more is not resumable. */
export const MAX_CONNECT_CALLS = 5;
/** Longest serialized arguments of one stored call. */
export const MAX_CONNECT_ARGS_CHARS = 16 * 1024;
/** Resume requests one user may make per window. */
export const RESUME_LIMIT = 10;
const RESUME_WINDOW_MS = 60 * 1000;

const NOT_PENDING = Object.freeze({
  status: 409,
  code: 'CONNECT_RESUME_NOT_PENDING',
  message: 'Nothing is waiting to be continued in this chat (already continued, or superseded)'
});

/**
 * Whether the arguments of a call are kept whole: a plain object that
 * serializes within the bound. Anything else is never stored (the resume
 * must not run a call with arguments other than the ones that failed).
 *
 * @param {unknown} args
 * @returns {boolean}
 */
function argsKeptWhole(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  try {
    return JSON.stringify(args).length <= MAX_CONNECT_ARGS_CHARS;
  } catch {
    return false;
  }
}

/**
 * The transcript of the step that made the calls: the turn's messages from
 * its question to the end of the tool block of the **last** call, later steps
 * left out (the model decides again once it has the real results).
 *
 * @param {Array<Object>} messages - `result.messages` of the finished loop
 * @param {Object|null} startMessage
 * @param {string} firstCallId
 * @param {string} lastCallId
 * @returns {Array<Object>|null}
 */
function stepTranscript(messages, startMessage, firstCallId, lastCallId) {
  const bounded = pausedTurnTranscript(messages, { startMessage, toolCallId: firstCallId });
  if (!bounded) return null;
  const stepAt = bounded.findIndex(
    m =>
      m?.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some(c => c?.id === lastCallId)
  );
  if (stepAt < 0) return null;
  let end = stepAt + 1;
  while (end < bounded.length && bounded[end]?.role === 'tool') end++;
  return bounded.slice(0, end);
}

/**
 * The record to keep on the chat for the calls a finished turn left waiting
 * for a connection, or null when it is not resumable (fail closed).
 *
 * @param {Object} params
 * @param {string} params.runId - The run whose answer carries the card
 * @param {Array<{id: string, name: string, toolId: string, integration: string,
 *   reason: string, args: Object}>} params.calls - From `chatToolSeam` (`connectCalls`)
 * @param {Array<Object>} params.messages - `result.messages` of the loop
 * @param {Object|null} params.startMessage - The last message the turn started with
 * @param {Object|null} [params.basis] - What the turn had used
 * @param {string[]} [params.continues] - Run ids of the earlier answers this turn continues
 * @param {Date} [params.now]
 * @returns {Object|null}
 */
export function buildPendingConnect({
  runId,
  calls,
  messages,
  startMessage,
  basis = null,
  continues = [],
  now
}) {
  const list = Array.isArray(calls) ? calls : [];
  if (!runId || list.length === 0 || list.length > MAX_CONNECT_CALLS) return null;
  if (!list.every(c => c?.id && c.toolId && c.integration && argsKeptWhole(c.args))) return null;
  // Anything the turn did after the failed step is not part of the stored
  // transcript: a later call that ran (a write) would be unknown to the
  // continuation, which could then do it again. Not resumable.
  const stepAt = messages.findLastIndex(
    m =>
      m?.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some(c => c?.id === list.at(-1).id)
  );
  if (stepAt < 0) return null;
  let afterStep = stepAt + 1;
  while (messages[afterStep]?.role === 'tool') afterStep++;
  if (messages.slice(afterStep).some(m => m?.role === 'tool')) return null;
  const transcript = stepTranscript(messages, startMessage, list[0].id, list.at(-1).id);
  if (!transcript) return null;
  // A transcript call whose arguments were cut is not the call that failed.
  const stored = transcript.flatMap(m => (Array.isArray(m.tool_calls) ? m.tool_calls : []));
  for (const call of list) {
    const found = stored.find(c => c?.id === call.id);
    if (!found || String(found.function?.arguments || '').includes('"_truncated"')) return null;
  }
  const created = now instanceof Date ? now : new Date();
  return {
    id: crypto.randomBytes(16).toString('hex'),
    runId,
    // The answers of the earlier runs this one continues (a resume that failed
    // again): all of them leave the prompt of the next resume.
    continues: (Array.isArray(continues) ? continues : [])
      .filter(id => typeof id === 'string')
      .slice(-5),
    integrations: [...new Set(list.map(c => c.integration))],
    calls: list.map(c => ({
      id: String(c.id),
      name: String(c.name || c.toolId),
      toolId: String(c.toolId),
      integration: String(c.integration),
      reason: String(c.reason || 'not_connected'),
      args: c.args
    })),
    transcript,
    question: pausedTurnQuestion(startMessage),
    ...(basis ? { basis: boundCarriedBasis(basis) } : {}),
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + CONNECT_RESUME_TTL_MS).toISOString()
  };
}

/**
 * The stored record as the client may see it: no arguments, no transcript.
 *
 * @param {Object|null} record
 * @returns {{id: string, integrations: string[], callIds: string[], expiresAt: string}|null}
 */
export function publicPendingConnect(record, now = Date.now()) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string') return null;
  // An expired record is not offered: nothing will run for it.
  if (!record.expiresAt || Date.parse(record.expiresAt) <= now) return null;
  return {
    id: record.id,
    integrations: Array.isArray(record.integrations) ? record.integrations.map(String) : [],
    callIds: Array.isArray(record.calls) ? record.calls.map(c => String(c.id)) : [],
    expiresAt: record.expiresAt || null
  };
}

/**
 * The `connectResume` of a chat message, validated, or null.
 *
 * @param {unknown} raw
 * @returns {{id: string}|null}
 */
export function parseConnectResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  return /^[0-9a-f]{32}$/.test(id) ? { id } : null;
}

/**
 * The messages of the continuation turn: the prepared history (which ends
 * with the turn's question) followed by the stored transcript. The failed
 * results stay in the transcript as placeholders; the loop replaces each with
 * the result of the call it runs.
 *
 * @param {Array<Object>} llmMessages
 * @param {Array<Object>} transcript
 * @param {{question?: string|null}} [options]
 * @returns {Array<Object>}
 */
export function connectResumeMessages(llmMessages, transcript, { question = null } = {}) {
  const out = [...(Array.isArray(llmMessages) ? llmMessages : [])];
  if (!out.some(m => m?.role === 'user') && typeof question === 'string' && question) {
    out.push({ role: 'user', content: question });
  }
  for (const message of Array.isArray(transcript) ? transcript : []) out.push({ ...message });
  return out;
}

/** What the loop's `resume.toolCalls` takes for the stored calls of one integration. */
export function loopResumeOf(calls) {
  return {
    toolCalls: calls.map(call => ({
      toolCall: {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
      },
      args: call.args || {}
    }))
  };
}

/** Remove the record from the chat; never fatal. */
async function dropRecord(repository, chatId) {
  try {
    await repository?.updateChat?.(chatId, { pendingConnect: null });
  } catch (err) {
    logger.warn('The pending call could not be removed from the chat', {
      component: COMPONENT,
      chatId,
      error: err.message
    });
  }
}

const resumeHits = new Map();

/**
 * Per-user limit on resume requests (each costs a model turn and a vendor
 * call; refused ones count too).
 *
 * @param {string} userId
 * @param {number} [now]
 * @returns {boolean} whether the request may go on
 */
export function admitResume(userId, now = Date.now()) {
  const recent = (resumeHits.get(userId) || []).filter(t => now - t < RESUME_WINDOW_MS);
  recent.push(now);
  resumeHits.set(userId, recent);
  if (resumeHits.size > 5000) {
    for (const [key, times] of resumeHits) {
      if (!times.some(t => now - t < RESUME_WINDOW_MS)) resumeHits.delete(key);
    }
  }
  return recent.length <= RESUME_LIMIT;
}

/** Test seam. */
export function resetResumeLimitForTests() {
  resumeHits.clear();
}

/**
 * The `commit()` of a prepared resume: take the record once and hand over what
 * the continuation needs (see {@link prepareConnectResume}).
 * @private
 */
function makeCommit({ repository, chatId, stored, user, connectedIntegration, req, audit }) {
  return async () => {
    // Exactly one request takes the record off the chat.
    const taken = await repository.takePendingConnect(chatId, stored.id);
    if (!taken) return { resume: null, refusal: { ...NOT_PENDING }, restore: null };
    if (taken.expired) {
      return {
        resume: null,
        refusal: {
          status: 410,
          code: 'CONNECT_RESUME_EXPIRED',
          message: 'The request waited too long for the connection; ask again'
        },
        restore: null
      };
    }
    const calls = taken.calls.filter(c => c.integration === connectedIntegration);
    // The connect itself is audited (`connection.create`); this is the call
    // that ran because of it, on the user's behalf. Ids only, never arguments.
    audit({
      req,
      action: 'execute',
      resource: 'connection',
      resourceId: `${connectedIntegration}:${user.id}`,
      summary: `Resumed ${calls.length} call(s) of ${connectedIntegration} after a connect`,
      details: {
        event: 'connection.resume',
        chatId,
        recordId: taken.id,
        integration: connectedIntegration,
        toolIds: calls.map(c => c.toolId)
      }
    });
    logger.info('Chat call resumed after a connect', {
      component: COMPONENT,
      chatId,
      recordId: taken.id,
      userId: user.id,
      integration: connectedIntegration,
      toolIds: calls.map(c => c.toolId)
    });
    return {
      refusal: null,
      resume: {
        id: taken.id,
        runId: taken.runId,
        // Every answer that leaves the prompt: this run's and the ones it continued.
        answerRunIds: [...(Array.isArray(taken.continues) ? taken.continues : []), taken.runId],
        integration: connectedIntegration,
        calls,
        transcript: Array.isArray(taken.transcript) ? taken.transcript : [],
        question: typeof taken.question === 'string' ? taken.question : null,
        basis: boundCarriedBasis(taken.basis)
      },
      // A turn refused before its loop started puts the record back so the
      // same request can be sent again. Never after the loop started.
      restore: async () => {
        try {
          return await repository.restorePendingConnect(chatId, taken);
        } catch (err) {
          logger.warn('The pending call could not be put back after a refused turn', {
            component: COMPONENT,
            chatId,
            recordId: taken.id,
            error: err.message
          });
          return false;
        }
      }
    };
  };
}

/** The first of the record's integrations the user has a usable connection for, or null. */
async function firstConnected(userId, integrations, isConnected) {
  for (const integration of integrations) {
    if (await isConnected(userId, integration)) return integration;
  }
  return null;
}

/**
 * Check a `connectResume` message without changing anything, and drop a
 * record that any other message supersedes.
 *
 * Checks, in this order: shape → the chat's owner is the user (a shared
 * viewer never resumes) → a record is pending and is the one named (a foreign
 * or unknown id looks like "nothing pending") → same app → not expired → the
 * acting user's connection for the integration is usable now (else the record
 * is **kept** and the card stays).
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {Object} params.user
 * @param {string} params.appId
 * @param {Object|null} params.chat - the chat document
 * @param {string} params.ownerId - the chat owner as the request resolves it
 * @param {Object|null} params.lastMessage - the message of this POST
 * @param {Object} params.repository - ChatRepository
 * @param {(userId: string, integration: string) => Promise<boolean>} params.isConnected
 * @param {Object} [params.req] - The request, for the audit entry's actor and source
 * @param {Function} [params.audit] - Audit writer (default `logAudit`), a test seam
 * @param {Date} [params.now]
 * @returns {Promise<{refusal: Object|null, record: Object|null,
 *   commit: (() => Promise<{resume: Object|null, refusal: Object|null, restore: Function|null}>)|null}>}
 */
export async function prepareConnectResume({
  chatId,
  user,
  appId,
  chat,
  ownerId,
  lastMessage,
  repository,
  isConnected,
  req = null,
  audit = logAudit,
  now = new Date()
}) {
  const result = { refusal: null, record: null, commit: null };
  const stored =
    chat?.pendingConnect && typeof chat.pendingConnect === 'object' ? chat.pendingConnect : null;
  const raw = lastMessage?.connectResume;

  if (raw === undefined) {
    // Any other message supersedes the record: the question has moved on.
    if (stored) await dropRecord(repository, chatId);
    return result;
  }

  const request = parseConnectResume(raw);
  if (!request || lastMessage?.approvalResponse !== undefined) {
    result.refusal = {
      status: 400,
      code: 'INVALID_CONNECT_RESUME',
      message: 'connectResume needs the id of the pending call'
    };
    return result;
  }
  if (!user?.id || user.id === 'anonymous' || !ownerId || ownerId !== chat?.ownerId) {
    // The same answer as an unknown record: no oracle for another user's chat.
    result.refusal = { ...NOT_PENDING };
    return result;
  }
  if (!admitResume(String(user.id))) {
    result.refusal = {
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Too many attempts to continue; try again in a minute'
    };
    return result;
  }
  if (stored?.id !== request.id || (chat?.appId && appId && chat.appId !== appId)) {
    result.refusal = { ...NOT_PENDING };
    return result;
  }
  if (!stored.expiresAt || Date.parse(stored.expiresAt) <= now.getTime()) {
    await dropRecord(repository, chatId);
    result.refusal = {
      status: 410,
      code: 'CONNECT_RESUME_EXPIRED',
      message: 'The request waited too long for the connection; ask again'
    };
    return result;
  }
  const connectedIntegration = await firstConnected(
    String(user.id),
    Array.isArray(stored.integrations) ? stored.integrations : [],
    isConnected
  );
  if (!connectedIntegration) {
    result.refusal = {
      status: 409,
      code: 'CONNECT_RESUME_NOT_CONNECTED',
      message: 'The integration is not connected yet'
    };
    return result;
  }

  result.record = stored;
  result.commit = makeCommit({
    repository,
    chatId,
    stored,
    user,
    connectedIntegration,
    req,
    audit
  });
  return result;
}
