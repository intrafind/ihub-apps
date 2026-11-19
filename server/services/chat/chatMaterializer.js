// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Materialization — the only module that writes chat turns to durable storage.
 *
 * A turn becomes two writes: the human half at run start and the assistant
 * half at run end. Both are best effort *with respect to the turn* — a storage
 * failure never fails a chat that is otherwise fine — but they are not best
 * effort with respect to silence: every failure is logged at `error`, because
 * a chat that quietly stopped being persisted is a bug the operator has to see
 * before the user does.
 *
 * Nothing here decides *how* a turn is stored — kept or temporary. That is
 * `chatPersistence.resolveChatStorage()`, evaluated once per request by the
 * route; this module is handed a repository and the answer.
 *
 * @module services/chat/chatMaterializer
 */
import { boundStoredViews } from '../mcp/mcpApps.js';
import { boundStoredSources } from './chatSources.js';
import { boundStoredProposals } from '../scheduler/tasks/proposals.js';
import { generatedFileKind, generatedFilesOf } from '../../../shared/generatedFiles.js';
import { boundStoredActivity, takeRunActivity } from './runActivity.js';
import { insertSupportMarkers } from '../../../shared/sources/index.js';
import { recordChatEvidence } from './evidenceRecord.js';
import { inBackground } from './ChatEvidenceRepository.js';

/** Connect cards kept per stored answer. */
const MAX_STORED_AUTH_PROMPTS = 10;

/**
 * The Connect cards of a turn as stored with the answer
 * (`integrationAuthRequired`): well-formed entries only, one per integration,
 * bounded. See `chatSeams.authRequiredOf` for the shape.
 *
 * @param {unknown} prompts
 * @returns {Array<{integration: string, name: string, reason: string, action?: string, scopes?: string[]}>}
 */
export function boundStoredAuthPrompts(prompts) {
  if (!Array.isArray(prompts)) return [];
  const out = [];
  for (const p of prompts) {
    const entry = storedAuthPromptOf(p);
    if (!entry || out.some(existing => existing.integration === entry.integration)) continue;
    out.push(entry);
    if (out.length >= MAX_STORED_AUTH_PROMPTS) break;
  }
  return out;
}

/**
 * One stored Connect card, well-formed, or null when it names no
 * integration. Scopes are kept as non-empty strings, and left out when none
 * remain.
 *
 * @param {unknown} p
 * @returns {{integration: string, name: string, reason: string, action?: string, scopes?: string[]}|null}
 */
function storedAuthPromptOf(p) {
  if (!p || typeof p.integration !== 'string' || !p.integration) return null;
  const scopes = Array.isArray(p.scopes)
    ? p.scopes.filter(scope => typeof scope === 'string' && scope)
    : [];
  return {
    integration: p.integration,
    name: typeof p.name === 'string' && p.name ? p.name : p.integration,
    reason: typeof p.reason === 'string' ? p.reason : 'not_connected',
    ...(typeof p.action === 'string' && p.action ? { action: p.action } : {}),
    ...(scopes.length > 0 ? { scopes } : {})
  };
}
import logger from '../../utils/logger.js';
import { chatProjectConflict, deriveChatTitle } from './ChatRepository.js';
import { getProjectService } from '../projects/ProjectService.js';
import { recordChatInProject } from '../knowledge/chatProjects.js';
import { cardCounts, storeGeneratedArtifacts, storeGeneratedFilesNow } from './turnArtifacts.js';

export { storeGeneratedArtifacts, storeGeneratedFilesNow };
import { boundAnswerBasis } from './answerBasis.js';

const COMPONENT = 'chatMaterializer';

/**
 * Attachment descriptors for a stored message and for the `message/user`
 * ledger event, which validates this exact shape. Only the descriptor
 * survives: the base64 payload of an upload belongs in the request, never in a
 * document that is read back for as long as the chat lives.
 *
 * The field names are read generously because the upload shapes differ: the
 * chat client sends `{ type: 'document', fileName, fileSize, fileType }`,
 * where `type` is the upload *kind* and the mime type lives on `fileType`.
 * Recording the kind as the type would lose which format was sent, so a real
 * mime type wins when one is present.
 *
 * @param {Array<Object>} [attachments] - upload metadata as the route saw it
 * @returns {Array<{type: string, name?: string, bytes?: number, textBytes?: number,
 *   pageImageCount?: number, truncated?: boolean, sentToModel?: false}>}
 */
