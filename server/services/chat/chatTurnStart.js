// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The start of a chat turn, without an HTTP request.
 *
 * A turn is described by a {@link TurnRequest}: plain data that names the
 * chat, the app, who sends the message, and everything the sender chose for
 * this turn. The chat route (`routes/chat/sessionRoutes.js`) builds one from
 * its request; nothing in this module reads a request or writes a response.
 *
 * {@link prepareTurn} does everything that can refuse the turn before
 * anything is told to its reader: it checks who is asking, reads the uploads,
 * assembles the history and what the turn stores. It answers with a
 * {@link PreparedTurn}, with a refusal, or with the answer of a workflow the
 * message was handed to. A refusal is a value: the status and the registry
 * code the caller answers with.
 *
 * {@link runPreparedTurn} runs a prepared turn: it opens the caller's stream
 * (the commit point), builds the model request, uses up the approval or the
 * connect the message answers, runs the turn through `ChatService.runTurn`,
 * and lets go of the chat however the turn ended. Where the turn is told is
 * the caller's {@link TurnSink}.
 *
 * The steps of both run in a fixed order ({@link PREPARE_STEPS},
 * {@link RUN_STEPS}). The order is behaviour: a request that is wrong in two
 * ways is refused for the first, and a step that changes something (a
 * clarification is settled, an upload is stored) has done so when a later
 * step refuses.
 *
 * @module services/chat/chatTurnStart
 */
import configCache from '../../configCache.js';
import { resolveChatProjects } from '../knowledge/chatProjects.js';
import {
  checkProjectTestChat,
  projectTestOrigin,
  resolveProjectTestScope
} from '../knowledge/projectTestScope.js';
import { isPriorAnswer } from '../loop/contextTracker.js';
import { isLLMError } from '../loop/LLMClient.js';
import { dropRun } from '../loop/partialRunState.js';
import { logInteraction, trackSession } from '../../utils.js';
import { RunStreamEmitter, buildEnvelope } from '../loop/RunStream.js';
import runLog, { newRunId, isValidRunId } from '../loop/RunLog.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { getIntegrationConnectionService } from '../integrations/auth/IntegrationConnectionService.js';
import { resolveChatScopes } from '../integrations/scopes/index.js';
import { appendMcpAppContext, renderMcpAppContext } from '../mcp/mcpAppContext.js';
import { tryHandleMentionWorkflow } from '../workflow/mentionWorkflow.js';
import { hydrateHistoryForPrompt, prepareTurnFiles } from '../chatFiles/ChatFileService.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { KNOWLEDGE_REFRESH_PHASE } from '../../../shared/run/knowledgeRefresh.js';
import { clearChatDurable, hasChatClient, locateChatClient, markChatDurable } from '../../sse.js';
import { codeOfStatus, toErrorResponse } from '../../utils/errorResponse.js';
import logger from '../../utils/logger.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { authorizeChat } from './chatAccess.js';
import { prepareConnectResume } from './chatConnectResume.js';
import { guestIdOf, guestOwnerId, isNewGuest, resolveChatOwner } from './chatOwner.js';
import { resolveChatStorage } from './chatPersistence.js';
import {
  getChatRepository,
  isPersistableChatId,
  normalizeChatSettings,
  chatTurnSettings,
  normalizeChatVariables
} from './ChatRepository.js';
import { prepareChatApproval } from './chatToolApproval.js';
import { emitFailedRun } from './failedRun.js';
import { isVoiceTurn, VOICE_INPUT_MODE } from './voiceMode.js';

const COMPONENT = 'chatTurnStart';

/**
 * Who a turn is for, as plain data: no permissions, no groups, no secret.
 *
 * @typedef {Object} PrincipalRef
 * @property {'user'|'guest'} type - `guest` for an anonymous caller.
 * @property {string|null} id - The user id; for a guest the owner id its chats
 *   are stored under (`guest-<hash>`), or null when it has no guest identity.
 */

/**
 * What a caller's connection said about itself. A caller without a connection
 * leaves it out.
 *
 * @typedef {Object} TurnClient
 * @property {string} [sessionId] - The browser session (`X-Session-Id`), for the logs.
 * @property {string} [userAgent] - For the session log.
 * @property {string} [ip] - For the audit entry of a call resumed after a connect.
 * @property {string} [url] - The address that was asked, from which that audit
 *   entry derives its source.
 */

/**
 * One chat turn to start, as plain data. It lists every input of a turn: what
 * is not named here does not reach the turn.
 *
 * `modelId` and the settings from `style` to `integrationScopes` are what this
 * turn names; what it leaves out (`undefined`) is what the chat was last
 * answered with (`chatTurnSettings`).
 *
 * @typedef {Object} TurnRequest
 * @property {string} chatId
 * @property {string} appId
 * @property {PrincipalRef} principalRef - Who sends the message.
 * @property {string|null} messageId - The sender's id for the new message.
 * @property {Object} [message] - The new message: `content`, and what it
 *   carries with it: uploads (`fileData`, `imageData`, `audioData`, each one
 *   object or a list, and `fileIds` for files uploaded before), `variables`,
 *   `hostContext`, a `clarificationResponse`, an `approvalResponse`, a
 *   `connectResume`. Left out (`undefined`), the turn is refused.
 * @property {number} [clientHistory] - How many earlier messages the caller
 *   sent along with the new one. The server owns the history, so any refuses
 *   the turn (`CLIENT_HISTORY_NOT_ALLOWED`).
 * @property {string} [modelId]
 * @property {string} [style]
 * @property {string} [outputFormat]
 * @property {boolean} [sendChatHistory]
 * @property {boolean} [thinkingEnabled]
 * @property {string} [thinkingLevel]
 * @property {boolean} [thinkingThoughts]
 * @property {string[]} [enabledTools]
 * @property {boolean} [websearchEnabled]
 * @property {string} [imageAspectRatio]
 * @property {string} [imageQuality]
 * @property {Object<string, string>} [integrationScopes] - The scope picked per integration.
 * @property {string} [language] - The language the sender works in; the
 *   platform's default language when left out.
 * @property {string|null} [clientTimezone] - The sender's IANA time zone, handed to the
 *   tools and to the scheduling note of the prompt. The chat POST carries none.
 * @property {boolean} [toolApprovalCapable] - The sender's client draws tool approval cards.
 * @property {'person'} origin - What started the turn. A message somebody sent is `person`,
 *   and that is the only origin so far: the turn carries it and decides nothing by it yet.
 * @property {*} [bypassAppPrompts]
 * @property {string[]} [requestedSkills]
 * @property {string[]} [documentIds]
 * @property {string} [replaceFromMessageId] - The message an edit or a regenerate forks from.
 * @property {boolean} [ephemeral] - Start a temporary chat.
 * @property {Object} [mcpAppContext] - What open MCP App views reported since the last turn.
 * @property {boolean} [voiceMode]
 * @property {string|null} [projectId] - The chat's container project.
 * @property {string[]} [projects] - The projects attached for this turn.
 * @property {string} [testProjectId] - The admin project a project test puts in scope.
 * @property {TurnClient} [client]
 */

/**
 * The principal reference of a resolved user.
 *
 * @param {Object} [user] - A resolved user, as a request carries it (`req.user`).
 * @returns {PrincipalRef}
 */
