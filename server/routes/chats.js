// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat routes — the durable-chat surface (#2304 §9).
 *
 *   GET    /api/chats            ?limit&cursor   the caller's chats, newest activity first
 *   GET    /api/chats/:chatId                    chat metadata + stored transcript
 *   GET    /api/chats/:chatId/artifacts             what this chat's turns produced
 *   GET    /api/chats/:chatId/artifacts/:artifactId  the bytes of one of them
 *   POST   /api/chats/:chatId/artifacts/zip          several (or all) of them as one ZIP
 *   PATCH  /api/chats/:chatId    { title }       rename a chat
 *   PATCH  /api/chats/:chatId    { temporary: false }  keep a temporary chat
 *   DELETE /api/chats/:chatId                    erase a chat, its transcript and its runs
 *
 * The turns themselves are written by `services/chat/chatMaterializer.js` off
 * the chat request path; nothing here creates or appends to a chat. This
 * router only lists, reads, renames and erases what that path stored.
 *
 * Every chat is stored, but not every chat is kept: a **temporary** chat
 * (incognito, an anonymous visitor's, any chat on an installation without
 * chat history) is never listed. So the routes split:
 *
 *  - **The listing and the rename need a history** — `authenticatedOnly`, and
 *    503 `CHAT_PERSISTENCE_UNAVAILABLE` while the installation keeps none.
 *  - **One chat's transcript, artifacts and delete need only storage**, and
 *    take `authRequired`: an anonymous visitor reads, and deletes, the
 *    temporary chats of its guest identity (`chatOwner.js`) — reloading the
 *    page must not lose the conversation just because nobody signed in.
 *
 * And one deliberate difference from the sibling `routes/runs.js`:
 *
 *  - **404 for both unknown and not-yours.** Chat ids are client-minted and
 *    enumerable; a 403 on someone else's chat would turn every endpoint here
 *    into an existence oracle. `chatAccess.authorizeChat` collapses the two.
 *
 * No `@swagger` blocks: `routes/swagger.js` scans an explicit file list that
 * does not include this router (nor `runs.js`), so they would be inert.
 *
 * @module routes/chats
 */
import { authenticatedOnly, authRequired } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import configCache from '../configCache.js';
import { appAllowsUserProjects } from '../../shared/appProjects.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import runLog from '../services/loop/RunLog.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { getChatRepository, MAX_TITLE_LENGTH } from '../services/chat/ChatRepository.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { servedMediaType } from '../services/artifacts/artifactPolicy.js';
import { sendArtifactsZip } from '../services/artifacts/artifactZip.js';
import {
  canKeepChatHistory,
  isChatHistoryConfigured,
  isChatStorageAvailable
} from '../services/chat/chatPersistence.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import { abortChatRequest } from '../sse.js';
import { userAbortCause } from '../services/chat/abortCause.js';
import { cancelChatWorkflow } from '../tools/workflowRunner.js';
import { getWorkflowStateRepository } from '../services/workflow/WorkflowStateRepository.js';
import { deleteChatWithCascade } from '../services/chat/chatDeletion.js';
import {
  deliverResumedWorkflows,
  settleInterruptedChat,
  settleInterruptedChats
} from '../services/chat/chatRecovery.js';
import { SCHEDULED_TASK_ORIGIN } from '../services/scheduler/tasks/taskPolicy.js';
import { markRunChatSeen } from '../services/scheduler/tasks/taskService.js';

const COMPONENT = 'ChatRoutes';

/**
 * Machine-readable code for "this installation keeps no chat history" — the
 * feature is off, an admin disabled `platform.chats`, or the storage provider
 * failed to come up. The client hides the history UI when it sees this.
 */
const UNAVAILABLE_CODE = 'CHAT_PERSISTENCE_UNAVAILABLE';

/**
 * How much of a submitted title survives to normalization. The global body
 * limit is megabytes and the repository normalizes by collapsing whitespace
 * with a regex over the whole string, so an unbounded title is cheap CPU for
 * the caller and expensive for the server. A window several times the stored
 * cap leaves the collapse room to still fill 200 characters.
 */
const TITLE_INPUT_WINDOW = MAX_TITLE_LENGTH * 4;

/**
 * Report that durable chats are unavailable. 503 rather than 404: the routes
 * exist, they just cannot serve anything until storage and the feature flag
 * agree, and a retry may well succeed.
 *
 * @param {import('express').Response} res - Express response.
 * @returns {import('express').Response}
 */
