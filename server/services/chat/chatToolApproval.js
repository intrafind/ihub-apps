// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool approval in a stored chat (intrafind/ihub-apps#2945).
 *
 * ## How a turn pauses and continues
 *
 * 1. The approval seam stops a gated call: an `approval` interaction is
 *    raised (`interaction/raised`), the loop's transcript gets an
 *    `awaiting_approval` tool message for it, and the turn ends paused.
 * 2. The stored chat transcript only holds user and assistant *text*: tool
 *    calls and tool results are never written to it (`historyForPrompt`
 *    reads `role` + `content`). So the part of the paused turn the model
 *    needs to continue — its tool-call messages and their results, including
 *    the placeholder — is kept on the chat document as
 *    `toolApproval.pending` ({@link pausedTurnTranscript}, bounded).
 * 3. The person answers with the next chat POST, whose single message carries
 *    `approvalResponse { interactionId, decision, grant? }`.
 *    {@link prepareChatApproval} checks it without changing anything; once the
 *    turn is prepared, its `commit()` answers the interaction (exactly once: a
 *    second answer is refused), takes `pending` off the chat (compare-and-set,
 *    `ChatRepository.takeToolApproval`) and, with `grant: 'chat'`, records the
 *    tool in `toolApproval.grants`. A turn refused before its loop starts puts
 *    the approval back with its answer (`restore()`), so the same decision can
 *    be sent again. An approval the sweeper expired or cancelled continues as
 *    `APPROVAL_EXPIRED`.
 * 4. The continuation turn takes the stored transcript instead of the
 *    decision message ({@link continuationMessages}). On approve the loop
 *    runs the stored call with the approved arguments (`AgentLoop` `resume`)
 *    and its result replaces the placeholder; on reject or expiry the
 *    placeholder becomes `USER_REJECTED` / `APPROVAL_EXPIRED`
 *    ({@link replaceToolResult}). Then the model continues.
 *
 * Any other message to the chat supersedes a pending approval: the
 * interaction is cancelled and the stored transcript dropped, so the call
 * never runs.
 *
 * @module services/chat/chatToolApproval
 */
import logger from '../../utils/logger.js';
import defaultInteractionService from '../loop/InteractionService.js';
import { authorizeInteraction as defaultAuthorizeInteraction } from '../loop/runAccess.js';
import { APPROVAL_DECISIONS, APPROVAL_GRANTS } from '../../../shared/toolApproval.js';
import { boundCarriedBasis } from './answerBasis.js';

const COMPONENT = 'ChatToolApproval';

/** Longest single message content kept in a stored paused transcript. */
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 16 * 1024;
/** Content length a message is cut to when the whole transcript is too long. */
export const TIGHT_TRANSCRIPT_MESSAGE_CHARS = 2 * 1024;
/** Upper bound for a stored paused transcript (serialized). */
export const MAX_TRANSCRIPT_CHARS = 192 * 1024;
/** Tool ids one chat can hold an "allow for this chat" grant for. */
export const MAX_CHAT_GRANTS = 50;

/**
 * True for an approval a chat turn raised for a tool call — not a workflow
 * checkpoint, not a scheduled run's approval.
 *
 * @param {Object|null} interaction
 * @returns {boolean}
 */
export function isChatToolApproval(interaction) {
  return (
    !!interaction &&
    interaction.kind === 'approval' &&
    interaction.origin === 'tool' &&
    typeof interaction.source?.chatId === 'string' &&
    interaction.source.chatId.length > 0 &&
    !interaction.source.checkpointId &&
    !interaction.source.scheduledTaskId &&
    // An MCP App view's own call is answered beside the view, not by the next message.
    !interaction.source.viewCall
  );
}