export function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => {
      const id = entry.id || entry.fileId;
      const name = entry.name || entry.fileName;
      const bytes = Number(entry.bytes ?? entry.size ?? entry.fileSize);
      return {
        ...(typeof id === 'string' && id ? { id } : {}),
        type: String(entry.fileType || entry.mimeType || entry.type || 'file'),
        ...(name ? { name: String(name) } : {}),
        ...(Number.isFinite(bytes) ? { bytes } : {}),
        ...(typeof entry.hasOriginal === 'boolean' ? { hasOriginal: entry.hasOriginal } : {}),
        ...(typeof entry.canUseAsTemplate === 'boolean'
          ? { canUseAsTemplate: entry.canUseAsTemplate }
          : {}),
        // What the server read from the file (see `describeStored`)
        ...(Number.isFinite(entry.textBytes) ? { textBytes: entry.textBytes } : {}),
        ...(entry.pageImageCount > 0 ? { pageImageCount: entry.pageImageCount } : {}),
        ...(entry.truncated === true ? { truncated: true } : {}),
        // A stored picture a regenerated turn did not send to the model again
        ...(entry.sentToModel === false ? { sentToModel: false } : {})
      };
    });
}

/**
 * The generated files of a turn as the stored answer keeps them: those stored
 * while the turn ran ({@link storeGeneratedFilesNow}) by their artifact, the
 * others still to store, and the ids of stored files a later one replaced
 * (same name and type, see `generatedFilesOf`).
 */
function splitGeneratedFiles(generatedFiles) {
  const raw = Array.isArray(generatedFiles) ? generatedFiles : [];
  const artifactById = new Map(
    raw
      .filter(file => file?.stored === true && typeof file.artifact?.id === 'string')
      .map(file => [file.artifact.id, file.artifact])
  );
  const kept = generatedFilesOf(raw).map(file =>
    file.stored && artifactById.has(file.id) ? { artifact: artifactById.get(file.id) } : { file }
  );
  const keptIds = new Set(kept.filter(entry => entry.artifact).map(entry => entry.artifact.id));
  return {
    kept,
    replaced: [...artifactById.keys()].filter(id => !keptIds.has(id))
  };
}

/** Delete stored files a later version replaced, except what a share retains. */
async function deleteReplacedFiles(repository, chatId, ids) {
  const store = repository?.artifactStore?.();
  if (!store || typeof store.deleteMany !== 'function') return;
  const retained =
    typeof repository.shareStore === 'function'
      ? await repository.shareStore().artifactIdsRetainedByShares(chatId)
      : new Set();
  const deletable = ids.filter(id => !retained.has(id));
  if (deletable.length > 0) await store.deleteMany({ type: 'chat', id: chatId }, deletable);
}

/**
 * Usage as stored on a message: the three counters, plus the provider's
 * cache read/write and reasoning counts when it reported them. Nothing else
 * provider-specific.
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.promptTokens) || 0;
  const completionTokens = Number(usage.completionTokens) || 0;
  const totalTokens = Number(usage.totalTokens) || promptTokens + completionTokens;
  if (!promptTokens && !completionTokens && !totalTokens) return null;
  const stored = { promptTokens, completionTokens, totalTokens };
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = Number(usage[key]);
    if (usage[key] !== undefined && Number.isFinite(value) && value >= 0) stored[key] = value;
  }
  return stored;
}

/**
 * The context-window state a turn ended with (see `loop/contextTracker.js`),
 * or null: what the chat reopens with, and what the next turn's context
 * figure starts from (`systemTokens`: the system prompt's share of it, which
 * the next turn replaces with its own).
 */
