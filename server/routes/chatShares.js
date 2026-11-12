// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat share routes — read-only links onto durable chats (#2515).
 *
 *   POST   /api/chats/:chatId/shares               create a share of this chat
 *   POST   /api/chats/:chatId/artifacts/:id/shares create a share of one artifact of it
 *   GET    /api/chats/:chatId/shares               this chat's shares, with view stats (owner)
 *   GET    /api/shares/with-me                     `users` shares addressed to the caller
 *   GET    /api/shares/:shareId                    the frozen transcript (auth per mode)
 *   GET    /api/shares/:shareId/artifacts          descriptors of the artifacts it references
 *   GET    /api/shares/:shareId/artifacts/:id      the bytes of one (`?download=1` to attach)
 *   GET    /api/shares/:shareId/artifacts/:id/provenance  what the provider embedded in one image
 *   POST   /api/shares/:shareId/artifacts/zip      several (or all) of those as one ZIP
 *   DELETE /api/shares/:shareId                    revoke (owner or admin)
 *   GET    /api/users/lookup?q=                    recipient picker for `users` shares
 *
 * Three auth postures, on purpose:
 *
 *  - The owner routes use `authenticatedOnly` and authorize the chat with
 *    write intent, like a rename: only the owner shares or lists shares of a
 *    chat, an admin does not.
 *  - The viewer routes carry **no** auth middleware. The auth chain in front
 *    of every request still attaches `req.user` when the caller is signed in,
 *    and `chatShareAccess.authorizeShareView` decides per mode whether that
 *    is enough — a `public` share is the one thing in this API that is meant
 *    to open with nobody signed in, also when anonymous access is off.
 *  - The lookup route is signed-in only, needs two characters, answers at
 *    most ten rows and never lists the user database.
 *
 * Every dead or foreign link answers 404 (see `chatShareAccess`); the one 401
 * is for an anonymous caller on a share that needs a sign-in.
 *
 * @module routes/chatShares
 */
import { z } from 'zod';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { assertValidId } from '../utils/pathSecurity.js';
import { ServiceError } from '../utils/ServiceError.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { requireFeature } from '../featureRegistry.js';
import { logAudit } from '../services/AuditLogService.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { downloadName, sendArtifactsZip } from '../services/artifacts/artifactZip.js';
import { servedMediaType } from '../services/artifacts/artifactPolicy.js';
import { providerMarkingOfArtifact } from '../services/provenance/artifactProvenance.js';
import { requireEuAiActEnabled } from '../services/euAiAct/conformity.js';
import { isChatHistoryConfigured } from '../services/chat/chatPersistence.js';
import {
  getChatShareRepository,
  isShareId,
  withPublicCause
} from '../services/chat/ChatShareRepository.js';
import { authorizeShareView } from '../services/chat/chatShareAccess.js';
import { buildContentDisposition } from '../utils/safeContentDisposition.js';
import {
  CHAT_SHARING_FEATURE,
  MAX_SHARE_RECIPIENTS,
  UPLOADED_FILES_ACCESS,
  SHARE_MODES,
  allowedShareModes,
  buildShareTitle,
  chatSharingSettings,
  isChatSharingConfigured,
  resolveShareLimits,
  shareState
} from '../services/chat/chatSharing.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';
import { isAdmin } from '../utils/authorization.js';
import { sendCreated, segment } from '../utils/created.js';

const COMPONENT = 'ChatShareRoutes';

/** Most rows the recipient picker answers. */
const LOOKUP_LIMIT = 10;

/** Shortest query the recipient picker answers. */
const LOOKUP_MIN_CHARS = 2;

/** Longest query the recipient picker reads. */
const LOOKUP_MAX_CHARS = 100;

const createShareSchema = z
  .object({
    mode: z.enum(SHARE_MODES),
    recipients: z.array(z.string().min(1).max(200)).max(MAX_SHARE_RECIPIENTS).optional(),
    expiresAt: z.string().max(64).nullable().optional(),
    maxViews: z.number().nullable().optional(),
    showOwnerName: z.boolean().optional(),
    // What viewers may do with the files uploaded to the chat (default: none),
    // and, with access, which of them (default: all the transcript names).
    uploadedFilesAccess: z.enum(UPLOADED_FILES_ACCESS).optional(),
    sharedFileIds: z.array(z.string().min(1).max(100)).max(200).optional()
  })
  .strict();