function cut(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

function slim(message, limit) {
  const out = { role: message.role };
  if (typeof message.content === 'string') out.content = cut(message.content, limit);
  else if (message.content === null) out.content = null;
  else if (Array.isArray(message.content)) {
    // Multimodal parts: keep the text, never the pictures.
    out.content = message.content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => cut(part.text, limit))
      .join('\n');
  }
  if (Array.isArray(message.tool_calls)) {
    // Arguments stay valid JSON: an over-long one is replaced, not cut. The
    // approved call never runs from these (its arguments come from the approval).
    out.tool_calls = message.tool_calls.map(call => {
      const args = call?.function?.arguments;
      if (typeof args !== 'string' || args.length <= limit) return call;
      return { ...call, function: { ...call.function, arguments: TRUNCATED_ARGUMENTS } };
    });
  }
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.name) out.name = message.name;
  if (
    Array.isArray(message.thoughtSignatures) &&
    JSON.stringify(message.thoughtSignatures).length <= limit
  ) {
    out.thoughtSignatures = message.thoughtSignatures;
  }
  return out;
}

/** What an over-long tool-call argument string is replaced with in a stored transcript. */
const TRUNCATED_ARGUMENTS = JSON.stringify({ _truncated: 'arguments too long to keep' });

/**
 * The part of a paused turn's loop transcript the continuation needs: every
 * message the loop added after the turn's own question (assistant tool-call
 * messages, tool results, the `awaiting_approval` placeholder), stripped of
 * pictures and bounded in size.
 *
 * @param {Array<Object>} messages - `result.messages` of the paused loop
 * @param {Object} options
 * @param {Object} [options.startMessage] - the last message the turn started with
 *   (found by identity; the loop copies the references)
 * @param {string} options.toolCallId - id of the call waiting for approval
 * @returns {Array<Object>|null} the bounded transcript, or null when the call is not in it
 */
export function pausedTurnTranscript(messages, { startMessage, toolCallId }) {
  const list = Array.isArray(messages) ? messages : [];
  const callAt = list.findLastIndex(
    m =>
      m?.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some(c => c?.id === toolCallId)
  );
  if (callAt < 0) return null;
  const startAt = startMessage ? list.lastIndexOf(startMessage) : -1;
  // Compaction can replace the start message; the call's own step is the minimum.
  const from = startAt >= 0 && startAt < callAt ? startAt + 1 : callAt;
  const turn = list
    .slice(from)
    .filter(m => m && (m.role === 'assistant' || m.role === 'tool' || m.role === 'user'));
  const size = msgs => JSON.stringify(msgs).length;
  let bounded = turn.map(m => slim(m, MAX_TRANSCRIPT_MESSAGE_CHARS));
  if (size(bounded) > MAX_TRANSCRIPT_CHARS) {
    bounded = turn.map(m => slim(m, TIGHT_TRANSCRIPT_MESSAGE_CHARS));
  }
  if (size(bounded) > MAX_TRANSCRIPT_CHARS) {
    // Only the step that made the call: its assistant message and the results after it.
    bounded = list.slice(callAt).map(m => slim(m, TIGHT_TRANSCRIPT_MESSAGE_CHARS));
  }
  // Still too large (a step with very many calls): nothing is stored, and the
  // approval is cancelled by the caller rather than kept unbounded.
  return size(bounded) > MAX_TRANSCRIPT_CHARS ? null : bounded;
}

/**
 * The prompt of a continuation turn: the prepared messages without the
 * decision message (the last user message, which only says "Approved"),
 * followed by the stored transcript of the paused turn.
 *
 * An app that sends no chat history (`sendChatHistory: false`) prepares only
 * the decision message, so the paused turn's question is put back in front of
 * the transcript (`question`, stored with it): a tool call never opens a
 * conversation.
 *
 * @param {Array<Object>} llmMessages - prepared messages of this turn
 * @param {Array<Object>} transcript - `toolApproval.pending.transcript`
 * @param {Object} [options]
 * @param {string|null} [options.question] - the paused turn's question (`pending.question`)
 * @returns {Array<Object>}
 */