function normalizeContext(context) {
  if (!context || typeof context !== 'object') return null;
  const contextWindow = Math.round(Number(context.contextWindow));
  const inputTokens = Math.round(Number(context.inputTokens));
  if (!(contextWindow > 0) || !(inputTokens >= 0)) return null;
  const maxOutputTokens = Math.round(Number(context.maxOutputTokens));
  const systemTokens = Math.round(Number(context.systemTokens));
  return {
    contextWindow,
    inputTokens,
    maxOutputTokens: maxOutputTokens > 0 ? maxOutputTokens : 0,
    source: context.source === 'provider' ? 'provider' : 'estimate',
    ...(systemTokens >= 0 && context.systemTokens != null ? { systemTokens } : {}),
    // The model it was counted for: another model's figure is not started from.
    ...(typeof context.modelId === 'string' && context.modelId ? { modelId: context.modelId } : {})
  };
}

/**
 * The error to record on a stored assistant message, or null when the turn
 * ended cleanly. An abort is recorded too: "the user stopped it" is part of
 * what happened, and without it a truncated answer reads as a complete one.
 */
function messageError(summary) {
  if (summary?.status === 'aborted') return abortedError(summary.abortCause);
  if (summary?.status !== 'error') return null;
  return failedError(summary.errorInfo || summary.error);
}

/** The cause says who stopped it; a turn from before causes were recorded keeps the generic sentence. */
function abortedError(cause) {
  return {
    code: 'ABORTED',
    message: cause?.message || 'Turn stopped before it finished.',
    ...(cause ? { cause } : {})
  };
}

function failedError(info) {
  if (!info) return { code: 'ERROR', message: 'Turn failed.' };
  return { code: String(info.code || 'ERROR'), message: String(info.message || info) };
}

/**
 * Write the human half of a turn: create the chat if this is its first
 * message, mark it busy for the run, and append the user message.
 *
 * Called at run start, before the first client frame, so the chat document
 * exists by the time anything can ask for it. Marking the chat `running` with
 * a live `activeRunId` up front is also what lets a delete cascade into this
 * run's ledger if the process dies mid-turn.
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').default} params.repository
 * @param {string} params.chatId
 * @param {string} params.ownerId - run principal, resolved once by the route
 * @param {string} params.identityMode - the mode `ownerId` was resolved in
 * @param {string} [params.appId]
 * @param {string} [params.modelId]
 * @param {Object} [params.settings] - How this turn was answered (style, tools,
 *   websearch, thinking …), so reopening the chat restores it
 * @param {Object} [params.variables] - App variables this turn set; later turns
 *   and a reopened chat read them from the chat instead of resending them
 * @param {string} params.runId
 * @param {string} params.content - raw text of the new user message
 * @param {string} [params.clientMessageId] - client exchange id, for reconciling an
 *   optimistic render instead of duplicating it
 * @param {Array<Object>} [params.attachments] - already-normalized descriptors
 * @param {string} [params.replaceFromMessageId] - truncate the stored history from this
 *   message (inclusive) before appending — an edit or a regenerate
 * @param {Object} [params.message] - extra fields for the stored message (`variables`,
 *   `renderedContent`); the repository keeps the ones it knows
 * @param {Object} [params.chat] - extra fields patched onto the chat document with this turn
 * @param {import('../knowledge/chatProjects.js').ProjectPatch} [params.projects] - the
 *   container this turn opens the chat in and the projects it attaches
 *   (`resolveChatProjects`), applied with the chat patch under the chat lock against the
 *   chat as it stands then (`ChatRepository.updateChatProjects`); a claimed container also
 *   records the chat in that project once it is stored
 * @param {string|null} [params.projectId] - the container this turn was prepared for
 *   (`resolveChatProjects().containerId`, null for none): the question is appended only
 *   while the chat is still in it, checked in the same lock as the append, so a question
 *   asked outside a project never lands in a chat a racing turn opened in one. Omitted,
 *   the container is not checked.
 * @param {Object} [params.origin] - how a chat created by this turn came about
 *   (`{ createdVia, clientId? }`); a chat the turn creates without one came from the UI
 * @param {string} [params.titleText] - what a chat this turn names is named after,
 *   when that is not the message itself (an `@workflow` turn: the text without the mention)
 * @param {boolean} [params.temporary] - create the chat as a temporary one
 *   (`chatPersistence.resolveChatStorage`); a chat that already exists keeps what it is
 * @returns {Promise<Object|null>} the stored message, or null when nothing was written
 */
export async function materializeUserTurn(params) {
  return (await settleUserTurn(params)).message;
}