function sendPersistenceUnavailable(res) {
  return sendErrorResponse(res, 503, 'Chat persistence is unavailable', {
    details: { code: UNAVAILABLE_CODE }
  });
}

/**
 * Translate a storage failure into a response.
 *
 * The storage errors that carry an `httpStatus` were designed for exactly
 * this hand-off (a lock timeout is a 503, an unusable key a 400), and a bad
 * paging cursor is the caller's mistake, not a server fault. Everything else
 * is a genuine 500.
 *
 * @param {import('express').Response} res - Express response.
 * @param {Error} error - The thrown error.
 * @param {string} operation - Operation name for the 500 message and the log.
 * @returns {import('express').Response}
 */
function sendChatStorageError(res, error, operation) {
  if (error instanceof StorageError) {
    // Through the errors module rather than re-deriving the mapping here. The
    // `INVALID_CURSOR` special case this replaces was one route knowing a
    // contract code's status because the error did not carry it.
    const status = storageHttpStatus(error);
    if (status) {
      return sendErrorResponse(res, status, error.message, { details: { code: error.code } });
    }
  }
  return sendFailedOperationError(res, operation, error);
}

/**
 * The repository to serve this request from, or null once a 503 has been
 * sent. Both halves are checked: the policy answers "should we", the
 * repository answers "can we" — a provider that came up without a document or
 * lock facet is configured-but-unusable.
 *
 * @param {import('express').Response} res - Express response.
 * @param {Object} [options]
 * @param {boolean} [options.history=false] - The route serves the history (the
 *   listing, a rename, keeping a chat), not just one stored chat: it also
 *   needs the installation to keep one.
 * @returns {import('../services/chat/ChatRepository.js').ChatRepository|null}
 */
function requireRepository(res, { history = false } = {}) {
  const repository = getChatRepository();
  const configured = history
    ? isChatHistoryConfigured(configCache.getFeatures(), configCache.getPlatform() || {})
    : isChatStorageAvailable();
  if (!configured || !repository.isAvailable()) {
    sendPersistenceUnavailable(res);
    return null;
  }
  return repository;
}

/**
 * The caller's owner id, in the identity mode configured right now.
 *
 * Listing can only ever find chats written under the current mode. Reading
 * one is mode-agnostic — `authorizeChat` resolves the caller in the mode
 * recorded on the chat — but there is no index that spans modes, so chats
 * written before an admin changed `platform.runLog.identityMode` drop out of
 * the sidebar while remaining readable by id. That is the documented cost of
 * changing the mode on a live installation.
 *
 * @param {Object} user - `req.user`; guaranteed non-anonymous by
 *   `authenticatedOnly`.
 * @returns {Promise<string>} Owner id to scope the listing by.
 */
async function resolveOwnerId(user) {
  const principal = await resolvePrincipal(user, { mode: runLog.identityMode() });
  return principal.id;
}

/**
 * Authorize a chat for this caller and require that it exists.
 *
 * `authorizeChat` deliberately reports an absent chat as authorized — the
 * write path calls it before creating one. Every route here addresses an
 * existing chat, so absent is 404.
 *
 * @param {string} chatId - Chat id from the path.
 * @param {Object} user - `req.user`.
 * @param {import('../services/chat/ChatRepository.js').ChatRepository} repository - Repository.
 * @param {'read'|'write'} [intent='read'] - What the caller is about to do.
 *   The admin bypass covers reads only, so a rename or a delete of someone
 *   else's chat is refused even for an admin.
 * @returns {Promise<{chat: Object, viaAdmin: boolean, viaProject: boolean, nonOwner: boolean}|null>}
 *   The chat and how it was authorized, or null once a 404 is due. `nonOwner`
 *   is set for every read that does not rest on ownership (an admin's or a
 *   project member's), so the owner's side effects can be skipped.
 */
/**
 * Download name of a chat's artifact archive: its title, made file-safe.
 *
 * @param {Object|null} chat
 * @returns {string}
 */
function zipNameFor(chat) {
  const title = typeof chat?.title === 'string' ? chat.title : '';
  const base = title
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replaceAll(/^[.\s]+|[.\s]+$/g, '');
  return `${base || 'chat'} - artifacts.zip`;
}

async function loadOwnedChat(chatId, user, repository, intent = 'read') {
  const auth = await authorizeChat(chatId, user, { repository, intent });
  if (!auth.ok || !auth.chat) return null;
  const viaAdmin = auth.viaAdmin === true;
  const viaProject = auth.viaProject === true;
  return { chat: auth.chat, viaAdmin, viaProject, nonOwner: viaAdmin || viaProject };
}