export function principalRefOf(user) {
  if (isAnonymousUser(user)) {
    const guestId = guestIdOf(user);
    return { type: 'guest', id: guestId ? guestOwnerId(guestId) : null };
  }
  return { type: 'user', id: String(user.id) };
}

/**
 * The frames that answer a refusal or failure after a turn's own stream
 * committed, when no status line can carry it any more: `stream/error`, then
 * the turn's `run/ended { status: 'error' }`. The error is described exactly
 * as its problem+json body would be (`toErrorResponse`): the same code, and a
 * 5xx message only when it is safe to show.
 *
 * @param {string} chatId
 * @param {string} runId - The turn's run
 * @param {Error} error
 * @returns {Object[]} SSE v2 envelopes
 */
function lateRefusalFrames(chatId, runId, error) {
  const { body } = toErrorResponse(error);
  const frame = (type, data) => buildEnvelope({ streamId: chatId, runId, type, data });
  const described = { code: body.code, message: body.detail };
  return [
    frame(SSE_V2_EVENTS.STREAM_ERROR, {
      ...described,
      retryable: false,
      details: { ...body.details, status: body.status }
    }),
    frame(SSE_V2_EVENTS.RUN_ENDED, { status: 'error', finishReason: 'error', error: described })
  ];
}

/**
 * Chat-shaped view of a persisted transcript: role, content, and any hydrated
 * `fileData` payloads.
 *
 * Everything else on a stored message — ids, usage, the error of a failed turn,
 * attachment descriptors — is bookkeeping for the history UI and has no place
 * in a model prompt. Contentless turns are dropped with it: an aborted or
 * failed turn is stored with an empty answer, and several providers reject a
 * blank message outright.
 *
 * @param {Array<Object>} stored - Messages as `ChatRepository` returns them.
 * @returns {Array<{role: string, content: string, fileData?: Array<Object>, activeSkills?: Array<Object>}>} An answer
 *   keeps the skills it activated (`activity.activeSkills`), so they stay active.
 */
export function historyForPrompt(stored) {
  return stored
    .filter(
      entry =>
        entry?.role &&
        ((typeof entry.content === 'string' && entry.content.trim()) || Boolean(entry.fileData))
    )
    .map(entry => {
      // The skills an answer activated stay active in the chat; the request
      // builder reads them from here and re-checks access every turn.
      // A stored answer carries them in `activity`; a history rebuilt from the file
      // store (`hydrateHistoryForPrompt`) already has them as `activeSkills`.
      const skills =
        entry.role === 'assistant' ? (entry.activity?.activeSkills ?? entry.activeSkills) : null;
      return {
        role: entry.role,
        content: typeof entry.content === 'string' ? entry.content : '',
        ...(entry.fileData ? { fileData: entry.fileData } : {}),
        ...(Array.isArray(skills) && skills.length > 0 ? { activeSkills: skills } : {})
      };
    });
}

/**
 * Who brought a skill into the turn, by the route `resolveSkillsForTurn`
 * found it by: picked in the composer or `/name` in the message is the user's
 * (`requested`, `message`), `skillSettings.autoActivate` is the app's, and one
 * an earlier turn activated is kept (`chat`). The model's own activation is
 * announced by the `activate_skill` tool, not here.
 */
const SKILL_ACTIVATOR_OF_ORIGIN = Object.freeze({
  requested: 'user',
  message: 'user',
  app: 'app',
  chat: 'chat'
});

/**
 * The skills a turn announces on its run (`skill.activation`): every skill in
 * force, each saying who brought it in: the user, the app, or an earlier
 * message of the chat. A skill is shown once, in the activity block, with its
 * reason, so a carried-over skill is announced too.
 *
 * @param {Array<{name: string, displayName: string, description?: string, origin: string}>} [skills]
 *   `activeSkills` of the prepared request
 * @returns {Array<{skillName: string, skillId: string, activatedBy: 'user'|'app'|'chat', description: string}>}
 */
export function announcedSkills(skills) {
  return (Array.isArray(skills) ? skills : []).map(skill => ({
    skillName: skill.displayName,
    skillId: skill.name,
    activatedBy: SKILL_ACTIVATOR_OF_ORIGIN[skill.origin] || 'user',
    description: skill.description || ''
  }));
}

/**
 * Upload descriptors carried by a chat message, for the materializer to
 * normalize. The base64 payloads stay in the request: what a stored message
 * keeps is the fact that a file was attached, not the file.
 *
 * Each of the three fields is a single object for one upload and an array for
 * several — the shape the chat client has always sent and `RequestBuilder`
 * already handles — so they are flattened here. Without that an array is
 * `typeof 'object'` and survives as one opaque descriptor, turning three named
 * PDFs into a single nameless `{ type: 'file' }`.
 *
 * @param {Object} message - The new user message from the request.
 * @returns {Array<Object>}
 */
export function messageAttachments(message) {
  return [message?.fileData, message?.imageData, message?.audioData]
    .flatMap(value => (Array.isArray(value) ? value : value ? [value] : []))
    .filter(entry => entry && typeof entry === 'object');
}

/**
 * A refusal of a turn: what the caller answers with instead of running it.
 *
 * @typedef {Object} TurnRefusal
 * @property {number} status - HTTP status
 * @property {string} code - A code of `shared/apiErrors.js`
 * @property {string} message
 * @property {Object} [details]
 */

/**
 * A turn that may run: checked, with its uploads read and its history and
 * storage assembled. It is not plain data (it holds the chat repository and
 * the one-time answers of an approval and of a connect) and it runs once.
 *
 * The model request is not built yet. It is built when the turn runs, after
 * the reader's stream is open, because the wait for outdated project documents
 * is already shown there.
 *
 * @typedef {Object} PreparedTurn
 * @property {string} chatId
 * @property {string} appId
 * @property {string|null} messageId
 * @property {Object} [user] - The principal the turn runs as.
 * @property {string} language - The language the sender works in.
 * @property {Object} requestOptions - What the model request is built from
 *   (`ChatService.prepareChatRequest`).
 * @property {Object} persistence - What the turn stores and how (`ChatService.runTurn`).
 * @property {{grants: string[], resume: Object|null}} toolApproval - The chat's tool approval state.
 * @property {(() => Promise<Object>)|null} commitApproval - Answers the approval this
 *   message carries, exactly once; null when it carries none.
 * @property {(() => Promise<Object>)|null} commitConnectResume - Takes the call this
 *   message resumes after a connect, exactly once; null when it resumes none.
 * @property {{runId: string, interactionId: string}|null} pausedTurn - The paused run this
 *   message answers (a clarification or a tool approval): the turn continues it.
 * @property {Object|null} priorContext - The context stored with the last answer of the
 *   history the prompt holds.
 * @property {boolean} resendsHistory - The prompt holds the stored history as it is.
 * @property {Object} promptMessage - The new message as the prompt gets it, uploads read.
 * @property {Object} [mcpAppContext] - What open MCP App views reported since the last turn.
 * @property {boolean} canApproveTools - The sender's client draws tool approval cards.
 * @property {string|null} clientTimezone
 * @property {string} origin - What started the turn.
 * @property {string} [sessionId] - The sender's browser session, for the logs.
 * @property {() => boolean} audited - Whether the turn wrote an audit entry of its own
 *   (a call resumed after a connect). The caller is told through its sink (`TurnSink.audited`).
 */