/**
 * {@link materializeUserTurn}, and why nothing was written when the turn is
 * refused: `refusal` is `{ code: 'PROJECT_MISMATCH', message }` when the chat's
 * container changed under the turn (a first turn that raced it opened the chat
 * in another project), which the caller answers as a 409. Nothing of the turn
 * is stored then, the chat document included.
 *
 * @param {Parameters<typeof materializeUserTurn>[0]} params
 * @returns {Promise<{message: Object|null, refusal: {code: string, message: string}|null}>}
 */
export async function settleUserTurn({
  repository,
  chatId,
  ownerId,
  identityMode,
  appId,
  modelId,
  settings,
  variables,
  runId,
  content,
  clientMessageId,
  attachments,
  replaceFromMessageId,
  message = null,
  chat: chatPatch = null,
  projects = null,
  projectId: preparedProjectId,
  origin = null,
  titleText = null,
  temporary = false,
  silent = false
}) {
  const none = { message: null, refusal: null };
  if (!repository) return none;
  const text = typeof content === 'string' ? content : '';
  const title = deriveChatTitle(
    typeof titleText === 'string' && titleText.trim() ? titleText : text
  );
  const descriptors = normalizeAttachments(attachments);
  try {
    const chat = await repository.ensureChat({
      chatId,
      ownerId,
      identityMode,
      appId,
      modelId,
      settings,
      title,
      origin: origin || { createdVia: 'ui' },
      temporary: temporary === true
    });
    if (!chat) {
      logger.error('Chat user turn not materialized: storage unavailable', {
        component: COMPONENT,
        chatId,
        runId
      });
      return none;
    }
    const turnPatch = {
      ...(chatPatch && typeof chatPatch === 'object' ? chatPatch : {}),
      activeRunId: runId,
      status: 'running',
      // The sender is demonstrably present, so nothing in this chat is unseen.
      hasUnseenActivity: false,
      ...(modelId ? { modelId } : {}),
      // How the user has this chat set up right now. The repository merges,
      // so a turn that changed one toggle does not reset the others.
      ...(settings ? { settings } : {}),
      // Replaces the stored set; a turn without variables keeps it.
      ...(variables ? { variables } : {}),
      // A chat opened by an empty auto-start turn has no title yet; the first
      // message carrying text names it. A title the user set is never touched.
      ...(!chat.title && title && !chat.titleSetByUser ? { title } : {})
      // No `runIds` here: the repository derives them from `activeRunId` on
      // every patch, so that a run the delete cascade owes the ledger is
      // recorded whether or not a message from it ever landed. Computing them
      // here as well meant a second implementation of the same cap, and the
      // two disagreed on where a repeated id lands in the list.
    };
    let stored = null;
    // Without projects the turn's patch rides along with the question: one
    // chat lock and one chat write instead of two of each.
    const coalesced = !(projects && typeof projects === 'object');
    if (!coalesced) {
      const applied = await repository.updateChatProjects(chatId, projects, turnPatch);
      if (applied?.conflict) {
        logRefusal(chatId, runId, applied.chat);
        return { message: null, refusal: projectRefusal(applied.chat) };
      }
      stored = applied?.chat ?? null;
      // A chat that opens inside a project is recorded there (the marker the
      // project page lists chats by) only once the chat document carries the
      // association: the listing prunes a marker its chat does not back, and
      // a marker written before this patch could be pruned for good.
      // A temporary chat is never listed, the project page included: it
      // runs with the project's knowledge, but its members never see it.
      if (projects.claimContainer && stored && stored.temporary !== true) {
        await recordChatInProject(projects.claimContainer, chatId, {
          ownerId,
          private: projects.privateContainer === true
        });
      }
    }
    // A resume after a connect (#3752) claims the chat for its run but stores
    // no user message: nobody wrote one. Without projects nothing above wrote
    // the turn's patch, so the claim is that patch on its own.
    if (silent) {
      if (coalesced) await repository.updateChat(chatId, turnPatch);
      return { message: null, refusal: null };
    }
    const userMessage = {
      ...(message && typeof message === 'object' ? message : {}),
      role: 'user',
      content: text,
      ts: new Date().toISOString(),
      runId,
      ...(clientMessageId ? { clientMessageId: String(clientMessageId) } : {}),
      ...(descriptors.length > 0 ? { attachments: descriptors } : {})
    };
    let appended;
    try {
      appended = await repository.appendMessage(chatId, userMessage, {
        ...(replaceFromMessageId ? { replaceFromMessageId } : {}),
        ...(preparedProjectId !== undefined ? { expectedProjectId: preparedProjectId } : {}),
        ...(coalesced ? { chatPatch: turnPatch } : {})
      });
    } catch (appendError) {
      // The run goes ahead without its question stored; the chat still says
      // it is running, as it did when the patch was written first, so the
      // answer's release finds the run it has to release.
      if (coalesced) await repository.updateChat(chatId, turnPatch).catch(() => {});
      throw appendError;
    }
    if (coalesced) stored = appended?.chat ?? null;
    if (appended?.conflict) {
      // The container changed between this turn's patch and its question (a
      // racing first turn claimed it): nothing is appended, and the chat is
      // handed back unless the racing turn already holds it.
      const current = await repository.getChat(chatId);
      logRefusal(chatId, runId, current);
      await repository.releaseRun(chatId, runId, { activeRunId: null, status: 'active' });
      return { message: null, refusal: projectRefusal(current) };
    }
    // A turn inside a project is activity on the project (retention counts
    // conversations, not only attachments); throttled and never fatal.
    const projectId = stored?.projectId ?? chat.projectId ?? null;
    if (appended?.message && projectId) {
      getProjectService()
        .noteChatTurn(projectId)
        .catch(() => {});
    }
    return { message: appended?.message ?? null, refusal: null };
  } catch (error) {
    logger.error('Chat user turn not materialized', {
      component: COMPONENT,
      chatId,
      runId,
      error: error.message
    });
    return none;
  }
}