// A single-artifact share: the same audience and limits, no uploaded files
// (there is no transcript to attach them to), and the embed flag.
const createArtifactShareSchema = z
  .object({
    mode: z.enum(SHARE_MODES),
    recipients: z.array(z.string().min(1).max(200)).max(MAX_SHARE_RECIPIENTS).optional(),
    expiresAt: z.string().max(64).nullable().optional(),
    maxViews: z.number().nullable().optional(),
    showOwnerName: z.boolean().optional(),
    embeddable: z.boolean().optional()
  })
  .strict();

/**
 * A 404 for a share, chat, file or artifact the caller may not know about.
 *
 * @param {string} resource - What was not found, for the English fallback text.
 * @returns {ServiceError}
 */
const notFound = resource => new ServiceError('NOT_FOUND', `${resource} not found`);

/**
 * Whether sharing is switched on and both stores are up.
 *
 * @returns {boolean}
 */
function sharingActive() {
  const features = configCache.getFeatures();
  const platform = configCache.getPlatform() || {};
  if (!isChatHistoryConfigured(features, platform)) return false;
  if (!isChatSharingConfigured(features, platform)) return false;
  return getChatRepository().isAvailable() && getChatShareRepository().isAvailable();
}

/**
 * The repositories to serve an owner request from.
 *
 * @returns {{chats: Object, shares: Object, settings: Object}}
 * @throws {ServiceError} 503 `CHAT_SHARING_UNAVAILABLE` while sharing is off or a store is down
 */
function requireSharing() {
  if (!sharingActive()) {
    throw new ServiceError('CHAT_SHARING_UNAVAILABLE', 'Chat sharing is unavailable');
  }
  return {
    chats: getChatRepository(),
    shares: getChatShareRepository(),
    settings: chatSharingSettings(configCache.getPlatform() || {})
  };
}

/**
 * The user database, as the login paths read it.
 *
 * @returns {Object} `{ users: { [id]: user } }`
 */
function usersDb() {
  const platform = configCache.getPlatform() || {};
  return loadUsers(localUsersFile(platform.localAuth));
}

/**
 * What a share shows about a user: id, display name and e-mail, never the
 * rest of the record.
 *
 * @param {Object} user - User record.
 * @returns {{id: string, name: string, email: string|null}}
 */
function userSummary(user) {
  return {
    id: String(user.id),
    name: String(user.name || user.username || user.id),
    email: user.email ? String(user.email) : null
  };
}

/**
 * Resolve recipient ids against the user database.
 *
 * @param {string[]} ids - Requested recipient ids.
 * @returns {{ok: true, details: Object[]}|{ok: false, unknown: string[]}}
 */
function resolveRecipients(ids) {
  const { users = {} } = usersDb();
  const details = [];
  const unknown = [];
  for (const id of ids) {
    // Own keys only: `users['__proto__']` is an object too.
    const user = Object.hasOwn(users, id) ? users[id] : null;
    if (!user || user.active === false) unknown.push(id);
    else details.push(userSummary(user));
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, details };
}

/**
 * The app a shared chat belongs to, as the viewer page shows it. The viewer
 * may have no access to the apps list (a public viewer has none at all), so
 * the few display fields travel with the share.
 *
 * @param {string|null} appId - App id.
 * @returns {{id: string, name: Object|string, color: string|null, icon: string|null}|null}
 */
function appSummary(appId) {
  if (!appId) return null;
  const apps = configCache.getApps(true)?.data || [];
  const app = apps.find(entry => entry?.id === appId);
  if (!app) return null;
  return { id: app.id, name: app.name, color: app.color || null, icon: app.icon || null };
}

/**
 * A share as its owner sees it: everything but the per-view log, plus the
 * state the link is in.
 *
 * @param {Object} share - Share document.
 * @param {number} [now] - Clock.
 * @returns {Object}
 */
function ownerView(share, now = Date.now()) {
  // eslint-disable-next-line no-unused-vars
  const { views, ...rest } = share;
  return { ...rest, state: shareState(share, now) };
}

/**
 * A share as a viewer sees it: what the page renders and nothing that would
 * identify the owner, the chat or the other recipients.
 *
 * @param {Object} share - Share document.
 * @returns {Object}
 */