export function continuationMessages(llmMessages, transcript, { question = null } = {}) {
  const out = [...(Array.isArray(llmMessages) ? llmMessages : [])];
  if (out.length && out[out.length - 1]?.role === 'user') out.pop();
  if (!out.some(m => m?.role === 'user') && typeof question === 'string' && question) {
    out.push({ role: 'user', content: question });
  }
  for (const message of Array.isArray(transcript) ? transcript : []) out.push({ ...message });
  return out;
}

/**
 * The question a paused turn answered, as stored with its transcript (bounded),
 * or null when the turn did not start from a plain user message.
 *
 * @param {Object|null} startMessage
 * @returns {string|null}
 */
export function pausedTurnQuestion(startMessage) {
  if (startMessage?.role !== 'user' || typeof startMessage.content !== 'string') return null;
  return cut(startMessage.content, MAX_TRANSCRIPT_MESSAGE_CHARS) || null;
}

/**
 * Replace the tool message of one call (the placeholder) with a result.
 *
 * @param {Array<Object>} messages - mutated in place
 * @param {string} toolCallId
 * @param {Object} payload - the result (serialized to JSON)
 * @returns {boolean} whether a message was replaced
 */
export function replaceToolResult(messages, toolCallId, payload) {
  const at = messages.findIndex(m => m?.role === 'tool' && m.tool_call_id === toolCallId);
  if (at < 0) return false;
  messages[at] = { ...messages[at], content: JSON.stringify(payload) };
  return true;
}

/**
 * The `approvalResponse` of a chat message, validated, or null.
 *
 * @param {unknown} raw
 * @returns {{interactionId: string, decision: 'approve'|'reject', grant: 'chat'|null}|null}
 */
export function parseApprovalResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const interactionId = typeof raw.interactionId === 'string' ? raw.interactionId.trim() : '';
  if (!interactionId || interactionId.length > 256) return null;
  if (!APPROVAL_DECISIONS.includes(raw.decision)) return null;
  const grant =
    APPROVAL_GRANTS.includes(raw.grant) && raw.decision === 'approve' ? raw.grant : null;
  return { interactionId, decision: raw.decision, grant };
}

/**
 * The chat's approval state as stored on the chat document.
 *
 * @param {Object|null} chat
 * @returns {{grants: string[], pending: Object|null}}
 */
export function chatApprovalState(chat) {
  const state =
    chat?.toolApproval && typeof chat.toolApproval === 'object' ? chat.toolApproval : {};
  const grants = Array.isArray(state.grants)
    ? state.grants.filter(id => typeof id === 'string' && id).slice(0, MAX_CHAT_GRANTS)
    : [];
  const pending = state.pending && typeof state.pending === 'object' ? state.pending : null;
  return { grants, pending };
}

/**
 * A chat document as clients receive it: the stored transcript of a paused
 * turn stays on the server (it holds raw tool results, and it is only there
 * for the continuation). The grants and which call waits stay visible.
 *
 * @param {Object|null} chat
 * @returns {Object|null}
 */
export function publicChatView(chat) {
  if (!chat || !chat.toolApproval || typeof chat.toolApproval !== 'object') return chat;
  const { grants, pending } = chatApprovalState(chat);
  return {
    ...chat,
    toolApproval: {
      grants,
      pending: pending
        ? {
            interactionId: pending.interactionId,
            call: pending.call
              ? { id: pending.call.id, name: pending.call.name, toolId: pending.call.toolId }
              : null,
            createdAt: pending.createdAt || null
          }
        : null
    }
  };
}

const NOT_PENDING = Object.freeze({
  status: 409,
  code: 'APPROVAL_NOT_PENDING',
  message: 'This approval is not pending in this chat (already answered, or superseded)'
});
const ALREADY_ANSWERED = Object.freeze({
  status: 409,
  code: 'APPROVAL_ALREADY_ANSWERED',
  message: 'This approval was already answered'
});

/** Interaction states that mean "nobody will answer this any more". */
const LAPSED = new Set(['expired', 'cancelled']);

/**
 * Take the pending approval off the chat (compare-and-set where the
 * repository offers it).
 */