/**
 * @typedef {Object} TurnPreparation
 * @property {PreparedTurn} [turn] - The turn to run ({@link runPreparedTurn}).
 * @property {TurnRefusal} [refusal] - The turn is refused.
 * @property {Object} [answer] - The message was handed to a workflow (`@workflow`):
 *   the body to answer with. No turn runs.
 */

/**
 * A refusal as a value: its own code, else the one of its status.
 *
 * @param {number} status - HTTP status
 * @param {string} message
 * @param {{ code?: string, details?: Object }} [options]
 * @returns {{refusal: TurnRefusal}}
 */
function refused(status, message, { code, details } = {}) {
  return {
    refusal: {
      status,
      code: code ?? codeOfStatus(status),
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

/**
 * Who may write to the chat, and the setup the turn is answered with.
 *
 * @param {Object} draft - The turn as far as it is prepared.
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function authorizeTurn(draft) {
  const { request, user } = draft;
  // Access to the app is checked by the caller; that never covers the chat id. Once chats
  // are stored, anyone who guesses one could otherwise append a turn to
  // — and, through the stream, read back — another user's chat.
  const access = await authorizeChat(request.chatId, user, { intent: 'write' });
  if (!access.ok) {
    if (isNewGuest(user)) {
      // The chat exists but this request came without the guest cookie
      // that owns it, so its browser does not keep cookies for this site.
      return refused(
        404,
        'This chat cannot be continued: the browser did not keep the guest cookie it was started with',
        { code: 'GUEST_COOKIE_MISSING' }
      );
    }
    return refused(404, 'Chat session not found', { code: 'NOT_FOUND' });
  }
  draft.access = access;
  // What the request left out is what the chat was last answered with,
  // never the app's defaults: an approval or clarification answer, or an
  // API caller, sends only part of the setup (`chatTurnSettings`).
  draft.settings = chatTurnSettings(request, access.chat);
  const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
  draft.language = request.language || defaultLang;
  return null;
}

/**
 * The projects in scope: a project test, or the chat's container project and
 * the projects attached from the picker (#1036), checked against the caller's
 * access here, carried on the request to the prompt builder, persisted with
 * the chat.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function scopeProjects(draft) {
  const { request, access } = draft;
  // A project test (#3309) puts one admin project in scope for this turn
  // and keeps the chat temporary; the picker's fields do not apply to it.
  let projectTest = null;
  if (request.testProjectId !== undefined) {
    projectTest = await resolveProjectTestScope({
      user: draft.user,
      testProjectId: request.testProjectId
    });
    // A test runs in a temporary chat that a test of this project started
    // (or one nothing has been said in yet), never in a kept chat and never
    // in another conversation: that would put answers from a project that
    // may be disabled into the admin's history, or read an unrelated chat.
    const refusedTest = projectTest.ok
      ? checkProjectTestChat(access.chat, projectTest.projectId)
      : projectTest;
    if (refusedTest) {
      return refused(
        refusedTest.status,
        await draft.getLocalizedError(refusedTest.messageKey, {}, draft.language),
        { code: refusedTest.code }
      );
    }
  }
  draft.projectTest = projectTest;
  // `resolveChatProjects` reads the caller from an object shaped like a request
  // and, when the caller's permissions are not resolved yet, resolves them on
  // it (`ensurePrincipal`). The rest of the turn runs as the principal it left.
  const principal = { user: draft.user };
  const chatProjects = await resolveChatProjects({
    req: principal,
    chat: access.chat,
    // Case-insensitive like the request builder, which accepts the id
    // in any case: a missed app would skip its `userProjects` gate.
    app: findByIdCaseInsensitive(configCache.getApps()?.data || [], request.appId) || null,
    projectId: projectTest ? undefined : request.projectId,
    projects: projectTest ? undefined : request.projects
  });
  draft.user = principal.user;
  if (!chatProjects.ok) {
    return refused(chatProjects.status, chatProjects.message, { code: chatProjects.code });
  }
  draft.chatProjects = chatProjects;
  return null;
}

/**
 * A clarification (`ask_user`) is answered by the next message: settle the
 * pending interaction (channel `chat`) before the turn runs; any other
 * message supersedes clarifications the user chose not to answer.
 *
 * @param {Object} draft
 * @returns {Promise<null>}
 */
async function settlePendingClarifications(draft) {
  draft.answeredClarification = await draft.settleClarifications({
    chatId: draft.request.chatId,
    user: draft.user,
    lastMessage: draft.request.message
  });
  logger.debug('Processing chat', { component: COMPONENT, language: draft.language });
  return null;
}

/**
 * The server owns the history. Every chat is stored, so a turn carries
 * exactly one message — the new one — and the server reads the rest back out
 * of the store: a client can no longer rewrite what it already said. A chat
 * the user does not want to keep (incognito, an anonymous visitor, an
 * installation without chat history) is stored the same way, as a temporary
 * chat that is never listed and expires on its own.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function checkStorage(draft) {
  const { request } = draft;
  const repository = getChatRepository();
  const storage = resolveChatStorage({
    features: configCache.getFeatures(),
    platformConfig: configCache.getPlatform(),
    user: draft.user,
    // A scratch chat of a project test is never kept (#3309).
    ephemeral: draft.projectTest ? true : request.ephemeral
  });
  // An id the store cannot key cannot be a chat any more.
  if (!isPersistableChatId(request.chatId)) {
    return refused(400, 'Invalid chat id', { code: 'BAD_REQUEST' });
  }
  if (!storage.stored || !repository.isAvailable()) {
    // No browser-held fallback: a conversation nobody can continue is
    // not an answer. The provider failure itself was logged at boot.
    return refused(503, 'Chat storage is unavailable', { code: 'CHAT_STORAGE_UNAVAILABLE' });
  }
  if (request.clientHistory > 0) {
    // The code alone tells an integrator nothing about what to do
    // instead, and this is the one refusal they can hit by doing exactly
    // what the documentation told them to do before chats were stored.
    return refused(400, 'The chat history is kept by the server: send only the new message', {
      code: 'CLIENT_HISTORY_NOT_ALLOWED',
      details: {
        hint:
          'Chats are stored server-side: post only the new message as a single-element ' +
          'messages array (send ephemeral: true for a chat that is not kept in the history). ' +
          'To send the whole conversation yourself, use the stateless OpenAI-compatible ' +
          'chat completions endpoint instead.'
      }
    });
  }
  if (request.message === undefined) {
    const errorMessage = await draft.getLocalizedError('messagesRequired', {}, draft.language);
    return refused(400, errorMessage, { code: 'BAD_REQUEST' });
  }
  draft.repository = repository;
  draft.storage = storage;
  return null;
}

/**
 * Who the chat is stored under, and whether it is temporary.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function resolveOwner(draft) {
  const { access } = draft;
  // Resolved once here and carried on the turn: `resolvePrincipal` is
  // async and hits the filesystem, and the run finishes with no request
  // in scope. The mode travels with the id so that an admin changing
  // `runLog.identityMode` later cannot orphan this chat. An anonymous
  // caller owns its chats through its guest identity.
  const owner = await resolveChatOwner(draft.user, {
    mode: access.chat?.identityMode || runLog.identityMode()
  });
  if (!owner) {
    return refused(403, 'This chat has no owner to be stored under', {
      code: 'CHAT_OWNER_REQUIRED'
    });
  }
  draft.owner = owner;
  // Fixed when the chat is created: a later turn's `ephemeral` neither
  // hides a kept chat nor keeps a temporary one (that is
  // `PATCH /api/chats/:id { temporary: false }`).
  draft.temporary = access.chat ? access.chat.temporary === true : draft.storage.temporary;
  return null;
}

/**
 * The paused call this message answers, checked and not yet used up.
 *
 * A tool approval (#2945) is answered by the next message, like a
 * clarification: `approvalResponse` is checked here and answered (exactly
 * once) only when the turn runs (`commitApproval`), so a request that fails
 * first does not use it up; any other message supersedes a pending approval.
 *
 * A connect resumes the call that stopped on a missing connection (#3752):
 * `connectResume { id }` is checked here and the record is taken (exactly
 * once) only when the turn runs, like an approval. Any other message
 * supersedes the record.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function prepareResumes(draft) {
  const { request, access, repository, user } = draft;
  const chat = access.chat || null;
  const approvals = await prepareChatApproval({
    chatId: request.chatId,
    user,
    chat,
    lastMessage: request.message,
    repository
  });
  if (approvals.refusal) {
    return refused(approvals.refusal.status, approvals.refusal.message, {
      code: approvals.refusal.code
    });
  }
  // What the audit entry of a resumed call reads from a request: who acted and
  // from where. The audit log marks the object it wrote an entry for.
  draft.auditSubject = { user, ip: request.client?.ip, originalUrl: request.client?.url };
  const connectResume = await prepareConnectResume({
    chatId: request.chatId,
    user,
    appId: request.appId,
    chat,
    ownerId: draft.owner.id,
    lastMessage: request.message,
    repository,
    req: draft.auditSubject,
    isConnected: async (userId, integration) => {
      const resolved = await getIntegrationConnectionService()
        .resolve({ type: 'user', id: userId }, integration)
        .catch(() => null);
      return resolved?.ok === true;
    }
  });
  if (connectResume.refusal) {
    return refused(connectResume.refusal.status, connectResume.refusal.message, {
      code: connectResume.refusal.code
    });
  }
  draft.approvals = approvals;
  draft.connectResume = connectResume;
  draft.toolApproval = { grants: approvals.grants, resume: null };
  return null;
}

/**
 * The stored history without the answers a resumed call replaces: the answer
 * that carries the connect card is the last message of the chat (a resume
 * that failed again left a chain of them), and the continuation is built from
 * the question before them.
 *
 * @param {Object[]} history - The stored messages
 * @param {Object} record - The record of the call that is resumed
 * @returns {Object[]}
 */
function historyBeforeResume(history, record) {
  const answerRuns = new Set([...(record.continues || []), record.runId]);
  let kept = history;
  while (
    kept.length > 0 &&
    kept[kept.length - 1].role === 'assistant' &&
    answerRuns.has(kept[kept.length - 1].runId)
  ) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

/**
 * The stored history the turn continues from: all of it, cut before the
 * answers a resumed call replaces, or cut at the message an edit or a
 * regenerate forks from.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function forkHistory(draft) {
  const { request, repository } = draft;
  const { replaceFromMessageId } = request;
  const stored = await repository.getMessages(request.chatId);
  let history = stored.messages;
  draft.forkStoredId = null;
  draft.replacedMessage = null;
  const record = draft.connectResume.record;
  if (record) {
    const last = history[history.length - 1];
    if (replaceFromMessageId || last?.role !== 'assistant' || last.runId !== record.runId) {
      return refused(409, 'Nothing is waiting to be continued in this chat', {
        code: 'CONNECT_RESUME_NOT_PENDING'
      });
    }
    history = historyBeforeResume(history, record);
  }
  if (replaceFromMessageId) {
    // Either id the client can know this message by: the stored id it
    // was given on hydrate, or — for a turn made in the session that
    // is still open, which never learns the stored id — the exchange
    // id it sent and the store filed as `clientMessageId`. Without the
    // second, regenerating the answer you just got would carry no fork
    // id at all and the retry would be appended to the untouched
    // history, duplicating the exchange.
    const forkAt = history.findIndex(
      entry => entry.id === replaceFromMessageId || entry.clientMessageId === replaceFromMessageId
    );
    // Appending onto the untouched history instead would silently
    // duplicate everything the edit meant to replace, so refuse.
    if (forkAt === -1) {
      return refused(400, 'The message to continue from is not in this chat', {
        code: 'UNKNOWN_MESSAGE'
      });
    }
    // Carry the *stored* id onward. The store matches on `id` alone,
    // so forwarding the client's value forked the prompt here and not
    // the transcript: a regenerate in a session that never hydrated
    // sends its exchange id, which this lookup resolves and the store
    // then rejects with UNKNOWN_MESSAGE. `materializeUserTurn` logs
    // and returns null, the chat document has already been updated,
    // and the answer lands at the end — so the stored history keeps
    // the exchange the user replaced and, for an edit, never records
    // the edited question at all. Permanent, and replayed to the model
    // every turn after.
    draft.replacedMessage = history[forkAt];
    draft.forkStoredId = history[forkAt].id;
    history = history.slice(0, forkAt);
  }
  draft.history = history;
  return null;
}

/**
 * The app variables the prompt reads, and the integration scopes the turn
 * runs with.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|null>}
 */
async function resolveVariablesAndScopes(draft) {
  const { request, repository, settings } = draft;
  const newMessage = request.message;
  // An app that opted out of chat history stays a one-shot prompt:
  // storing the transcript must not start feeding it back to the
  // model. The viewer's own "Include chat history in requests" toggle
  // says the same thing for one turn (see `buildConversation`).
  const chatApp = (configCache.getApps().data || []).find(a => a.id === request.appId);
  // The app variables are chat state: a turn that sets them (the
  // start form's, or any turn of an app that asks for them beside the
  // chat) stores them, and a turn that does not gets the stored ones —
  // for the system prompt, never as a re-rendered `prompt` template.
  const turnVariables = normalizeChatVariables(newMessage.variables);
  const chatVariables =
    turnVariables ||
    (chatApp?.variables?.length
      ? normalizeChatVariables((await repository.getChat(request.chatId))?.variables)
      : null);
  // The prompt reads the variables as they are stored, so this turn and
  // the ones after it render them alike (`false` is "false" in both).
  draft.promptMessage = chatVariables ? { ...newMessage, variables: chatVariables } : newMessage;
  draft.chatApp = chatApp;
  draft.turnVariables = turnVariables;

  // Where the chat's integrations search and whom they ask (#3050): the
  // scopes this turn names, or else the ones the chat was answered with,
  // checked against what each integration offers this user. A pinned
  // scope replaces the request's; one the user may not use refuses the
  // turn rather than quietly searching somewhere else.
  const scopeResolution = chatApp
    ? await resolveChatScopes({
        requested: settings.integrationScopes,
        user: draft.user,
        app: chatApp,
        model: findByIdCaseInsensitive(
          configCache.getModels()?.data || [],
          settings.modelId || chatApp.preferredModel
        ),
        language: draft.language
      })
    : { ok: true, scopes: {} };
  if (!scopeResolution.ok) {
    return refused(403, scopeResolution.message, {
      code: scopeResolution.code,
      details: { integrationId: scopeResolution.integrationId }
    });
  }
  draft.integrationScopes = scopeResolution.scopes;
  return null;
}

/**
 * Read the uploads of the new message into the chat's file store.
 *
 * @param {Object} draft
 * @returns {Promise<null>}
 */
async function readUploads(draft) {
  const { request, repository } = draft;
  const { message, attachments } = await prepareTurnFiles({
    chatId: request.chatId,
    ownerId: draft.owner.id,
    message: draft.promptMessage,
    inheritedAttachments: draft.replacedMessage?.attachments,
    appConfig: draft.chatApp,
    store: repository.fileStore?.()
  });
  draft.promptMessage = message;
  // `prepareTurnFiles` already describes the images and audio of the turn next to its
  // documents; adding them again here stored every image and audio file twice.
  draft.attachments = attachments.length > 0 ? attachments : messageAttachments(request.message);
  return null;
}

/**
 * The ids of the host items a message carries: an e-mail, a meeting or a page.
 *
 * @param {Object} [message]
 * @returns {Set<string>}
 */
function hostItemIds(message) {
  return new Set(
    [message?.fileData]
      .flat()
      .filter(file => file && ['email', 'meeting', 'page'].includes(file.origin))
      .map(file => file.fileId || file.id)
      .filter(Boolean)
  );
}

/**
 * A history without the files named by `ids`; an entry left with neither a
 * file nor text is dropped.
 *
 * @param {Object[]} history - A hydrated history
 * @param {Set<string>} ids
 * @returns {Object[]}
 */
function withoutFiles(history, ids) {
  if (ids.size === 0) return history;
  return history
    .map(entry =>
      entry.fileData
        ? { ...entry, fileData: entry.fileData.filter(file => !ids.has(file.fileId || file.id)) }
        : entry
    )
    .map(entry =>
      entry.fileData && entry.fileData.length === 0
        ? (({ fileData: _dropped, ...rest }) => rest)(entry)
        : entry
    )
    .filter(entry => entry.fileData || (entry.content || '').trim());
}

/**
 * The conversation the prompt is built from: the stored history, when the app
 * and the sender include it, and the new message.
 *
 * @param {Object} draft
 * @returns {Promise<null>}
 */
async function buildConversation(draft) {
  const { request, repository, history, promptMessage } = draft;
  // With the caller sending a single message either way, `sendChatHistory`
  // is the only channel the viewer's toggle has left.
  const includeHistory =
    draft.chatApp?.sendChatHistory !== false && draft.settings.sendChatHistory !== false;
  const hydratedHistory = includeHistory
    ? await hydrateHistoryForPrompt(request.chatId, history, {
        store: repository.fileStore?.()
      })
    : [];
  // An e-mail, meeting or page is sent with every turn and stored once per
  // chat: when this turn carries it again, earlier turns do not repeat it.
  const currentItemIds = hostItemIds(promptMessage);
  const repeatsHostItem =
    currentItemIds.size > 0 &&
    hydratedHistory.some(entry =>
      entry.fileData?.some?.(file => currentItemIds.has(file.fileId || file.id))
    );
  // What the last answer's prompt held, stored with it: the context
  // figure of this turn starts from it rather than counting the history
  // again — only when this turn resends that prompt as it was. The
  // history is already cut at an edit or a regenerate; an item this turn
  // carries again is taken out of the earlier turn, which changes it.
  // The answer is the one the tracker finds (`isPriorAnswer`).
  draft.resendsHistory = includeHistory && !repeatsHostItem;
  draft.priorContext = draft.resendsHistory
    ? history.findLast(entry => isPriorAnswer(entry))?.context || null
    : null;
  const dedupedHistory = withoutFiles(hydratedHistory, currentItemIds);
  const record = draft.connectResume.record;
  if (record) {
    // No new message: the history ends with the question that failed.
    draft.conversation =
      includeHistory && dedupedHistory.length > 0
        ? historyForPrompt(dedupedHistory)
        : [{ role: 'user', content: record.question || '' }];
  } else if (includeHistory) {
    draft.conversation = [...historyForPrompt(dedupedHistory), promptMessage];
  } else {
    draft.conversation = [promptMessage];
  }
  return null;
}

/**
 * What the turn stores, and how (`persistence` of `ChatService.runTurn`).
 *
 * @param {Object} draft
 * @returns {null}
 */
function describePersistence(draft) {
  const { request, settings, chatProjects, projectTest } = draft;
  const newMessage = request.message;
  draft.persistence = {
    repository: draft.repository,
    ownerId: draft.owner.id,
    identityMode: draft.owner.mode,
    temporary: draft.temporary,
    // The stored history is never client-asserted; the message being
    // sent necessarily is — it only exists in this request.
    content: typeof newMessage.content === 'string' ? newMessage.content : '',
    // A resume after a connect stores no user message.
    silent: Boolean(draft.connectResume.record),
    clientMessageId: request.messageId,
    attachments: draft.attachments,
    variables: draft.turnVariables,
    replaceFromMessageId: draft.forkStoredId,
    // A message spoken in voice mode is marked, so the history can show
    // it. Only when voice mode is on, like the request builder.
    message: isVoiceTurn({
      voiceMode: request.voiceMode,
      platform: configCache.getPlatform(),
      features: configCache.getFeatures()
    })
      ? { metadata: { inputMode: VOICE_INPUT_MODE } }
      : undefined,
    // The container project and the attached projects this turn
    // names (`chatProjects`): written with the question under the
    // chat lock, against the chat as it stands then — a container
    // claimed by a racing first turn refuses this one with 409 — and
    // a new container records the chat in its project once that is
    // stored (`materializeUserTurn`), on the @workflow path too.
    ...(chatProjects.projectPatch ? { projects: chatProjects.projectPatch } : {}),
    projectId: chatProjects.containerId,
    // A test chat is marked as one, on every turn: the chat a turn creates
    // starts with it, and one a file upload created before the first
    // message gets it now. It is what keeps the chat out of the history.
    ...(projectTest
      ? {
          origin: projectTestOrigin(projectTest.projectId),
          chat: { origin: projectTestOrigin(projectTest.projectId) }
        }
      : {}),
    // How this turn is being answered, so reopening the chat comes
    // back with the same setup rather than the app's defaults. These
    // are the request's values over the stored ones
    // (`chatTurnSettings`); the repository merges them over what
    // earlier turns recorded, and `undefined` means neither has one.
    settings: normalizeChatSettings({
      style: settings.style,
      outputFormat: settings.outputFormat,
      sendChatHistory: settings.sendChatHistory,
      thinkingEnabled: settings.thinkingEnabled,
      thinkingLevel: settings.thinkingLevel,
      thinkingThoughts: settings.thinkingThoughts,
      enabledTools: settings.enabledTools,
      websearchEnabled: settings.websearchEnabled,
      imageAspectRatio: settings.imageAspectRatio,
      imageQuality: settings.imageQuality,
      integrationScopes: draft.integrationScopes
    })
  };
  return null;
}

/**
 * Hand a message that mentions a workflow (`@workflow`) to that workflow.
 *
 * @param {Object} draft
 * @returns {Promise<{refusal: TurnRefusal}|{answer: Object}|null>}
 */
async function handOffToWorkflow(draft) {
  const { request } = draft;
  trackSession(request.chatId, {
    appId: request.appId,
    userSessionId: request.client?.sessionId,
    userAgent: request.client?.userAgent
  });
  // A project test hands nothing on: an @mention stays plain text, for
  // the workflow would run with its own projects (#3309).
  const mention = draft.projectTest
    ? { handled: false }
    : await tryHandleMentionWorkflow({
        messages: [request.message],
        conversation: draft.conversation,
        chatId: request.chatId,
        appId: request.appId,
        messageId: request.messageId,
        modelId: draft.settings.modelId,
        user: draft.user,
        clientLanguage: draft.language,
        persistence: draft.persistence
      });
  if (!mention.handled) return null;
  // A refusal carries its status; its body is `{ error, code }` or `{ message }`.
  if (mention.statusCode >= 400) {
    return refused(mention.statusCode, mention.response.error ?? mention.response.message, {
      code: mention.response.code
    });
  }
  return { answer: mention.response };
}

/**
 * The steps of the preparation, in the order they run. A step answers with a
 * refusal or an answer, which ends the preparation, or with null.
 */
const PREPARE_STEPS = Object.freeze([
  authorizeTurn,
  scopeProjects,
  settlePendingClarifications,
  checkStorage,
  resolveOwner,
  prepareResumes,
  forkHistory,
  resolveVariablesAndScopes,
  readUploads,
  buildConversation,
  describePersistence,
  handOffToWorkflow
]);

/**
 * The prepared turn of a draft that passed every step.
 *
 * @param {Object} draft
 * @returns {PreparedTurn}
 */
function preparedTurnOf(draft) {
  const { request, settings, chatProjects, projectTest } = draft;
  return {
    chatId: request.chatId,
    appId: request.appId,
    messageId: request.messageId,
    user: draft.user,
    language: draft.language,
    requestOptions: {
      appId: request.appId,
      modelId: settings.modelId,
      messages: draft.conversation,
      style: settings.style,
      outputFormat: settings.outputFormat,
      language: draft.language,
      bypassAppPrompts: request.bypassAppPrompts,
      thinkingEnabled: settings.thinkingEnabled,
      thinkingLevel: settings.thinkingLevel,
      thinkingThoughts: settings.thinkingThoughts,
      enabledTools: settings.enabledTools,
      websearchEnabled: settings.websearchEnabled,
      imageAspectRatio: settings.imageAspectRatio,
      imageQuality: settings.imageQuality,
      requestedSkills: request.requestedSkills,
      documentIds: request.documentIds,
      voiceMode: request.voiceMode,
      user: draft.user,
      chatId: request.chatId,
      projectId: chatProjects.containerId,
      attachedProjectIds: chatProjects.attachedIds,
      ...(projectTest ? { testProjectId: projectTest.projectId } : {}),
      integrationScopes: draft.integrationScopes
    },
    persistence: draft.persistence,
    toolApproval: draft.toolApproval,
    commitApproval: draft.approvals.commit || null,
    commitConnectResume: draft.connectResume.commit || null,
    // A turn that answers a paused one (a clarification, a tool approval)
    // continues that run, so one answer is one run.
    pausedTurn: draft.answeredClarification || draft.approvals.pausedTurn || null,
    priorContext: draft.priorContext,
    resendsHistory: draft.resendsHistory,
    promptMessage: draft.promptMessage,
    mcpAppContext: request.mcpAppContext,
    // Only a client that draws the approval card can answer one.
    canApproveTools: request.toolApprovalCapable === true,
    clientTimezone: request.clientTimezone || null,
    origin: request.origin,
    sessionId: request.client?.sessionId,
    audited: () => draft.auditSubject._auditLogged === true
  };
}

/**
 * Prepare a chat turn: everything that can refuse it before anything is told
 * to its reader.
 *
 * The principal is passed resolved, next to the plain reference in the
 * request. Resolving it again from the reference would change who the turn
 * runs as: the groups of a signed-in user come from the token of the request,
 * and an anonymous caller is its guest cookie, which is bound to the very
 * object the request carries (`chatOwner.js`).
 *
 * @param {TurnRequest} request
 * @param {Object} host
 * @param {Object} [host.user] - The resolved principal `request.principalRef` names.
 * @param {(key: string, params: Object, language: string) => Promise<string>} host.getLocalizedError
 * @param {(params: {chatId: string, user: Object, lastMessage: Object}) =>
 *   Promise<{runId: string, interactionId: string}|null>} host.settleClarifications - Answers
 *   or supersedes the chat's pending questions for the new message, and names the run the
 *   message answered a question of. It decides through run access, so it lives with the caller.
 * @returns {Promise<TurnPreparation>}
 */
export async function prepareTurn(request, { user, getLocalizedError, settleClarifications }) {
  if (typeof getLocalizedError !== 'function' || typeof settleClarifications !== 'function') {
    throw new TypeError('prepareTurn needs getLocalizedError and settleClarifications');
  }
  const named = principalRefOf(user);
  const ref = request.principalRef;
  if (ref?.type !== named.type || ref?.id !== named.id) {
    throw new TypeError('The principal of a turn request is not the user it is prepared for');
  }
  const draft = { request, user, getLocalizedError, settleClarifications };
  for (const step of PREPARE_STEPS) {
    const ended = await step(draft);
    if (ended) return ended;
  }
  return { turn: preparedTurnOf(draft) };
}

/**
 * A stream of the caller's own that a turn is told on, as `openChatPostStream`
 * of `sse.js` answers it.
 *
 * @typedef {Object} TurnStream
 * @property {() => boolean} isOpen - The reader is still there.
 * @property {(envelope: Object) => boolean} write - Write a frame past the turn's emitter.
 * @property {(runId: string) => boolean} hasEnded - The run said its last word on this stream.
 * @property {() => void} end
 */

/**
 * Where a turn is told, beyond the chat's own stream. Without a sink, or with
 * one that opens no stream, the frames of the turn go to the stream the chat
 * holds (`GET /api/apps/{appId}/chat/{chatId}`), if any.
 *
 * @typedef {Object} TurnSink
 * @property {(turn: {chatId: string, runId: string, durable: boolean}) => TurnStream} [open] -
 *   Opens the caller's own stream. This is the commit point: from here on a
 *   refusal or a failure is told as frames on that stream, which the turn ends.
 * @property {(outcome: TurnOutcome) => void} [answer] - Called with the outcome of a
 *   turn that was not told on a stream of the sink, before the turn lets go of
 *   the chat (its durable mark, an approval or a connect to put back). A
 *   caller that answers a request does so here.
 * @property {() => void} [audited] - Called as soon as the turn wrote an audit
 *   entry of its own (a call resumed after a connect), before anything is
 *   answered. A caller whose request is audited marks the request here, so
 *   that the request-level audit adds no second entry.
 */

/**
 * How a turn ended.
 *
 * @typedef {Object} TurnOutcome
 * @property {'ran'|'failed'|'refused'|'abandoned'} status - `ran`: the turn ran to
 *   its end, whatever that end was; its run told it. `failed`: the model request
 *   could not be built, or the turn threw after its stream was open. `refused`:
 *   the approval, the connect or the chat's container refused the turn when it
 *   was about to run. `abandoned`: the reader of a temporary chat left before
 *   the turn started.
 * @property {boolean} told - The outcome was told on the sink's own stream;
 *   nothing is left to answer.
 * @property {{message: string, code?: string}} [error] - `failed`: the localized
 *   message and the code of a model request that could not be built.
 * @property {TurnRefusal} [refusal] - `refused`
 * @property {Object} [result] - `ran`: what `ChatService.runTurn` answered.
 */

/**
 * The error a refusal is thrown as: the same `ServiceError` a route answers.
 *
 * @param {TurnRefusal} refusal
 * @returns {ServiceError}
 */
export function refusalError(refusal) {
  return new ServiceError(refusal.code, refusal.message, {
    status: refusal.status,
    details: refusal.details
  });
}

/**
 * Tell a refusal or a failure on the turn's own stream, when no status line
 * can carry it any more.
 *
 * @param {Object} run - The state of the running turn
 * @param {Error} error
 */
function tellLate(run, error) {
  // A run that already ended on this stream has said its last word.
  if (run.stream.hasEnded(run.streamRunId)) return;
  for (const frame of lateRefusalFrames(run.turn.chatId, run.streamRunId, error)) {
    run.stream.write(frame);
  }
}

/**
 * The outcome of a turn that was refused when it was about to run.
 *
 * @param {Object} run
 * @param {{status: number, message: string, code?: string}} refusal
 * @returns {TurnOutcome}
 */
function refusedOutcome(run, refusal) {
  return {
    status: 'refused',
    told: Boolean(run.stream),
    ...refused(refusal.status, refusal.message, { code: refusal.code })
  };
}

/**
 * The commit point: from here the turn owns the chat, its run has a name, and
 * the caller's own stream is open.
 *
 * @param {Object} run
 * @returns {Promise<null>}
 */
async function commitTurn(run) {
  const { turn, sink } = run;
  const { chatId, persistence, pausedTurn } = turn;
  // The answer reaches the reader over the chat's stream only. In
  // cluster mode that stream may be held by another worker, opened a
  // moment ago — before this worker heard of it — so make sure it is
  // known here before the turn's first frame is routed (#3674). With no
  // stream anywhere the turn still runs and is stored; its frames have
  // nowhere to go.
  //
  // A turn told on a stream of its caller needs none of that: its frames
  // are written to that stream, which this worker holds.
  if (!sink?.open) await locateChatClient(chatId);

  // From here the turn owns the chat. A kept chat's turn has to survive
  // the browser closing — its answer is written to the store either way —
  // so the three paths that abort a run on disconnect must leave it alone
  // until the turn releases the mark (`releaseTurn`). A temporary chat's turn
  // is not: like the ephemeral turn it replaces, it stops when nobody is left
  // to read it, so an anonymous or incognito visitor who closes the tab is
  // not billed for the rest.
  if (!persistence.temporary) {
    markChatDurable(chatId);
    run.durable = true;
  }

  // Note that `hasChatClient` (inside `locateChatClient`) refreshed
  // lastActivity on the existing map entry in place rather than
  // replacing it: the SSE GET handler pins that object reference via
  // `myEntry` to identify a stale `req.on('close')` after a reconnect,
  // and replacing the entry would defeat that check, letting a dead
  // socket's close handler bail out and leak the Map entry +
  // activeRequests controller for up to 5 minutes until
  // cleanupInactiveClients evicts it.
  //
  // The turn's run is named before its model request is built (#3622): while
  // the prompt is built, the refresh of outdated project documents it
  // waits for is shown on that run, and the turn then runs as it (or
  // fails as it, so the status line ends with the turn).
  //
  // A turn that answers a paused one (a clarification, a tool approval) is
  // named after the paused run: it continues that run, so one answer is one
  // run (`ChatService.runTurn` falls back to a new id when the run cannot be
  // continued).
  run.continuesRun = Boolean(pausedTurn && isValidRunId(pausedTurn.runId));
  run.runId = run.continuesRun ? pausedTurn.runId : newRunId('chat');
  // The commit point of a stream of the caller: its headers go out now, so the
  // wait for outdated documents already streams. From here on a refusal is a
  // `stream/error` frame (see the catch of `runPreparedTurn`).
  if (sink?.open) {
    run.stream = sink.open({ chatId, runId: run.runId, durable: !persistence.temporary });
    run.streamRunId = run.runId;
    // Whether the reader is still there when a durable turn ends (the
    // stored answer is marked unread otherwise): this stream, or a GET
    // the client re-attached with after losing it.
    persistence.clientConnected = () => run.stream.isOpen() || hasChatClient(chatId);
  }
  return null;
}

/**
 * Build the model request of the turn (`ChatService.prepareChatRequest`).
 *
 * @param {Object} run
 * @returns {Promise<TurnOutcome|null>}
 */
async function buildModelRequest(run) {
  const { turn } = run;
  const refreshStatus = new RunStreamEmitter({ streamId: turn.chatId, runId: run.runId });
  const prep = await run.host.chatService.prepareChatRequest({
    ...turn.requestOptions,
    onKnowledgeRefresh: ({ total, done }) =>
      refreshStatus.emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
        phase: KNOWLEDGE_REFRESH_PHASE,
        data: { total, done }
      })
  });
  if (prep.success) {
    run.prep = prep.data;
    return null;
  }
  const message = await run.host.getLocalizedError(
    prep.error.code || 'internalError',
    {},
    turn.language
  );
  emitFailedRun(turn.chatId, {
    messageId: turn.messageId,
    code: prep.error.code,
    message,
    // Not the paused run's id: a second request answering the same
    // pause must not end the run the first one may be continuing.
    runId: run.continuesRun ? null : run.runId
  });
  // A stream of the caller carried those frames itself.
  return {
    status: 'failed',
    told: Boolean(run.stream),
    error: { message, code: prep.error.code }
  };
}

/**
 * Take the call this message resumes after a connect, exactly once. A turn
 * refused after this, before its loop started, puts it back (`releaseTurn`).
 *
 * @param {Object} run
 * @returns {Promise<TurnOutcome|null>}
 */
async function takeResumedCall(run) {
  const { turn } = run;
  if (!turn.commitConnectResume) return null;
  let committed;
  try {
    committed = await turn.commitConnectResume();
  } finally {
    // The call that was taken is audited (`connection.resume`). The caller hears
    // of it now, however the taking went on, and before anything is answered.
    if (turn.audited()) run.sink?.audited?.();
  }
  if (committed.refusal) {
    emitFailedRun(turn.chatId, {
      runId: run.runId,
      messageId: turn.messageId,
      code: committed.refusal.code,
      message: committed.refusal.message
    });
    // The failed run's frames (with the code) were the answer on a stream of the caller.
    return refusedOutcome(run, committed.refusal);
  }
  run.connectResume = committed.resume;
  run.restoreConnect = committed.restore;
  return null;
}

/**
 * Answer the approval this message carries, now that the turn can run. A turn
 * refused after this, before its loop started, puts the approval back
 * (`releaseTurn`).
 *
 * @param {Object} run
 * @returns {Promise<TurnOutcome|null>}
 */
async function answerApproval(run) {
  const { turn } = run;
  if (!turn.commitApproval) return null;
  const committed = await turn.commitApproval();
  if (committed.refusal) {
    emitFailedRun(turn.chatId, {
      // Not the paused run's id: a refused second answer must not end
      // the run the first one is continuing.
      runId: run.continuesRun ? null : run.runId,
      messageId: turn.messageId,
      code: committed.refusal.code,
      message: committed.refusal.message
    });
    // The failed run's frames (with the code) were the answer on a stream of the caller.
    return refusedOutcome(run, committed.refusal);
  }
  turn.toolApproval.grants = committed.grants;
  turn.toolApproval.resume = committed.resume;
  run.restoreApproval = committed.restore;
  return null;
}

/**
 * A temporary chat's reader that went away while the turn was prepared has
 * nobody left to answer: the disconnect could not abort a turn that had not
 * started yet.
 *
 * @param {Object} run
 * @returns {TurnOutcome|null}
 */
function stopForNobody(run) {
  if (run.stream && !run.stream.isOpen() && run.turn.persistence.temporary) {
    return { status: 'abandoned', told: true };
  }
  return null;
}

/**
 * What the logs of the turn record about it (`buildLogData` of
 * `ChatService.runTurn`). The model and the messages are known once the model
 * request is built.
 *
 * @param {Object} run
 * @returns {(streaming: boolean, extra?: Object) => Object}
 */
function logDataOf(run) {
  const { turn } = run;
  return (streaming, extra = {}) => ({
    messageId: turn.messageId,
    appId: turn.appId,
    modelId: run.model?.id,
    sessionId: turn.chatId,
    userSessionId: turn.sessionId,
    user: turn.user,
    messages: run.llmMessages,
    options: {
      style: turn.requestOptions.style,
      outputFormat: turn.requestOptions.outputFormat,
      language: turn.language,
      streaming
    },
    ...extra
  });
}

/**
 * Run the turn through the shared chat service. The turn streams over the
 * chat's channel and this resolves once it ended.
 *
 * @param {Object} run
 * @returns {Promise<TurnOutcome>}
 */
async function runModelTurn(run) {
  const { turn, prep, host } = run;
  const { promptMessage, mcpAppContext } = turn;
  run.model = prep.model;
  // What open MCP App views reported since the last turn; model-only.
  appendMcpAppContext(prep.llmMessages, mcpAppContext);
  run.llmMessages = prep.llmMessages;

  // Skills in force this turn are announced on the run: the usable
  // subset the request builder put in the system prompt, never a skill
  // the app or the user may not use. Each says who brought it in (the
  // user's `/name` or composer pick, the app, or an earlier message).
  const activatedSkills = announcedSkills(prep.activeSkills);

  // The prompt holds the history the last answer's context counted only
  // when the file budget left nothing of it out. A next turn resends this
  // prompt as it is only when, besides, nothing in it is this turn's
  // alone: the app's prompt template around the message, a host item
  // rendered from the request, what open views reported.
  const historyFilesOmitted = prep.historyFilesOmitted > 0;
  const turnOnlyContext = Boolean(
    (promptMessage?.promptTemplate && promptMessage?.variables) ||
    promptMessage?.hostContext ||
    renderMcpAppContext(mcpAppContext)
  );
  const buildLogData = logDataOf(run);
  await logInteraction('chat_request', buildLogData(true));

  const result = await host.chatService.runTurn({
    prep,
    chatId: turn.chatId,
    messageId: turn.messageId,
    runId: run.runId,
    ...(run.continuesRun ? { continueRun: { interactionId: turn.pausedTurn.interactionId } } : {}),
    activatedSkills,
    streaming: true,
    buildLogData,
    timeoutMs: host.timeoutMs,
    getLocalizedError: host.getLocalizedError,
    language: turn.language,
    user: turn.user,
    persistence: turn.persistence,
    toolApproval: turn.toolApproval,
    connectResume: run.connectResume,
    canApproveTools: turn.canApproveTools,
    ...(turn.clientTimezone ? { clientTimezone: turn.clientTimezone } : {}),
    priorContext: historyFilesOmitted ? null : turn.priorContext,
    promptResent: turn.resendsHistory && !historyFilesOmitted && !turnOnlyContext
  });
  // Refused at persistence: the chat's container changed under the
  // turn (`settleUserTurn`), and nothing of it was stored.
  if (result?.refusal) {
    const outcome = refusedOutcome(run, {
      status: 409,
      message: result.refusal.message,
      code: result.refusal.code
    });
    // The failed run's frames, when ChatService emitted them, were the answer on a
    // stream of the caller; a refusal before the run started has none and is told now.
    if (run.stream) tellLate(run, refusalError(outcome.refusal));
    return outcome;
  }
  return { status: 'ran', told: Boolean(run.stream), result };
}

/**
 * The steps of a run, in the order they run. A step answers with the outcome
 * that ends the turn, or with null.
 */
const RUN_STEPS = Object.freeze([
  commitTurn,
  buildModelRequest,
  takeResumedCall,
  answerApproval,
  stopForNobody,
  runModelTurn
]);

/**
 * Let go of the chat. The turn is over however it ended, so a disconnect from
 * here on has nothing to protect and should abort again.
 *
 * @param {Object} run
 * @returns {Promise<void>}
 */
async function releaseTurn(run) {
  const { turn } = run;
  try {
    if (run.durable) clearChatDurable(turn.chatId);
    // Answered, but the turn was refused (or failed) before its loop
    // could run the call: put the approval back, with its answer, so the
    // same decision can be sent again.
    if (run.restoreApproval && !turn.toolApproval?.started) await run.restoreApproval();
    // Never after the loop started: the call may have run.
    if (run.restoreConnect && !run.connectResume?.started) await run.restoreConnect();
  } finally {
    // Ended however the restores went: the reader is waiting for it.
    run.stream?.end();
    // A run refused late ended with frames written straight to the
    // stream, past the emit observer that frees its partial state.
    if (run.streamRunId) dropRun(run.streamRunId);
  }
}

/**
 * Run a prepared turn to its end, and let go of the chat.
 *
 * Without a stream of the caller, a refusal is the returned outcome and a
 * failure is thrown: the caller answers them. On a stream of the caller both
 * are told there as frames, and the outcome says so (`told`).
 *
 * @param {PreparedTurn} turn - From {@link prepareTurn}; a prepared turn runs once.
 * @param {Object} host
 * @param {TurnSink|null} [host.sink] - Where the turn is told beyond the chat's own stream.
 * @param {Object} host.chatService - The `ChatService` that builds the model request and
 *   runs the turn.
 * @param {(key: string, params: Object, language: string) => Promise<string>} host.getLocalizedError
 * @param {number} host.timeoutMs - The request timeout of a model call.
 * @returns {Promise<TurnOutcome>}
 */
export async function runPreparedTurn(
  turn,
  { sink = null, chatService, getLocalizedError, timeoutMs }
) {
  const run = {
    turn,
    sink,
    host: { chatService, getLocalizedError, timeoutMs },
    durable: false,
    stream: null,
    streamRunId: null,
    restoreApproval: null,
    restoreConnect: null,
    connectResume: null
  };
  try {
    let outcome = null;
    for (const step of RUN_STEPS) {
      outcome = await step(run);
      if (outcome) break;
    }
    if (!outcome.told) sink?.answer?.(outcome);
    return outcome;
  } catch (error) {
    // Without a stream of its own the caller answers: a refusal and a
    // failing model call are answered as they are.
    if (!run.stream) throw error;
    const expected = error instanceof ServiceError || isLLMError(error);
    // Only an unexpected failure is logged here.
    if (!expected) logger.error('Error in app chat', { component: COMPONENT, error });
    // Past the commit point the status line is gone: the refusal is a frame.
    tellLate(run, error);
    return { status: 'failed', told: true };
  } finally {
    await releaseTurn(run);
  }
}