function viewerView(share) {
  const sharedBy = share.mode === 'public' && !share.showOwnerName ? null : share.ownerName;
  return {
    id: share.id,
    mode: share.mode,
    title: share.title || '',
    appId: share.appId || null,
    app: appSummary(share.appId),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt || null,
    sharedBy: sharedBy || null,
    messageCount: share.messageCount || 0,
    target: share.target || 'chat',
    ...(share.target === 'artifact'
      ? { artifact: share.artifact || null, embeddable: share.embeddable === true }
      : {}),
    uploadedFilesAccess: share.uploadedFilesAccess || 'none',
    readOnly: true
  };
}

/**
 * Whether a viewer may open the file behind an attachment chip. A picture has no text to share,
 * so it opens only when the owner shared the originals.
 *
 * @param {{id: string, type?: string}} attachment
 * @param {Set<string>} sharedFiles - The files the owner left ticked
 * @param {boolean} originalsShared
 * @returns {boolean}
 */
function openableByViewer(attachment, sharedFiles, originalsShared) {
  if (!sharedFiles.has(attachment.id)) return false;
  return originalsShared || !/^image\//i.test(String(attachment.type || ''));
}

/**
 * The snapshot messages a viewer gets: the transcript minus the accounting.
 *
 * @param {Object[]} messages - Snapshot messages.
 * @returns {Object[]}
 */
function viewerMessages(messages, share = null) {
  const sharedFiles = new Set(
    share?.uploadedFilesAccess && share.uploadedFilesAccess !== 'none' ? share.fileIds || [] : []
  );
  const originalsShared = share?.uploadedFilesAccess === 'original';
  return (messages || []).map(message => {
    // A viewer renders none of these: `usage` is billing, `clientMessageId`
    // the owner's browser bookkeeping, `runId` a handle onto endpoints the
    // viewer is not authorized for anyway.
    // eslint-disable-next-line no-unused-vars
    const { usage, clientMessageId, runId, ...rest } = message;
    // An attachment chip always shows its name; whether the file behind it may
    // be opened is the owner's choice per file (`shared`).
    if (Array.isArray(rest.attachments)) {
      rest.attachments = rest.attachments.map(attachment =>
        attachment?.id
          ? { ...attachment, shared: openableByViewer(attachment, sharedFiles, originalsShared) }
          : attachment
      );
    }
    // Snapshots taken before causes were cut down to the public part carry
    // the actor and the worker; the viewer gets the explanation only.
    return rest.error?.cause ? { ...rest, error: withPublicCause(rest.error) } : rest;
  });
}

/**
 * Response headers every viewer answer carries. Nothing a viewer receives is
 * cacheable: a revoke has to take effect on the next request, and a public
 * page must not be indexed.
 *
 * @param {import('express').Response} res - Express response.
 * @param {Object} share - Share document.
 */
function setViewerHeaders(res, share) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (share.mode === 'public') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

/**
 * Load a share and decide whether this caller may open it.
 *
 * @param {import('express').Request} req - Express request.
 * @returns {Promise<{share: Object, access: Object}>}
 * @throws {ServiceError} 401 for an anonymous caller on a share that needs a sign-in, else 404
 */
async function loadViewableShare(req, { purpose = 'transcript' } = {}) {
  const { shareId } = req.params;
  if (!isShareId(shareId) || !sharingActive()) throw notFound('Share');
  const share = await getChatShareRepository().getShare(shareId);
  const access = await authorizeShareView(share, req.user, { purpose });
  if (!access.ok) {
    if (access.status === 401) {
      throw new ServiceError('AUTH_REQUIRED', 'Sign in to open this shared chat');
    }
    throw notFound('Share');
  }
  return { share, access };
}

/**
 * Whether `user` may act on `share` as its owner (or as an admin).
 *
 * @param {Object} share - Share document.
 * @param {Object} user - `req.user`.
 * @returns {Promise<boolean>}
 */
async function isShareOwnerOrAdmin(share, user) {
  // Delegated principals (personal API keys, add-in tokens) carry their
  // owner's groups but never their admin rights — same rule as the admin API.
  if (isAdmin(user)) return true;
  const me = await resolvePrincipal(user, { mode: share.identityMode || 'default' });
  return me.id === share.ownerId;
}