/** The refusal of a turn whose chat is, by now, in another container. */
function projectRefusal(chat) {
  return {
    code: 'PROJECT_MISMATCH',
    message: chat?.projectId
      ? 'This chat already runs inside a project; move it with PATCH /api/chats/:id'
      : 'This chat already has messages outside a project; move it with PATCH /api/chats/:id'
  };
}

function logRefusal(chatId, runId, chat) {
  logger.warn('Chat user turn refused: the chat project changed under the turn', {
    component: COMPONENT,
    chatId,
    runId,
    projectId: chat?.projectId || null
  });
}

/**
 * Whether a turn's project fields still hold against the stored chat, read
 * before the turn takes the chat over: a turn refused here supersedes nothing,
 * so a conflicting request leaves the accepted turn running. Advisory only —
 * {@link settleUserTurn} checks again under the chat lock.
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').default} params.repository
 * @param {string} params.chatId
 * @param {import('../knowledge/chatProjects.js').ProjectPatch|null} [params.projects]
 * @param {string|null} [params.projectId] - See {@link materializeUserTurn}.
 * @returns {Promise<{code: string, message: string}|null>} The refusal, or null.
 */
export async function admitTurnProjects({ repository, chatId, projects = null, projectId }) {
  if (!repository || (!projects && projectId === undefined)) return null;
  try {
    const chat = await repository.getChat(chatId);
    if (!chat) return null;
    const conflict =
      (projects && chatProjectConflict(chat, projects)) ||
      (!projects?.claimContainer && chatProjectConflict(chat, { expectedContainer: projectId }));
    return conflict ? projectRefusal(chat) : null;
  } catch {
    // A read that failed admits the turn: the check under the lock still runs.
    return null;
  }
}