/**
 * Set the projects attached to a chat (`attachedProjectIds`): the projects the
 * chat's questions can draw on besides its own container. Taking one away is
 * always possible; adding one needs the right to use it, like attaching it
 * with a message does (`resolveChatProjects`). Sends the refusal itself and
 * returns null when the request cannot go on.
 */
async function setChatAttachedProjects(req, res, repository, chat) {
  const [
    { attachedProjectsSchema, describeIssues },
    { getProjectRepository },
    { loadProjectFor },
    access,
    { isUserProjectsConfigured },
    { MAX_ATTACHED }
  ] = await Promise.all([
    import('../validators/projectSchema.js'),
    import('../services/projects/ProjectRepository.js'),
    import('../services/projects/projectLoader.js'),
    import('../middleware/projectAccess.js'),
    import('../services/projects/projectSettings.js'),
    import('../services/knowledge/chatProjects.js')
  ]);
  const parsed = attachedProjectsSchema.safeParse({
    attachedProjectIds: req.body.attachedProjectIds
  });
  if (!parsed.success) {
    sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
    return null;
  }
  const wanted = [...new Set(parsed.data.attachedProjectIds)];
  const stored = Array.isArray(chat.attachedProjectIds) ? chat.attachedProjectIds : [];
  const added = wanted.filter(id => !stored.includes(id) && id !== chat.projectId);
  if (added.length > 0) {
    if (!isUserProjectsConfigured(configCache.getFeatures())) {
      sendErrorResponse(res, 403, 'User projects are switched off', {
        details: { code: 'USER_PROJECTS_DISABLED' }
      });
      return null;
    }
    // The chat's app decides too: one that takes no personal projects gets
    // none attached here either, as with a message (`resolveChatProjects`).
    const app = chat.appId
      ? findByIdCaseInsensitive(configCache.getApps()?.data || [], chat.appId)
      : null;
    if (app && !appAllowsUserProjects(app)) {
      sendErrorResponse(res, 403, 'This app takes no projects', {
        details: { code: 'APP_PROJECTS_DISABLED' }
      });
      return null;
    }
    access.ensurePrincipal(req);
    const projects = getProjectRepository();
    const context = access.callerContext(req.user);
    for (const id of added) {
      const { project } = await loadProjectFor(req.user, id, { repository: projects });
      if (!project || !access.permissionsFor(project, req.user, context).canUse) {
        sendNotFound(res, 'Project');
        return null;
      }
    }
  }
  if (wanted.length > MAX_ATTACHED) {
    sendBadRequest(res, `A chat may have at most ${MAX_ATTACHED} projects attached`);
    return null;
  }
  const { chat: updated } = await repository.setAttachedProjects(chat.id, wanted, MAX_ATTACHED);
  if (!updated) {
    sendNotFound(res, 'Chat');
    return null;
  }
  return updated;
}

/**
 * Register the `/api/chats` endpoints.
 *
 * Call it next to `registerRunRoutes(app)` in `server/server.js`; the paths
 * are built with `buildServerPath` so a subpath deployment works unchanged.
 *
 * @param {import('express').Application} app - Express application.
 * @returns {void}
 */