async function takePending(repository, chatId, interactionId, grants, stored) {
  if (typeof repository?.takeToolApproval === 'function') {
    return repository.takeToolApproval(chatId, interactionId, { grants });
  }
  await repository?.updateChat?.(chatId, { toolApproval: { grants, pending: null } });
  return stored;
}

/**
 * First half of settling the chat's tool approvals for an incoming message:
 * everything that can refuse the request without changing anything.
 *
 * - A message with `approvalResponse` is checked (shape, the chat's pending
 *   approval, the interaction's owner). Nothing is answered yet: the route
 *   calls `commit()` once the turn is prepared, so a request that fails
 *   before the turn can run does not use the approval up.
 * - Any other message cancels pending approvals (`superseded`) and drops the
 *   stored transcript right away.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {Object} params.user
 * @param {Object|null} params.chat - the chat document
 * @param {Object|null} params.lastMessage - the message of this POST
 * @param {Object} params.repository - ChatRepository
 * @param {Object} [params.interactionService]
 * @param {Function} [params.authorizeInteraction]
 * @returns {Promise<{grants: string[], refusal: Object|null,
 *   commit: (() => Promise<{grants: string[], resume: Object|null, refusal: Object|null}>)|null}>}
 *   `refusal` is `{ status, code, message }`: answer the request with it, run no turn.
 */
export async function prepareChatApproval({
  chatId,
  user,
  chat,
  lastMessage,
  repository,
  interactionService = defaultInteractionService,
  authorizeInteraction = defaultAuthorizeInteraction
}) {
  const state = chatApprovalState(chat);
  const response = parseApprovalResponse(lastMessage?.approvalResponse);
  const result = { grants: state.grants, refusal: null, commit: null };

  if (lastMessage?.approvalResponse !== undefined && !response) {
    result.refusal = {
      status: 400,
      code: 'INVALID_APPROVAL_RESPONSE',
      message: 'approvalResponse needs an interactionId and a decision (approve or reject)'
    };
    return result;
  }

  let pendingList = [];
  try {
    pendingList = (await interactionService.listPending({ chatId, kind: 'approval' })).filter(
      isChatToolApproval
    );
  } catch (err) {
    logger.warn('Chat approvals could not be listed', {
      component: COMPONENT,
      chatId,
      error: err.message
    });
  }

  const cancelOthers = async keepId => {
    for (const interaction of pendingList) {
      if (interaction.id === keepId) continue;
      if (!(await authorizeInteraction(interaction, user))) continue;
      await interactionService.cancel(interaction.id, 'superseded').catch(() => {});
    }
  };

  if (!response) {
    await cancelOthers(null);
    if (state.pending) {
      await repository?.updateChat?.(chatId, {
        toolApproval: { grants: state.grants, pending: null }
      });
    }
    return result;
  }

  const stored = state.pending;
  if (!stored || stored.interactionId !== response.interactionId) {
    result.refusal = { ...NOT_PENDING };
    return result;
  }

  const interaction = await interactionService.get(response.interactionId);
  if (interaction && !(await authorizeInteraction(interaction, user))) {
    result.refusal = {
      status: 403,
      code: 'APPROVAL_FORBIDDEN',
      message: 'This approval belongs to another user'
    };
    return result;
  }

  result.commit = async () =>
    commitChatApproval({
      chatId,
      user,
      response,
      stored,
      interaction,
      grants: state.grants,
      repository,
      interactionService,
      cancelOthers
    });
  return result;
}

/**
 * Second half: answer the approval exactly once, take it off the chat, and
 * hand over what the continuation needs. An approval the sweeper already
 * expired or cancelled continues as `expired` (the model gets
 * `APPROVAL_EXPIRED`). One that a refused turn put back (`settled`) is used
 * with the answer it already has.
 *
 * @private
 */