/**
 * Write the assistant half of a turn and release the chat.
 *
 * Called once per turn at the single choke point before the ledger's
 * `run/end`, so every terminal shape — normal, aborted, error, passthrough
 * answer, malformed response — lands here with the same summary.
 *
 * The answer is appended first and the chat released after. `releaseRun`
 * clears `activeRunId` and raises `hasUnseenActivity` — together, "this chat
 * is idle and has an answer waiting" — and the two calls take the chat lock
 * separately, so there is a window between them. Releasing first puts a reader
 * in that window in front of a settled chat whose answer is not stored yet:
 * `GET /api/chats/:id` clears the unseen flag, returns a transcript without
 * the answer, and the flag never comes back. This order can only show a chat
 * as briefly still running, which the next poll corrects.
 *
 * Appending to a chat whose document is gone is safe in this order:
 * `appendMessage` warns and returns null rather than creating an orphan.
 *
 * "Released" is conditional on this run still owning the chat. A superseded
 * turn finishes after its replacement has already claimed the chat, and it
 * must not announce the chat idle while the replacement is generating, nor
 * push its answer behind the replacement's question — both are permanent, and
 * the second one is replayed to the model on every later turn.
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').default} params.repository
 * @param {string} params.chatId
 * @param {string} params.runId
 * @param {Object} params.summary - the turn outcome: `status`, `content`, `finishReason`,
 *   `usage`, `images` (generated pictures, stored beside the transcript as
 *   artifacts), `mcpApps`, `sources` (see `chatSources.js`), `activity`
 *   (what the run did, when it was not recorded — see `runActivity.js`), and
 *   `error`/`errorInfo` on a failure
 * @param {boolean} params.clientConnected - whether an SSE client was attached when the
 *   turn ended, sampled with `hasChatClient()`; the emit result cannot tell you
 * @param {Object} [params.message] - extra fields for the stored answer (`model`). A
 *   validated structured answer (`summary.structuredOutput`) is stored as `output` too.
 * @param {boolean} [params.onlyIfUnanswered=false] - store nothing when the run is
 *   already answered (checked under the chat lock); for a writer that is not the run
 *   itself and may race another one (`chatRecovery.js`)
 * @param {string} [params.supersedeMessageId] - store the answer in place of this
 *   stored message of the run rather than after the run's question; nothing is
 *   stored when it is gone (`chatRecovery.js`, a resumed workflow's result)
 * @param {Object} [params.runLog] - the run journal the evidence record is built
 *   from, in the background after the answer is stored; the shared RunLog by default
 * @returns {Promise<Object|null>} the stored message, or null when nothing was written
 */
export async function materializeAssistantTurn(params) {
  return (await settleAssistantTurn(params)).message;
}

/**
 * {@link materializeAssistantTurn}, reporting what happened rather than only
 * the stored message — for a caller that has to tell "somebody else answered
 * this run" from "the answer could not be written" (`chatRecovery.js`).
 *
 * @param {Object} params - see {@link materializeAssistantTurn}
 * @returns {Promise<{message: Object|null, skipped: boolean, released: boolean}>}
 *   `skipped` when `onlyIfUnanswered` found the run answered or the message to
 *   supersede is gone; `released` when this call released the chat from the run
 */