export default function registerChatRoutes(app) {
  app.get(buildServerPath('/api/chats'), authenticatedOnly, async (req, res) => {
    try {
      const repository = requireRepository(res, { history: true });
      if (!repository) return;
      const ownerId = await resolveOwnerId(req.user);
      // The chat documents go out exactly as stored. App name, colour and icon
      // are joined on the client from the apps list it already holds, so this
      // endpoint stays independent of app configuration.
      const { items, nextCursor } = await repository.listChats(ownerId, {
        limit: req.query.limit,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
      });
      // A chat still marked running whose run died with its process is
      // closed out here, so the list does not show it running forever.
      res.json({ items: await settleInterruptedChats(items, { repository, runLog }), nextCursor });
    } catch (error) {
      sendChatStorageError(res, error, 'list chats');
    }
  });

  app.get(buildServerPath('/api/chats/:chatId'), authRequired, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'read');
      if (!access) return sendNotFound(res, 'Chat');
      const { nonOwner } = access;
      // Before the transcript is read, so an interrupted turn's closing answer
      // is part of it — and the client does not re-attach to a dead run.
      const chat = await settleInterruptedChat(access.chat, { repository, runLog });
      let stored = await repository.getMessages(chatId);
      // A workflow its chat was left waiting on may have been continued since.
      if (await deliverResumedWorkflows(chat, stored.messages, { repository, runLog })) {
        stored = await repository.getMessages(chatId);
      }
      // Opening a chat is what "seen" means — for its owner. Only write when
      // the flag is actually set: the clear is a locked read-modify-write, and
      // a plain read should not contend with a turn that is producing into
      // this chat. An admin or a project member reading someone else's chat
      // clears nothing: the owner has not seen the answer, and another's read
      // should not tell them they have.
      const seen =
        chat.hasUnseenActivity && !nonOwner ? await repository.clearUnseen(chatId) : null;
      // A scheduled run's chat, opened by its owner, is also the end of that
      // run's notification on the Tasks page.
      if (!nonOwner && chat.origin?.createdVia === SCHEDULED_TASK_ORIGIN) {
        markRunChatSeen(chat);
      }
      // `messages` is the array, not the stored envelope — a hydrating client
      // should not have to reach through `messages.messages`. The document's
      // schema version rides alongside it so a future migration is visible.
      res.json({ chat: seen || chat, messages: stored.messages, version: stored.version });
    } catch (error) {
      sendChatStorageError(res, error, 'get chat');
    }
  });

  app.get(buildServerPath('/api/chats/:chatId/artifacts'), authRequired, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'read');
      if (!access) return sendNotFound(res, 'Chat');
      // Descriptors, never payloads: this is the index of what the
      // conversation produced, and the bytes are a separate request per entry.
      // The listing walks the artifact keys rather than the transcript, so it
      // also sees one whose descriptor never landed on a message.
      const items = await getArtifactRepository().list(repository.artifactScope(chatId));
      res.json({ items });
    } catch (error) {
      sendChatStorageError(res, error, 'list chat artifacts');
    }
  });

  // Several artifacts as one ZIP: `{ artifactIds?: string[] }`, every one of
  // the chat's when omitted. A POST because the selection can be long; it
  // changes nothing. Authorized exactly like the single-artifact read below.
  app.post(buildServerPath('/api/chats/:chatId/artifacts/zip'), authRequired, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'read');
      if (!access) return sendNotFound(res, 'Chat');
      const scope = repository.artifactScope(chatId);
      const artifacts = getArtifactRepository();
      return await sendArtifactsZip(res, {
        repository: artifacts,
        scope,
        descriptors: await artifacts.list(scope),
        artifactIds: req.body?.artifactIds,
        archiveName: zipNameFor(access.chat)
      });
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      return sendChatStorageError(res, error, 'zip chat artifacts');
    }
  });

  app.get(
    buildServerPath('/api/chats/:chatId/artifacts/:artifactId'),
    authRequired,
    async (req, res) => {
      try {
        const { chatId, artifactId } = req.params;
        if (!validateIdForPath(chatId, 'chat', res)) return;
        if (!validateIdForPath(artifactId, 'artifact', res)) return;
        const repository = requireRepository(res);
        if (!repository) return;
        // The artifact is authorized through the chat that owns it, exactly
        // like the transcript that names it: an artifact id is minted
        // server-side and is never a capability on its own.
        const access = await loadOwnedChat(chatId, req.user, repository, 'read');
        if (!access) return sendNotFound(res, 'Chat');
        const artifact = await getArtifactRepository().get(
          repository.artifactScope(chatId),
          artifactId
        );
        if (!artifact) return sendNotFound(res, 'Artifact');
        // Already the bytes: the store keeps payloads raw, so serving one is a
        // read and a write, with no decode in between.
        const body = artifact.data;
        // An artifact document is written once and never modified, and its id
        // is a fresh uuid, so the bytes behind this URL cannot change.
        // `private` because the response is owner-scoped and a shared cache
        // holding it would serve one user's content to another.
        // A source file goes out as `text/plain` (see `servedMediaType`).
        res.setHeader('Content-Type', servedMediaType(artifact.mimeType));
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        // Nothing here is a document to open in the browser's context; the
        // client renders it from a blob it fetched itself.
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send(body);
      } catch (error) {
        return sendChatStorageError(res, error, 'get chat artifact');
      }
    }
  );

  app.patch(buildServerPath('/api/chats/:chatId'), authenticatedOnly, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const title = req.body?.title;
      if (req.body && Object.hasOwn(req.body, 'projectId')) {
        // A chat belongs to a project from its first turn on (`projectId` of
        // the chat request); it is never moved into or out of one afterwards.
        return sendBadRequest(res, 'A chat cannot be moved into or out of a project');
      }
      const hasAttached = req.body && Object.hasOwn(req.body, 'attachedProjectIds');
      const keep = req.body?.temporary === false;
      if (typeof title !== 'string' && !hasAttached && !keep) {
        return sendBadRequest(res, 'title is required and must be a string');
      }
      if (req.body && Object.hasOwn(req.body, 'temporary') && !keep) {
        // There is no way back into temporary: a kept chat that should not be
        // kept is deleted, and a conversation that should be is a new chat.
        return sendBadRequest(res, 'temporary can only be set to false');
      }
      if (keep && hasAttached) {
        // Keeping writes the chat before the attached projects are even
        // checked, so a change refused after it would leave the request failed
        // but the chat kept. Two requests make each step all-or-nothing.
        return sendBadRequest(res, 'Keep the chat and change its projects in separate requests');
      }
      // Only keeping needs a history to keep the chat in. A temporary chat —
      // every chat while the history is off — can still be renamed and given
      // attached projects.
      const repository = requireRepository(res, { history: keep });
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'write');
      if (!access) return sendNotFound(res, 'Chat');
      let chat = access.chat;
      if (keep && chat.temporary === true) {
        // `authenticatedOnly` already keeps guests out; the policy is asked
        // anyway so the one rule for "who has a history" stays in one place.
        if (!canKeepChatHistory(req.user)) return sendNotFound(res, 'Chat');
        chat = await repository.keepChat(chatId);
        if (!chat) return sendNotFound(res, 'Chat');
        // A temporary chat ran with its project's knowledge but was left off
        // the project's page; kept, it belongs there like any chat.
        if (chat.projectId) {
          const { recordChatInProject } = await import('../services/knowledge/chatProjects.js');
          await recordChatInProject(chat.projectId, chatId, { ownerId: chat.ownerId }).catch(() => {
            /* the project may be gone; the chat is kept either way */
          });
        }
      }
      if (hasAttached) {
        const attached = await setChatAttachedProjects(req, res, repository, chat);
        if (!attached) return;
        chat = attached;
      }
      if (typeof title === 'string') {
        // The repository caps and marks the title as user-set so no later turn
        // derives over it; an empty title clears that mark instead.
        chat = await repository.renameChat(chatId, title.slice(0, TITLE_INPUT_WINDOW));
        if (!chat) return sendNotFound(res, 'Chat');
      }
      res.json({ chat });
    } catch (error) {
      sendChatStorageError(res, error, 'rename chat');
    }
  });

  app.delete(buildServerPath('/api/chats/:chatId'), authRequired, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'write');
      if (!access) return sendNotFound(res, 'Chat');
      // Stop the turn before erasing what records it. The sidebar deletes
      // without stopping first, so a generating chat left the model call
      // running and billing — and its next `runLog.append` re-created the very
      // stream the cascade below had just deleted, because appending to an
      // unknown stream creates it. What survived was an event stream carrying
      // the conversation with no run summary to find it by, reaped only by the
      // ledger's own age sweep. The same pair `POST /api/runs/:id/stop` uses,
      // and cluster-aware for the same reason: the turn may be producing on
      // another worker.
      if (access.chat?.status === 'running' || access.chat?.activeRunId) {
        abortChatRequest(
          chatId,
          await userAbortCause('chat_deleted', req.user, {
            mode:
              access.chat?.identityMode ||
              (access.chat?.activeRunId &&
                runLog.getRunMeta(access.chat.activeRunId)?.identityMode) ||
              runLog.identityMode(),
            ownerId: access.chat?.ownerId,
            via: 'DELETE /api/chats/:chatId',
            related: access.chat?.activeRunId ? { runId: access.chat.activeRunId } : undefined
          })
        );
        await cancelChatWorkflow(chatId);
      }
      await deleteChatWithCascade(repository, chatId, {
        deleteRun: runId => runLog.deleteRun(runId),
        removeWorkflowState: runId => getWorkflowStateRepository().remove(runId),
        component: COMPONENT
      });
      // The chat is gone, so its project's marker has nothing to list; the
      // listing would prune it on its next read, the cascade does it now.
      if (access.chat?.projectId) {
        const { getProjectService } = await import('../services/projects/ProjectService.js');
        await getProjectService()
          .detachChat(access.chat.projectId, chatId)
          .catch(() => {
            /* the project may already be gone */
          });
      }
      // True even when a concurrent delete won the race: the postcondition the
      // caller asked for — this chat no longer exists — holds either way.
      res.json({ deleted: true });
    } catch (error) {
      sendChatStorageError(res, error, 'delete chat');
    }
  });
}
