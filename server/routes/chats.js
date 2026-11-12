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
import { assertValidId } from '../utils/pathSecurity.js';
import { buildContentDisposition } from '../utils/safeContentDisposition.js';
import configCache from '../configCache.js';
import { appAllowsUserProjects } from '../../shared/appProjects.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import runLog from '../services/loop/RunLog.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { resolveChatOwner } from '../services/chat/chatOwner.js';
import { getChatRepository, MAX_TITLE_LENGTH } from '../services/chat/ChatRepository.js';
import { chatModelOf, scheduleChatTitle } from '../services/chat/chatTitles.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { servedMediaType } from '../services/artifacts/artifactPolicy.js';
import { sendArtifactsZip } from '../services/artifacts/artifactZip.js';
import { providerMarkingOfArtifact } from '../services/provenance/artifactProvenance.js';
import { requireEuAiActEnabled } from '../services/euAiAct/conformity.js';
import { ServiceError } from '../utils/ServiceError.js';
import { chatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { withUserFileLimit } from '../services/quota/quotaService.js';
import {
  isMultipartRequest,
  ingestRequestFile,
  parseChatFileMultipart
} from '../services/chatFiles/fileUploadRequest.js';
import {
  canKeepChatHistory,
  isChatHistoryConfigured,
  isChatStorageAvailable,
  resolveChatStorage
} from '../services/chat/chatPersistence.js';
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
import { isProjectTestChat } from '../services/knowledge/projectTestScope.js';
import { getLocalizedError } from '../serverHelpers.js';
import { markRunChatSeen } from '../services/scheduler/tasks/taskService.js';
import { publicChatView } from '../services/chat/chatToolApproval.js';
import { sendCreated, segment } from '../utils/created.js';

const COMPONENT = 'ChatRoutes';

/**
 * How much of a submitted title survives to normalization. The global body
 * limit is megabytes and the repository normalizes by collapsing whitespace
 * with a regex over the whole string, so an unbounded title is cheap CPU for
 * the caller and expensive for the server. A window several times the stored
 * cap leaves the collapse room to still fill 200 characters.
 */
const TITLE_INPUT_WINDOW = MAX_TITLE_LENGTH * 4;

/**
 * A 404 for a missing (or, for a chat, someone else's) resource.
 *
 * @param {string} resource - Name for the message ("Chat", "File", ...).
 * @returns {ServiceError}
 */
function notFound(resource) {
  return new ServiceError('NOT_FOUND', `${resource} not found`);
}

/**
 * The refusal when durable chats are unavailable. 503 rather than 404: the
 * routes exist, they just cannot serve anything until storage and the feature
 * flag agree, and a retry may well succeed. The client hides the history UI
 * when it sees `CHAT_PERSISTENCE_UNAVAILABLE`.
 *
 * @returns {ServiceError}
 */
function persistenceUnavailable() {
  return new ServiceError('CHAT_PERSISTENCE_UNAVAILABLE', 'Chat persistence is unavailable');
}

/**
 * The repository to serve this request from; throws the 503 when there is
 * none. Both halves are checked: the policy answers "should we", the
 * repository answers "can we" — a provider that came up without a document or
 * lock facet is configured-but-unusable.
 *
 * @param {Object} [options]
 * @param {boolean} [options.history=false] - The route serves the history (the
 *   listing, a rename, keeping a chat), not just one stored chat: it also
 *   needs the installation to keep one.
 * @returns {import('../services/chat/ChatRepository.js').ChatRepository}
 * @throws {ServiceError} `CHAT_PERSISTENCE_UNAVAILABLE` (503).
 */
function requireRepository({ history = false } = {}) {
  const repository = getChatRepository();
  const configured = history
    ? isChatHistoryConfigured(configCache.getFeatures(), configCache.getPlatform() || {})
    : isChatStorageAvailable();
  if (!configured || !repository.isAvailable()) throw persistenceUnavailable();
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
 * Download name of a chat's artifact archive: its title, made file-safe.
 *
 * Cut by code point and with lone surrogates replaced: a title cut in the
 * middle of an emoji is not encodable, and `buildContentDisposition` would
 * throw on it.
 *
 * @param {Object|null} chat
 * @returns {string}
 */
function zipNameFor(chat) {
  const title = typeof chat?.title === 'string' ? chat.title : '';
  const cleaned = title
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_')
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const base = Array.from(cleaned)
    .slice(0, 80)
    .join('')
    .replaceAll(/^[.\s]+|[.\s]+$/g, '');
  return `${base || 'chat'} - artifacts.zip`;
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
async function loadOwnedChat(chatId, user, repository, intent = 'read') {
  const auth = await authorizeChat(chatId, user, { repository, intent });
  if (!auth.ok || !auth.chat) return null;
  const viaAdmin = auth.viaAdmin === true;
  const viaProject = auth.viaProject === true;
  return { chat: auth.chat, viaAdmin, viaProject, nonOwner: viaAdmin || viaProject };
}

/**
 * Refuse adding `added` projects to a chat unless the caller may use every one
 * of them, user projects are switched on and the chat's app takes them.
 *
 * @param {import('express').Request} req - The request (`req.user`).
 * @param {Object} chat - The chat the projects are attached to.
 * @param {string[]} added - Project ids not attached yet.
 * @param {Object} deps - Lazily imported project modules and the feature flag.
 * @returns {Promise<void>}
 * @throws {ServiceError} `USER_PROJECTS_DISABLED`, `APP_PROJECTS_DISABLED` or `NOT_FOUND`.
 */
async function assertMayAttach(
  req,
  chat,
  added,
  { access, loadProjectFor, projects, userProjectsConfigured }
) {
  if (!userProjectsConfigured) {
    throw new ServiceError('USER_PROJECTS_DISABLED', 'User projects are switched off');
  }
  // The chat's app decides too: one that takes no personal projects gets
  // none attached here either, as with a message (`resolveChatProjects`).
  const app = chat.appId
    ? findByIdCaseInsensitive(configCache.getApps()?.data || [], chat.appId)
    : null;
  if (app && !appAllowsUserProjects(app)) {
    throw new ServiceError('APP_PROJECTS_DISABLED', 'This app takes no projects');
  }
  access.ensurePrincipal(req);
  const context = access.callerContext(req.user);
  const loaded = await Promise.all(
    added.map(id => loadProjectFor(req.user, id, { repository: projects }))
  );
  if (
    loaded.some(
      ({ project }) => !project || !access.permissionsFor(project, req.user, context).canUse
    )
  ) {
    throw notFound('Project');
  }
}

/**
 * Set the projects attached to a chat (`attachedProjectIds`): the projects the
 * chat's questions can draw on besides its own container. Taking one away is
 * always possible; adding one needs the right to use it, like attaching it
 * with a message does (`resolveChatProjects`). Throws the refusal when the
 * request cannot go on.
 */
async function setChatAttachedProjects(req, repository, chat) {
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
    throw new ServiceError('BAD_REQUEST', `Invalid request: ${describeIssues(parsed.error)}`);
  }
  const wanted = [...new Set(parsed.data.attachedProjectIds)];
  const stored = Array.isArray(chat.attachedProjectIds) ? chat.attachedProjectIds : [];
  const added = wanted.filter(id => !stored.includes(id) && id !== chat.projectId);
  if (added.length > 0) {
    await assertMayAttach(req, chat, added, {
      access,
      loadProjectFor,
      projects: getProjectRepository(),
      userProjectsConfigured: isUserProjectsConfigured(configCache.getFeatures())
    });
  }
  if (wanted.length > MAX_ATTACHED) {
    throw new ServiceError(
      'BAD_REQUEST',
      `A chat may have at most ${MAX_ATTACHED} projects attached`
    );
  }
  const { chat: updated } = await repository.setAttachedProjects(chat.id, wanted, MAX_ATTACHED);
  if (!updated) {
    throw notFound('Chat');
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
    const repository = requireRepository({ history: true });
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
    // A paused turn's stored tool transcript stays on the server (#2945).
    res.json({
      items: (await settleInterruptedChats(items, { repository, runLog })).map(publicChatView),
      nextCursor
    });
  });

  app.get(buildServerPath('/api/chats/:chatId'), authRequired, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const repository = requireRepository();
    const access = await loadOwnedChat(chatId, req.user, repository, 'read');
    if (!access) throw notFound('Chat');
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
    const seen = chat.hasUnseenActivity && !nonOwner ? await repository.clearUnseen(chatId) : null;
    // A scheduled run's chat, opened by its owner, is also the end of that
    // run's notification on the Tasks page.
    if (!nonOwner && chat.origin?.createdVia === SCHEDULED_TASK_ORIGIN) {
      markRunChatSeen(chat);
    }
    // `messages` is the array, not the stored envelope — a hydrating client
    // should not have to reach through `messages.messages`. The document's
    // schema version rides alongside it so a future migration is visible.
    res.json({
      chat: publicChatView(seen || chat),
      messages: stored.messages,
      version: stored.version
    });
  });

  app.get(buildServerPath('/api/chats/:chatId/artifacts'), authRequired, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const repository = requireRepository();
    const access = await loadOwnedChat(chatId, req.user, repository, 'read');
    if (!access) throw notFound('Chat');
    // Descriptors, never payloads: this is the index of what the
    // conversation produced, and the bytes are a separate request per entry.
    // The listing walks the artifact keys rather than the transcript, so it
    // also sees one whose descriptor never landed on a message.
    const items = await getArtifactRepository().list(repository.artifactScope(chatId));
    res.json({ items });
  });

  // Several artifacts as one ZIP: `{ artifactIds?: string[] }`, every one of
  // the chat's when omitted. A POST because the selection can be long; it
  // changes nothing. Authorized exactly like the single-artifact read below.
  app.post(buildServerPath('/api/chats/:chatId/artifacts/zip'), authRequired, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const repository = requireRepository();
    const access = await loadOwnedChat(chatId, req.user, repository, 'read');
    if (!access) throw notFound('Chat');
    const scope = repository.artifactScope(chatId);
    const artifacts = getArtifactRepository();
    // Once the archive has started streaming, a failure reaches the global
    // handler with the headers sent, which closes the connection.
    return await sendArtifactsZip(res, {
      repository: artifacts,
      scope,
      descriptors: await artifacts.list(scope),
      artifactIds: req.body?.artifactIds,
      archiveName: zipNameFor(access.chat)
    });
  });

  app.get(
    buildServerPath('/api/chats/:chatId/artifacts/:artifactId'),
    authRequired,
    async (req, res) => {
      const { chatId, artifactId } = req.params;
      assertValidId(chatId, 'chat');
      assertValidId(artifactId, 'artifact');
      const repository = requireRepository();
      // The artifact is authorized through the chat that owns it, exactly
      // like the transcript that names it: an artifact id is minted
      // server-side and is never a capability on its own.
      const access = await loadOwnedChat(chatId, req.user, repository, 'read');
      if (!access) throw notFound('Chat');
      const artifact = await getArtifactRepository().get(
        repository.artifactScope(chatId),
        artifactId
      );
      if (!artifact) throw notFound('Artifact');
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
    }
  );

  /**
   * @swagger
   * /api/chats/{chatId}/artifacts/{artifactId}/provenance:
   *   get:
   *     summary: What the provider embedded in a generated image
   *     description: >-
   *       The provider marking recorded for a stored image (EU AI Act Art. 50(2)): the result of
   *       reading its C2PA Content Credentials when it was generated. `valid` means the
   *       signature and the binding to the file hold, never that the signer is trusted
   *       (`trust` is always `not-evaluated`). Authorized through the chat, like the bytes.
   *     tags: [Chats]
   *     responses:
   *       200:
   *         description: >-
   *           `{ outputId, createdAt?, providerMarking: { c2pa: { present, status, valid, issuer,
   *           digitalSourceType, claimGenerator, signedAt, trust }, xmp: { digitalSourceType },
   *           declared } }`
   *       403: { description: The EU AI Act features are switched off (FEATURE_DISABLED) }
   *       404: { description: No such chat or artifact, not an image, or no record was kept (NOT_FOUND) }
   */
  app.get(
    buildServerPath('/api/chats/:chatId/artifacts/:artifactId/provenance'),
    authRequired,
    requireEuAiActEnabled('provenance'),
    async (req, res) => {
      const { chatId, artifactId } = req.params;
      assertValidId(chatId, 'chat');
      assertValidId(artifactId, 'artifact');
      const repository = requireRepository();
      // Authorized through the chat that owns the artifact, like its bytes.
      const access = await loadOwnedChat(chatId, req.user, repository, 'read');
      if (!access) throw notFound('Chat');
      const artifact = await getArtifactRepository().get(
        repository.artifactScope(chatId),
        artifactId
      );
      if (!artifact) throw notFound('Artifact');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await providerMarkingOfArtifact(artifact));
    }
  );

  app.post(buildServerPath('/api/chats/:chatId/files'), authRequired, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const repository = requireRepository();
    const fileStore = repository.fileStore();
    if (!fileStore.isAvailable()) {
      throw persistenceUnavailable();
    }

    const auth = await authorizeChat(chatId, req.user, { repository, intent: 'write' });
    if (!auth.ok) throw notFound('Chat');

    const owner = await resolveChatOwner(req.user, {
      mode: auth.chat?.identityMode || runLog.identityMode()
    });
    if (!owner) {
      throw new ServiceError('CHAT_OWNER_REQUIRED', 'This chat has no owner to be stored under');
    }

    const basePolicy = chatFilePolicy();
    if (!basePolicy.enabled) {
      throw new ServiceError('UPLOADS_DISABLED', 'Chat file uploads are disabled');
    }

    if (isMultipartRequest(req)) {
      await parseChatFileMultipart(req, res, basePolicy.maxFileBytes);
    }

    // A chat that exists keeps its app: the app decides the storage policy, so a
    // request must not be able to pick a looser one for somebody's chat.
    const requestedAppId =
      auth.chat?.appId || (typeof req.body?.appId === 'string' && req.body.appId) || null;
    const chatApp = requestedAppId
      ? findByIdCaseInsensitive(configCache.getApps()?.data || [], requestedAppId)
      : null;
    // The user's own file storage limit (group/user `usageLimits`).
    const policy = withUserFileLimit(chatFilePolicy(chatApp), req.user);
    if (!policy.enabled) {
      throw new ServiceError('UPLOADS_DISABLED', 'Chat file uploads are disabled');
    }

    // Ensure the chat document exists if the user pre-uploads a file in the
    // composer before sending the first message.
    if (!auth.chat) {
      const storage = resolveChatStorage({
        features: configCache.getFeatures(),
        platformConfig: configCache.getPlatform(),
        user: req.user,
        ephemeral: req.body?.ephemeral === true || req.body?.ephemeral === 'true'
      });
      await repository.ensureChat({
        chatId,
        ownerId: owner.id,
        identityMode: owner.mode,
        appId: requestedAppId,
        origin: { createdVia: 'ui' },
        temporary: storage.temporary
      });
    }

    const descriptor = await ingestRequestFile({
      req,
      scope: repository.fileScope(chatId),
      ownerId: owner.id,
      appConfig: chatApp,
      policy,
      store: fileStore,
      user: req.user
    });
    return sendCreated(
      res,
      `/api/chats/${segment(chatId)}/files/${segment(descriptor.id)}`,
      descriptor
    );
  });

  app.get(buildServerPath('/api/chats/:chatId/files'), authRequired, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const repository = requireRepository();
    const access = await loadOwnedChat(chatId, req.user, repository, 'read');
    if (!access) throw notFound('Chat');
    const items = await repository.fileStore().list(repository.fileScope(chatId));
    return res.json({ items });
  });

  app.get(buildServerPath('/api/chats/:chatId/files/:fileId'), authRequired, async (req, res) => {
    const { chatId, fileId } = req.params;
    assertValidId(chatId, 'chat');
    assertValidId(fileId, 'file');
    const repository = requireRepository();
    const access = await loadOwnedChat(chatId, req.user, repository, 'read');
    if (!access) throw notFound('Chat');

    const scope = repository.fileScope(chatId);
    const fileStore = repository.fileStore();
    if (req.query.format === 'text') {
      const textFile = await fileStore.getText(scope, fileId);
      if (!textFile) throw notFound('File');
      if (req.query.raw === '1' || req.query.raw === 'true') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Served as text/plain with nosniff: never interpreted as HTML.
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
        return res.send(textFile.text);
      }
      return res.json(textFile);
    }

    const original = await fileStore.getOriginal(scope, fileId);
    if (!original) throw notFound('File');
    if (original.discarded) {
      throw new ServiceError(
        'ORIGINAL_DISCARDED',
        'The original file is no longer available; extracted text is still stored',
        {
          details: original.originalDeletedAt
            ? { originalDeletedAt: original.originalDeletedAt }
            : undefined
        }
      );
    }

    const body = original.data;
    const download = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', servedMediaType(original.mimeType));
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader(
      'Content-Disposition',
      download ? buildContentDisposition(original.name) : 'inline'
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(body);
  });

  app.delete(
    buildServerPath('/api/chats/:chatId/files/:fileId'),
    authRequired,
    async (req, res) => {
      const { chatId, fileId } = req.params;
      assertValidId(chatId, 'chat');
      assertValidId(fileId, 'file');
      const repository = requireRepository();
      const access = await loadOwnedChat(chatId, req.user, repository, 'write');
      if (!access) throw notFound('Chat');

      const scope = repository.fileScope(chatId);
      const fileStore = repository.fileStore();
      if (req.query.onlyOriginal === '1' || req.query.onlyOriginal === 'true') {
        const updated = await fileStore.discardOriginal(scope, fileId, {
          reason: 'user_deleted'
        });
        if (!updated) throw notFound('File');
        return res.json(updated);
      }

      const deleted = await fileStore.delete(scope, fileId);
      if (!deleted) throw notFound('File');
      return res.status(204).end();
    }
  );

  app.patch(buildServerPath('/api/chats/:chatId'), authenticatedOnly, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const title = req.body?.title;
    if (req.body && Object.hasOwn(req.body, 'projectId')) {
      // A chat belongs to a project from its first turn on (`projectId` of
      // the chat request); it is never moved into or out of one afterwards.
      throw new ServiceError('BAD_REQUEST', 'A chat cannot be moved into or out of a project');
    }
    const hasAttached = req.body && Object.hasOwn(req.body, 'attachedProjectIds');
    const keep = req.body?.temporary === false;
    if (typeof title !== 'string' && !hasAttached && !keep) {
      throw new ServiceError('BAD_REQUEST', 'title is required and must be a string');
    }
    if (req.body && Object.hasOwn(req.body, 'temporary') && !keep) {
      // There is no way back into temporary: a kept chat that should not be
      // kept is deleted, and a conversation that should be is a new chat.
      throw new ServiceError('BAD_REQUEST', 'temporary can only be set to false');
    }
    if (keep && hasAttached) {
      // Keeping writes the chat before the attached projects are even
      // checked, so a change refused after it would leave the request failed
      // but the chat kept. Two requests make each step all-or-nothing.
      throw new ServiceError(
        'BAD_REQUEST',
        'Keep the chat and change its projects in separate requests'
      );
    }
    // Only keeping needs a history to keep the chat in. A temporary chat —
    // every chat while the history is off — can still be renamed and given
    // attached projects.
    const repository = requireRepository({ history: keep });
    const access = await loadOwnedChat(chatId, req.user, repository, 'write');
    if (!access) throw notFound('Chat');
    let chat = access.chat;
    // The scratch chat of a project test (#3309) is never kept: it may have
    // answered from a project that is disabled, and would continue in the
    // history without it.
    if (keep && isProjectTestChat(chat)) {
      throw new ServiceError(
        'PROJECT_TEST_CHAT_NOT_KEEPABLE',
        await getLocalizedError(
          'projectTestChatNotKeepable',
          {},
          req.headers['accept-language']?.split(',')[0]
        )
      );
    }
    if (keep && chat.temporary === true) {
      // `authenticatedOnly` already keeps guests out; the policy is asked
      // anyway so the one rule for "who has a history" stays in one place.
      if (!canKeepChatHistory(req.user)) throw notFound('Chat');
      chat = await repository.keepChat(chatId);
      if (!chat) throw notFound('Chat');
      // The chat was temporary, so no title was written for it; now that it
      // is in the history it gets the one, in the background.
      scheduleChatTitle({
        repository,
        chatId,
        user: req.user,
        chatModel: chatModelOf(chat),
        appId: chat.appId,
        language: req.headers['accept-language']?.split(',')[0]
      });
      // A temporary chat ran with its project's knowledge but was left off
      // the project's page; kept, it belongs there like any chat.
      if (chat.projectId) {
        const { recordChatInProject } = await import('../services/knowledge/chatProjects.js');
        await recordChatInProject(chat.projectId, chatId, {
          ownerId: chat.ownerId,
          private: chat.projectPrivate === true
        }).catch(() => {
          /* the project may be gone; the chat is kept either way */
        });
      }
    }
    if (hasAttached) {
      chat = await setChatAttachedProjects(req, repository, chat);
    }
    if (typeof title === 'string') {
      // The repository caps and marks the title as user-set so no later turn
      // derives over it; an empty title clears that mark instead.
      chat = await repository.renameChat(chatId, title.slice(0, TITLE_INPUT_WINDOW));
      if (!chat) throw notFound('Chat');
    }
    res.json(publicChatView(chat));
  });

  app.delete(buildServerPath('/api/chats/:chatId'), authRequired, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const repository = requireRepository();
    const access = await loadOwnedChat(chatId, req.user, repository, 'write');
    if (!access) throw notFound('Chat');
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
    res.status(204).end();
  });
}