export async function settleAssistantTurn({
  repository,
  chatId,
  runId,
  summary,
  clientConnected,
  message = null,
  onlyIfUnanswered = false,
  supersedeMessageId = null,
  runLog = null
}) {
  const outcome = { message: null, skipped: false, released: false };
  if (!repository) return outcome;
  const status = summary?.status;
  const content = typeof summary?.content === 'string' ? summary.content : '';
  const error = messageError(summary);
  const usage = normalizeUsage(summary?.usage);
  const storedContext = normalizeContext(summary?.context);
  // Taken unconditionally, so the recording ends with the turn whatever is
  // stored. A caller that rebuilt the activity itself (a run whose process
  // died, see `chatRecovery.js`) hands it over on the summary.
  const recorded = takeRunActivity(runId);
  try {
    // A turn that paused for a clarification produced no answer — the question
    // is an interaction, not a message. Everything else is recorded, an empty
    // answer and an abort included, so the stored history says what happened.
    // The run is still released below either way, or the chat stays "running".
    const pausedWithoutAnswer = status === 'paused' && !content && !error;

    // Before the append, because the descriptors it produces are part of the
    // message. The reverse cost is a payload nothing points at when the append
    // fails — swept when the chat is deleted — against a descriptor pointing
    // at nothing, which renders as a broken picture for the life of the chat.
    //
    // The loop reports generated pictures on `summary.images`; they are stored
    // as artifacts of kind `image`, which is the vocabulary the stored message
    // and the artifact endpoints use. Files a system skill tool generated (a
    // PDF from `create_pdf`, a source file from `create_file`) come on
    // `summary.generatedFiles` and are stored as artifacts of kind `document`,
    // `code` or `archive` (see `generatedFileKind`).
    //
    // A file the turn's tools generated is usually stored already, when the
    // tool finished (`storeGeneratedFilesNow`): its artifact is taken as it
    // is, and one a later version replaced is deleted below.
    const { kept: keptFiles, replaced: replacedFiles } = splitGeneratedFiles(
      summary?.generatedFiles
    );
    const images = summary?.images || [];
    const toStore = keptFiles.filter(entry => entry.file).map(entry => entry.file);
    const newlyStored = pausedWithoutAnswer
      ? []
      : await storeGeneratedArtifacts({
          chatId,
          runId,
          artifacts: [
            ...images.map(image => ({ ...image, kind: 'image' })),
            ...toStore.map(file => ({
              kind: generatedFileKind(file.mimeType),
              mimeType: file.mimeType,
              data: file.data,
              name: file.name
            }))
          ],
          alreadyStored: keptFiles.length - toStore.length,
          // Through the chat's own store rather than the shared getter: one
          // place decides where a chat's artifacts live, and it is the
          // repository this turn is already writing through.
          store: repository?.artifactStore?.()
        });
    let artifacts = [];
    if (!pausedWithoutAnswer) {
      // `storeGeneratedArtifacts` describes only what had bytes, in order.
      const described = [...newlyStored];
      const imageCount = images.filter(
        image => image && typeof image.data === 'string' && image.data
      ).length;
      const imageDescriptors = described.splice(0, imageCount);
      const fileDescriptors = keptFiles.flatMap(entry => {
        if (entry.artifact) return [entry.artifact];
        if (typeof entry.file.data !== 'string' || !entry.file.data) return [];
        const descriptor = described.shift();
        return descriptor ? [{ ...descriptor, ...cardCounts(entry.file) }] : [];
      });
      artifacts = [...imageDescriptors, ...fileDescriptors];
    }

    // Store the answer BEFORE announcing the run finished. `releaseRun` clears
    // `activeRunId` and raises `hasUnseenActivity` — together, "this chat is
    // idle and has an answer waiting" — and the two calls take the chat lock
    // separately, so there is a window between them. In the other order a
    // reader lands in that window and sees a settled chat whose answer is not
    // stored yet: `GET /api/chats/:id` then clears the unseen flag and returns
    // a transcript without the answer, and the flag never comes back. This
    // order can only ever show a chat as briefly still running, which the next
    // poll corrects.
    // The append gets its own catch so the release below is unconditional.
    // Sharing one try meant a rejecting `appendMessage` skipped `releaseRun`
    // entirely and landed in the outer catch, which only logs — leaving the
    // chat claiming a run that has ended, with nothing in the tree to correct
    // it. And it does reject: `appendMessage` runs under a 15 s lease with a
    // 5 s wait budget, so a worker killed mid-write guarantees the next waiter
    // times out. A chat stuck `running` then makes every later open replay a
    // dead run and spin on an empty placeholder. Losing the answer is bad;
    // losing the answer *and* wedging the chat is worse.
    // MCP App views the turn rendered (tool input + result per view), bounded
    // so a chat document cannot grow without limit.
    const mcpApps = pausedWithoutAnswer ? [] : boundStoredViews(summary?.mcpApps);
    // Connect cards for integrations the user has to connect first (see chatSeams.authRequiredOf).
    const integrationAuthRequired = pausedWithoutAnswer
      ? []
      : boundStoredAuthPrompts(summary?.integrationAuthRequired);
    // Confirmation cards for scheduled tasks the scheduling tools proposed.
    const scheduledTaskProposals = pausedWithoutAnswer
      ? []
      : boundStoredProposals(summary?.scheduledTaskProposals);
    // What the turn did before it answered — searches, documents, tool calls,
    // workflow steps — so a user coming back can see how the answer came about.
    const activity = pausedWithoutAnswer
      ? null
      : boundStoredActivity(summary?.activity ?? recorded);
    // Everything the turn found, so the reopened chat shows the same sources
    // panel and inline citations. Google's grounding supports are turned into
    // citation markers in the stored text (the live chat places them the same
    // way); what is stored beside it is the sources and queries.
    const sources = pausedWithoutAnswer ? null : boundStoredSources(summary?.sources);
    // What the answer is based on: the footer's basis chip, kept with the answer.
    const answerBasis = pausedWithoutAnswer ? undefined : boundAnswerBasis(summary?.answerBasis);
    const storedContent =
      sources && Array.isArray(summary?.sources?.supports)
        ? insertSupportMarkers(content, summary.sources.supports)
        : content;

    const releasePatch = {
      activeRunId: null,
      status: status === 'error' ? 'error' : 'active',
      // Nobody was watching when the answer landed, so the history list marks
      // the chat until it is opened.
      hasUnseenActivity: !clientConnected
    };
    let appended = null;
    if (!pausedWithoutAnswer) {
      try {
        const structured = summary?.structuredOutput;
        appended = await repository.appendMessage(
          chatId,
          {
            ...(message && typeof message === 'object' ? message : {}),
            ...(structured?.valid === true && structured.value !== undefined
              ? { output: structured.value }
              : {}),
            role: 'assistant',
            content: storedContent,
            ts: new Date().toISOString(),
            runId,
            finishReason: summary?.finishReason ?? null,
            ...(summary?.limitReachedIn ? { limitReachedIn: summary.limitReachedIn } : {}),
            ...(usage ? { usage } : {}),
            ...(storedContext ? { context: storedContext } : {}),
            ...(error ? { error } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(mcpApps.length > 0 ? { mcpApps } : {}),
            ...(integrationAuthRequired.length > 0 ? { integrationAuthRequired } : {}),
            ...(scheduledTaskProposals.length > 0 ? { scheduledTaskProposals } : {}),
            ...(activity ? { activity } : {}),
            ...(sources ? { sources } : {}),
            ...(summary?.provenance ? { provenance: summary.provenance } : {}),
            ...(answerBasis ? { answerBasis } : {})
          },
          // The end of the transcript for an ordinary turn, and the position
          // right after this run's own question for a superseded one.
          // The release rides along: same lock, same chat write, written
          // after the transcript, applied only while this run is still the
          // chat's active one.
          {
            ...(supersedeMessageId
              ? { supersedeMessageId }
              : { insertAfterRunId: runId, unlessAnswered: onlyIfUnanswered }),
            release: { runId, patch: releasePatch }
          }
        );
        // The chat is gone: whatever evidence a racing write left goes too.
        if (appended === null && typeof repository.evidenceStore === 'function') {
          void inBackground(() => repository.evidenceStore().deleteChat(chatId), {
            component: COMPONENT,
            operation: 'delete evidence of a deleted chat',
            chatId
          });
        }
        // Somebody else answered the run first; theirs is the answer.
        if (appended?.skipped) {
          outcome.skipped = true;
          appended = null;
        }
      } catch (appendError) {
        logger.error('Chat answer not stored; releasing the run anyway', {
          component: COMPONENT,
          chatId,
          runId,
          error: appendError.message
        });
      }
    }

    // Released with the answer when it was written; on its own otherwise —
    // a paused turn, a skipped or failed append — so the chat never stays
    // claimed by a run that has ended.
    const { chat, released } = appended?.chat
      ? { chat: appended.chat, released: appended.released === true }
      : await repository.releaseRun(chatId, runId, releasePatch);
    outcome.released = released === true;
    // A file a later version of the same name replaced was stored when its
    // tool finished; the answer keeps only the last one. Off the answer path,
    // and never a file a share already hands out.
    if (appended?.message?.id && replacedFiles.length > 0) {
      void deleteReplacedFiles(repository, chatId, replacedFiles).catch(error =>
        logger.warn('Replaced generated files not deleted', {
          component: COMPONENT,
          chatId,
          error: error.message
        })
      );
    }
    // The evidence record, off the answer path: after the answer is stored and
    // the run released, never awaited (#3687).
    if (appended?.message?.id) {
      void recordChatEvidence({
        repository,
        chatId,
        runId,
        messageId: appended.message.id,
        summary,
        artifacts,
        runLog
      });
    }
    if (!chat) {
      logger.error('Chat assistant turn not materialized: no chat document', {
        component: COMPONENT,
        chatId,
        runId
      });
      return outcome;
    }
    outcome.message = appended?.message ?? null;
    return outcome;
  } catch (err) {
    logger.error('Chat assistant turn not materialized', {
      component: COMPONENT,
      chatId,
      runId,
      error: err.message
    });
    return outcome;
  }
}