/**
 * Create a share of a chat (`artifactId` null) or of one of its artifacts.
 * Both routes validate, authorize and respond the same way; only the payload
 * differs.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Object} [options]
 * @param {string|null} [options.artifactId] - Artifact to share instead of the chat.
 * @returns {Promise<void>}
 */
async function handleCreateShare(req, res, { artifactId = null } = {}) {
  const isArtifactShare = artifactId !== null;
  const { chatId } = req.params;
  assertValidId(chatId, 'chat');
  if (isArtifactShare) assertValidId(artifactId, 'artifact');
  const deps = requireSharing();
  const parsedBody = (isArtifactShare ? createArtifactShareSchema : createShareSchema).parse(
    req.body || {}
  );
  const {
    mode,
    recipients = [],
    expiresAt,
    maxViews,
    showOwnerName = false,
    uploadedFilesAccess = 'none',
    sharedFileIds,
    embeddable = false
  } = parsedBody;
  if (isArtifactShare && deps.settings.allowArtifacts === false) {
    throw new ServiceError(
      'ARTIFACT_SHARING_DISABLED',
      'Sharing single artifacts is not allowed here'
    );
  }
  if (!allowedShareModes(deps.settings)[mode]) {
    throw new ServiceError('SHARE_MODE_DISABLED', `Sharing mode '${mode}' is not allowed here`, {
      details: { mode }
    });
  }
  // Write intent: sharing hands the conversation to others, which is the
  // owner's call and nobody else's — an admin reading a chat for
  // support cannot publish it.
  const auth = await authorizeChat(chatId, req.user, {
    repository: deps.chats,
    intent: 'write'
  });
  if (!auth.ok || !auth.chat) throw notFound('Chat');
  // A temporary chat is the one its owner asked not to keep, and it is
  // gone within a day: a link onto it would publish what was meant to
  // stay private and then break. Keeping the chat first is the way.
  if (auth.chat.temporary === true) {
    throw new ServiceError('CHAT_TEMPORARY', 'A temporary chat cannot be shared; keep it first');
  }

  let messages = [];
  let artifact = null;
  if (isArtifactShare) {
    const descriptors = await getArtifactRepository().list(deps.chats.artifactScope(chatId));
    artifact = descriptors.find(item => item.id === artifactId) || null;
    if (!artifact) throw notFound('Artifact');
    if (embeddable) {
      if (mode !== 'public')
        throw new ServiceError('BAD_REQUEST', 'Only public links can be embedded');
      if (!deps.settings.embedEnabled) {
        throw new ServiceError('EMBED_DISABLED', 'Embedding shared artifacts is not allowed here');
      }
      if (maxViews != null) {
        throw new ServiceError('BAD_REQUEST', 'An embeddable link cannot have a view limit');
      }
    }
  } else {
    ({ messages } = await deps.chats.getMessages(chatId));
    if (!messages.length) {
      throw new ServiceError('BAD_REQUEST', 'This chat has no messages to share yet');
    }
  }

  let recipientDetails = [];
  if (mode === 'users') {
    const ids = [...new Set(recipients.map(id => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) {
      throw new ServiceError('BAD_REQUEST', 'Pick at least one user to share with');
    }
    const resolved = resolveRecipients(ids);
    if (!resolved.ok) {
      throw new ServiceError('BAD_REQUEST', 'Some recipients are not known users', {
        details: { unknown: resolved.unknown }
      });
    }
    recipientDetails = resolved.details;
  }

  const limits = resolveShareLimits({ expiresAt, maxViews }, deps.settings);
  if (!limits.ok) throw new ServiceError('BAD_REQUEST', limits.error);

  // A pseudonymized installation records no names against a chat, and
  // a share must not become the place where one is written next to
  // the pseudonym — not for viewers, and not for the admin list.
  const pseudonymized = auth.chat.identityMode === 'pseudonymized';
  const share = await deps.shares.createShare({
    chatId,
    ownerId: auth.chat.ownerId,
    identityMode: auth.chat.identityMode,
    appId: auth.chat.appId,
    mode,
    recipients: recipientDetails.map(entry => entry.id),
    recipientDetails,
    title: buildShareTitle({ chat: auth.chat, messages, artifact }),
    ownerName: pseudonymized ? null : req.user?.name || req.user?.username || null,
    showOwnerName: pseudonymized ? false : showOwnerName,
    expiresAt: limits.expiresAt,
    maxViews: limits.maxViews,
    messages,
    uploadedFilesAccess,
    sharedFileIds,
    ...(isArtifactShare ? { target: 'artifact', artifact, embeddable } : {})
  });
  if (!share) throw new ServiceError('CHAT_SHARING_UNAVAILABLE', 'Chat sharing is unavailable');

  logAudit({
    req,
    action: 'create',
    resource: isArtifactShare ? 'artifactShare' : 'chatShare',
    resourceId: share.id,
    summary: `Shared ${isArtifactShare ? `artifact ${artifactId} of chat` : 'chat'} ${chatId} ${
      mode === 'public'
        ? 'publicly (no sign-in required)'
        : `with ${mode === 'users' ? `${share.recipients.length} user(s)` : 'signed-in users'}`
    }`
  });
  sendCreated(res, `/api/shares/${segment(share.id)}`, ownerView(share));
}

/**
 * Register the sharing endpoints.
 *
 * @param {import('express').Application} app - Express application.
 * @returns {void}
 */
export default function registerChatShareRoutes(app) {
  app.post(
    buildServerPath('/api/chats/:chatId/shares'),
    requireFeature(CHAT_SHARING_FEATURE),
    authenticatedOnly,
    (req, res) => handleCreateShare(req, res)
  );

  app.post(
    buildServerPath('/api/chats/:chatId/artifacts/:artifactId/shares'),
    requireFeature(CHAT_SHARING_FEATURE),
    authenticatedOnly,
    (req, res) => handleCreateShare(req, res, { artifactId: req.params.artifactId })
  );

  app.get(buildServerPath('/api/chats/:chatId/shares'), authenticatedOnly, async (req, res) => {
    const { chatId } = req.params;
    assertValidId(chatId, 'chat');
    const deps = requireSharing();
    const auth = await authorizeChat(chatId, req.user, {
      repository: deps.chats,
      intent: 'write'
    });
    if (!auth.ok || !auth.chat) throw notFound('Chat');
    const now = Date.now();
    const artifactId = typeof req.query.artifactId === 'string' ? req.query.artifactId : null;
    const items = (await deps.shares.listSharesForChat(chatId))
      .filter(
        share => !artifactId || (share.target === 'artifact' && share.artifact?.id === artifactId)
      )
      .map(share => ownerView(share, now));
    res.json({ items });
  });

  app.get(buildServerPath('/api/shares/with-me'), authenticatedOnly, async (req, res) => {
    // Empty rather than 503 when sharing is off: this feeds a tab on the
    // chat list, and a switched-off feature is an empty tab, not an error.
    if (!sharingActive()) return res.json({ items: [] });
    const userId = String(req.user.id);
    const shares = await getChatShareRepository().listSharesForRecipient(userId);
    const items = shares.map(share => {
      const mine = share.recipientViews?.[userId] || null;
      return {
        ...viewerView(share),
        viewed: Boolean(mine && mine.count > 0),
        lastViewedAt: mine?.lastViewedAt || null
      };
    });
    res.json({ items });
  });

  app.get(buildServerPath('/api/shares/:shareId'), async (req, res) => {
    const { share, access } = await loadViewableShare(req);
    const repository = getChatShareRepository();
    if (access.counts) {
      // Counted under the share's lock, where the view limit is checked
      // again: the open that reaches it is served, the next is not. The
      // per-view log stores the viewer as the share's identity mode
      // records people — a hash on a pseudonymized installation.
      const recordAs = access.viewerId
        ? (await resolvePrincipal(req.user, { mode: share.identityMode || 'default' })).id
        : null;
      const { counted } = await repository.recordView(share.id, access.viewerId, { recordAs });
      if (!counted) throw notFound('Share');
    }
    const snapshot = await repository.getSnapshot(share.id);
    if (!snapshot) {
      logger.error('Share has no snapshot', { component: COMPONENT, shareId: share.id });
      throw notFound('Share');
    }
    setViewerHeaders(res, share);
    res.json({
      share: viewerView(share),
      messages: viewerMessages(snapshot.messages, share),
      version: snapshot.version
    });
  });

  // The uploaded files of a shared chat. Hidden unless the owner opted in when
  // creating the share (`uploadedFilesAccess`), and then only the files they
  // left ticked: the transcript names every attachment, these routes serve
  // the shared ones.
  app.get(buildServerPath('/api/shares/:shareId/files'), async (req, res) => {
    const { share } = await loadViewableShare(req, { purpose: 'artifact' });
    const access = share.uploadedFilesAccess || 'none';
    const allowed = new Set(access === 'none' ? [] : share.fileIds || []);
    const scope = getChatRepository().fileScope(share.chatId);
    // Viewers get what describes a file, never where it came from (the
    // mailbox user, an e-mail's addresses, a connector path).
    const items =
      allowed.size > 0
        ? (await getChatRepository().fileStore().list(scope))
            .filter(item => allowed.has(item.id))
            // A picture has no text to share: with text-only access there is nothing to list
            .filter(item => item.origin !== 'image' || access === 'original')
            .map(({ meta: _meta, source: _source, ...visible }) => ({
              ...visible,
              hasOriginal: visible.hasOriginal && access === 'original'
            }))
        : [];
    setViewerHeaders(res, share);
    res.json({ uploadedFilesAccess: access, items });
  });

  app.get(buildServerPath('/api/shares/:shareId/files/:fileId'), async (req, res) => {
    const { fileId } = req.params;
    assertValidId(fileId, 'file');
    const { share } = await loadViewableShare(req, { purpose: 'artifact' });
    const access = share.uploadedFilesAccess || 'none';
    if (access === 'none') {
      throw new ServiceError('FILES_NOT_SHARED', 'The owner did not share the attached files');
    }
    // A file the owner left out answers like one that does not exist.
    if (!(share.fileIds || []).includes(fileId)) throw notFound('File');
    const store = getChatRepository().fileStore();
    const scope = getChatRepository().fileScope(share.chatId);
    setViewerHeaders(res, share);

    if (req.query.format === 'text') {
      const textFile = await store.getText(scope, fileId);
      if (!textFile) throw notFound('File');
      // The viewer gets the text and what describes it, nothing of the
      // owner's storage bookkeeping.
      return res.json({
        id: textFile.id,
        name: textFile.name,
        mimeType: textFile.mimeType,
        formatLabel: textFile.formatLabel,
        bytes: textFile.bytes,
        pages: textFile.pages,
        origin: textFile.origin,
        text: textFile.text,
        hasOriginal: textFile.hasOriginal && access === 'original'
      });
    }

    if (access !== 'original') {
      throw new ServiceError(
        'ORIGINAL_NOT_SHARED',
        'The owner shared the text of this file, not the original'
      );
    }
    const original = await store.getOriginal(scope, fileId);
    if (!original) throw notFound('File');
    if (original.discarded) {
      throw new ServiceError('ORIGINAL_DISCARDED', 'The original file is no longer available');
    }
    const download = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', servedMediaType(original.mimeType));
    res.setHeader('Content-Length', String(original.data.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (share.mode === 'public') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader(
      'Content-Disposition',
      download ? buildContentDisposition(original.name) : 'inline'
    );
    return res.send(original.data);
  });

  app.get(buildServerPath('/api/shares/:shareId/artifacts'), async (req, res) => {
    const { share } = await loadViewableShare(req, { purpose: 'artifact' });
    const allowed = new Set(share.artifactIds || []);
    const scope = getChatRepository().artifactScope(share.chatId);
    const items = (await getArtifactRepository().list(scope)).filter(item => allowed.has(item.id));
    setViewerHeaders(res, share);
    res.json({ items });
  });

  // Several of the share's artifacts as one ZIP: `{ artifactIds?: string[] }`,
  // every one the snapshot named when omitted. Nothing outside the share's
  // allow-list can be packed — an id beyond it answers 404 like an unknown one.
  app.post(buildServerPath('/api/shares/:shareId/artifacts/zip'), async (req, res) => {
    const { share } = await loadViewableShare(req, { purpose: 'artifact' });
    const allowed = new Set(share.artifactIds || []);
    const scope = getChatRepository().artifactScope(share.chatId);
    const artifacts = getArtifactRepository();
    const descriptors = (await artifacts.list(scope)).filter(item => allowed.has(item.id));
    return await sendArtifactsZip(res, {
      repository: artifacts,
      scope,
      descriptors,
      artifactIds: req.body?.artifactIds,
      archiveName: 'shared-chat-artifacts.zip',
      beforeSend: response => setViewerHeaders(response, share)
    });
  });

  app.get(buildServerPath('/api/shares/:shareId/artifacts/:artifactId'), async (req, res) => {
    const { artifactId } = req.params;
    assertValidId(artifactId, 'artifact');
    const { share } = await loadViewableShare(req, { purpose: 'artifact' });
    // The allow-list is what the snapshot named. Everything else in the
    // chat's scope — an image from a turn after the share, one from an
    // edited-away exchange — answers 404 exactly like an unknown id.
    if (!(share.artifactIds || []).includes(artifactId)) throw notFound('Artifact');
    const artifact = await getArtifactRepository().get(
      getChatRepository().artifactScope(share.chatId),
      artifactId
    );
    if (!artifact) throw notFound('Artifact');
    const body = artifact.data;
    const download = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', servedMediaType(artifact.mimeType));
    res.setHeader('Content-Length', String(body.length));
    // Written once, keyed by a fresh uuid: the bytes behind this URL cannot
    // change. `private`, because the link may be revoked and a shared cache
    // must not keep serving what the owner took back.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (share.mode === 'public') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (download) {
      const name = downloadName(artifact);
      const ascii = name.replace(/[^\x20-\x7e]/g, '_');
      let encoded;
      try {
        encoded = encodeURIComponent(name);
      } catch {
        encoded = encodeURIComponent(ascii);
      }
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
      );
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }
    return res.send(body);
  });

  // What the provider embedded in a shared image (EU AI Act Art. 50(2)): the same answer
  // as the owner's route, behind the share's own allow-list.
  app.get(
    buildServerPath('/api/shares/:shareId/artifacts/:artifactId/provenance'),
    requireEuAiActEnabled('provenance'),
    async (req, res) => {
      const { artifactId } = req.params;
      assertValidId(artifactId, 'artifact');
      const { share } = await loadViewableShare(req, { purpose: 'artifact' });
      if (!(share.artifactIds || []).includes(artifactId)) throw notFound('Artifact');
      const artifact = await getArtifactRepository().get(
        getChatRepository().artifactScope(share.chatId),
        artifactId
      );
      if (!artifact) throw notFound('Artifact');
      setViewerHeaders(res, share);
      return res.json(await providerMarkingOfArtifact(artifact));
    }
  );

  app.delete(buildServerPath('/api/shares/:shareId'), authenticatedOnly, async (req, res) => {
    const { shareId } = req.params;
    const repository = getChatShareRepository();
    if (!isShareId(shareId) || !repository.isAvailable()) throw notFound('Share');
    const share = await repository.getShare(shareId);
    // 404 for both unknown and not-yours, as everywhere else in this API.
    if (!share || !(await isShareOwnerOrAdmin(share, req.user))) {
      throw notFound('Share');
    }
    const revoked = await repository.revokeShare(shareId);
    if (!revoked) throw notFound('Share');
    logAudit({
      req,
      action: 'delete',
      resource: 'chatShare',
      resourceId: shareId,
      summary: `Revoked share of chat ${share.chatId} (${share.mode})`
    });
    res.json(ownerView(revoked));
  });

  app.get(
    buildServerPath('/api/users/lookup'),
    requireFeature(CHAT_SHARING_FEATURE),
    authenticatedOnly,
    async (req, res) => {
      // The picker exists for one thing: addressing a share to users. It
      // answers nothing while that is not on offer — sharing off, user
      // links switched off, storage down — and nothing to a principal that
      // could never be handed a share: a machine token or an agent.
      const settings = chatSharingSettings(configCache.getPlatform() || {});
      if (!sharingActive() || !allowedShareModes(settings).users) {
        return res.json({ items: [] });
      }
      if (req.user?.isOAuthClient || req.user?.isAgent === true) {
        return res.json({ items: [] });
      }
      const raw = typeof req.query.q === 'string' ? req.query.q : '';
      const q = raw.trim().slice(0, LOOKUP_MAX_CHARS).toLowerCase();
      if (q.length < LOOKUP_MIN_CHARS) return res.json({ items: [] });
      const { users = {} } = usersDb();
      const me = String(req.user.id);
      const items = Object.values(users)
        .filter(user => user && user.active !== false && String(user.id) !== me)
        .filter(user =>
          [user.name, user.username, user.email].some(
            field => typeof field === 'string' && field.toLowerCase().includes(q)
          )
        )
        .map(userSummary)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, LOOKUP_LIMIT);
      res.json({ items });
    }
  );
}