async function commitChatApproval({
  chatId,
  user,
  response,
  stored,
  interaction,
  grants: currentGrants,
  repository,
  interactionService,
  cancelOthers
}) {
  const out = { grants: currentGrants, resume: null, refusal: null, restore: null };
  let outcome;
  if (stored.settled?.outcome) {
    outcome = stored.settled.outcome;
  } else if (!interaction || LAPSED.has(interaction.status)) {
    // Settled by the sweeper (expired, superseded) or evicted: it cannot run.
    outcome = 'expired';
  } else if (interaction.status === 'answered') {
    out.refusal = { ...ALREADY_ANSWERED };
    return out;
  } else {
    try {
      await interactionService.answer(
        response.interactionId,
        response.decision === 'approve'
          ? { decision: 'approve', ...(response.grant ? { data: { grant: response.grant } } : {}) }
          : { decision: 'reject', reason: 'Rejected in the chat' },
        { user, channel: 'chat' }
      );
      outcome = response.decision === 'approve' ? 'approved' : 'rejected';
    } catch (err) {
      if (err?.code === 'EXPIRED' || err?.code === 'NOT_FOUND') {
        outcome = 'expired';
      } else if (err?.code === 'NOT_PENDING') {
        const current = await interactionService.get(response.interactionId).catch(() => null);
        if (current && LAPSED.has(current.status)) outcome = 'expired';
        else {
          out.refusal = { ...ALREADY_ANSWERED };
          return out;
        }
      } else if (err?.code === 'ANSWER_IN_PROGRESS') {
        // A second answer (double click, a retried request): the first one runs the call.
        out.refusal = { ...ALREADY_ANSWERED };
        return out;
      } else {
        throw err;
      }
    }
  }

  const toolId = stored.call?.toolId || interaction?.source?.toolId || null;
  const grants =
    outcome === 'approved' && response.grant === 'chat' && toolId && !currentGrants.includes(toolId)
      ? [...currentGrants, toolId].slice(-MAX_CHAT_GRANTS)
      : currentGrants;
  // Exactly one request takes the approval off the chat.
  const taken = await takePending(repository, chatId, response.interactionId, grants, stored);
  if (!taken) {
    out.refusal = { ...ALREADY_ANSWERED };
    return out;
  }
  await cancelOthers(response.interactionId);

  logger.info('Chat tool approval settled', {
    component: COMPONENT,
    chatId,
    interactionId: response.interactionId,
    toolId,
    outcome,
    grant: outcome === 'approved' ? response.grant : null
  });

  out.grants = grants;
  out.resume = {
    interactionId: response.interactionId,
    outcome,
    call: stored.call,
    // The arguments the person saw and approved — the interaction holds them;
    // the stored call is the fallback for one that was evicted.
    args: interaction?.prompt?.displayData?.args ?? stored.call?.args ?? {},
    transcript: Array.isArray(stored.transcript) ? stored.transcript : [],
    question: typeof stored.question === 'string' ? stored.question : null,
    // What the paused turn had used, for the basis of the continuation's answer.
    basis: boundCarriedBasis(stored.basis)
  };
  // A turn refused before its loop started puts the approval back, with its
  // answer, so the same decision can be sent again.
  out.restore = async () => {
    const { settled: _previous, ...rest } = stored;
    try {
      return await repository?.restoreToolApproval?.(chatId, { ...rest, settled: { outcome } });
    } catch (err) {
      logger.warn('Tool approval could not be put back after a refused turn', {
        component: COMPONENT,
        chatId,
        interactionId: response.interactionId,
        error: err.message
      });
      return false;
    }
  };
  return out;
}

/**
 * Settle the chat's tool approvals for an incoming message in one step
 * ({@link prepareChatApproval} then its `commit`).
 *
 * @param {Object} params - see {@link prepareChatApproval}
 * @returns {Promise<{grants: string[], resume: Object|null, refusal: Object|null,
 *   restore: (() => Promise<boolean>)|null}>}
 */
export async function settleChatApprovals(params) {
  const prepared = await prepareChatApproval(params);
  if (prepared.refusal || !prepared.commit) {
    return { grants: prepared.grants, resume: null, refusal: prepared.refusal, restore: null };
  }
  return prepared.commit();
}
