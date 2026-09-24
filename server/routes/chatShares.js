/**
 * Chat share routes — read-only links onto durable chats (#2515).
 *
 *   POST   /api/chats/:chatId/shares               create a share of this chat
 *   GET    /api/chats/:chatId/shares               this chat's shares, with view stats (owner)
 *   GET    /api/shares/with-me                     `users` shares addressed to the caller
 *   GET    /api/shares/:shareId                    the frozen transcript (auth per mode)
 *   GET    /api/shares/:shareId/artifacts          descriptors of the artifacts it references
 *   GET    /api/shares/:shareId/artifacts/:id      the bytes of one (`?download=1` to attach)
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
import { validateIdForPath } from '../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { requireFeature } from '../featureRegistry.js';
import { logAudit } from '../services/AuditLogService.js';
import { isAdminUser, resolvePrincipal } from '../services/loop/runIdentity.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { isChatPersistenceConfigured } from '../services/chat/chatPersistence.js';
import { getChatShareRepository, isShareId } from '../services/chat/ChatShareRepository.js';
import { authorizeShareView } from '../services/chat/chatShareAccess.js';
import {
  CHAT_SHARING_FEATURE,
  MAX_SHARE_RECIPIENTS,
  SHARE_MODES,
  allowedShareModes,
  chatSharingSettings,
  isChatSharingConfigured,
  resolveShareLimits,
  shareState
} from '../services/chat/chatSharing.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';

const COMPONENT = 'ChatShareRoutes';

/** Machine-readable code for "sharing is not answering right now". */
const UNAVAILABLE_CODE = 'CHAT_SHARING_UNAVAILABLE';

/** Machine-readable code for a sign-in the viewer can go and get. */
const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';

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
    showOwnerName: z.boolean().optional()
  })
  .strict();

function sendSharingUnavailable(res) {
  return sendErrorResponse(res, 503, 'Chat sharing is unavailable', {
    details: { code: UNAVAILABLE_CODE }
  });
}

function sendStorageError(res, error, operation) {
  if (error instanceof StorageError) {
    const status = storageHttpStatus(error);
    if (status) {
      return sendErrorResponse(res, status, error.message, { details: { code: error.code } });
    }
  }
  return sendFailedOperationError(res, operation, error);
}

/**
 * Whether sharing is switched on and both stores are up.
 *
 * @returns {boolean}
 */
function sharingActive() {
  const features = configCache.getFeatures();
  const platform = configCache.getPlatform() || {};
  if (!isChatPersistenceConfigured(features, platform)) return false;
  if (!isChatSharingConfigured(features, platform)) return false;
  return getChatRepository().isAvailable() && getChatShareRepository().isAvailable();
}

/**
 * The repositories to serve an owner request from, or null once a 503 went out.
 *
 * @param {import('express').Response} res - Express response.
 * @returns {{chats: Object, shares: Object, settings: Object}|null}
 */
function requireSharing(res) {
  if (!sharingActive()) {
    sendSharingUnavailable(res);
    return null;
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
    const user = users[id];
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
    readOnly: true
  };
}

/**
 * The snapshot messages a viewer gets: the transcript minus the accounting.
 *
 * @param {Object[]} messages - Snapshot messages.
 * @returns {Object[]}
 */
function viewerMessages(messages) {
  return (messages || []).map(message => {
    // eslint-disable-next-line no-unused-vars
    const { usage, clientMessageId, ...rest } = message;
    return rest;
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
 * Load a share and decide whether this caller may open it. Sends the
 * response on refusal.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<{share: Object, access: Object}|null>}
 */
async function loadViewableShare(req, res) {
  const { shareId } = req.params;
  if (!isShareId(shareId) || !sharingActive()) {
    sendNotFound(res, 'Share');
    return null;
  }
  const share = await getChatShareRepository().getShare(shareId);
  const access = await authorizeShareView(share, req.user);
  if (!access.ok) {
    if (access.status === 401) {
      sendErrorResponse(res, 401, 'Sign in to open this shared chat', {
        details: { code: AUTH_REQUIRED_CODE }
      });
    } else {
      sendNotFound(res, 'Share');
    }
    return null;
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
  if (isAdminUser(user)) return true;
  const me = await resolvePrincipal(user, { mode: share.identityMode || 'default' });
  return me.id === share.ownerId;
}

/**
 * A file name for a downloaded artifact, from its stored name or its kind.
 *
 * @param {Object} artifact - Artifact with `name`, `kind`, `mimeType`, `id`.
 * @returns {string}
 */
function downloadName(artifact) {
  const stored = typeof artifact.name === 'string' ? artifact.name.trim() : '';
  if (stored) return stored.replace(/[\r\n"\\/]+/g, '_').slice(0, 200);
  const ext =
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/markdown': 'md'
    }[artifact.mimeType] || 'bin';
  return `${artifact.kind || 'artifact'}-${String(artifact.id).slice(0, 8)}.${ext}`;
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
    async (req, res) => {
      try {
        const { chatId } = req.params;
        if (!validateIdForPath(chatId, 'chat', res)) return;
        const deps = requireSharing(res);
        if (!deps) return;
        const parsed = createShareSchema.safeParse(req.body || {});
        if (!parsed.success) {
          return sendBadRequest(
            res,
            `Invalid share request: ${parsed.error.issues
              .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
              .join('; ')}`
          );
        }
        const { mode, recipients = [], expiresAt, maxViews, showOwnerName = false } = parsed.data;
        if (!allowedShareModes(deps.settings)[mode]) {
          return sendErrorResponse(res, 403, `Sharing mode '${mode}' is not allowed here`, {
            details: { code: 'SHARE_MODE_DISABLED' }
          });
        }
        // Write intent: sharing hands the conversation to others, which is the
        // owner's call and nobody else's — an admin reading a chat for
        // support cannot publish it.
        const auth = await authorizeChat(chatId, req.user, {
          repository: deps.chats,
          intent: 'write'
        });
        if (!auth.ok || !auth.chat) return sendNotFound(res, 'Chat');

        const { messages } = await deps.chats.getMessages(chatId);
        if (!messages.length) {
          return sendBadRequest(res, 'This chat has no messages to share yet');
        }

        let recipientDetails = [];
        if (mode === 'users') {
          const ids = [...new Set(recipients.map(id => String(id).trim()).filter(Boolean))];
          if (ids.length === 0) {
            return sendBadRequest(res, 'Pick at least one user to share with');
          }
          const resolved = resolveRecipients(ids);
          if (!resolved.ok) {
            return sendBadRequest(res, 'Some recipients are not known users', {
              unknown: resolved.unknown
            });
          }
          recipientDetails = resolved.details;
        }

        const limits = resolveShareLimits({ expiresAt, maxViews }, deps.settings);
        if (!limits.ok) return sendBadRequest(res, limits.error);

        const share = await deps.shares.createShare({
          chatId,
          ownerId: auth.chat.ownerId,
          identityMode: auth.chat.identityMode,
          appId: auth.chat.appId,
          mode,
          recipients: recipientDetails.map(entry => entry.id),
          recipientDetails,
          title: auth.chat.title || '',
          ownerName: req.user?.name || req.user?.username || null,
          showOwnerName,
          expiresAt: limits.expiresAt,
          maxViews: limits.maxViews,
          messages
        });
        if (!share) return sendSharingUnavailable(res);

        logAudit({
          req,
          action: 'create',
          resource: 'chatShare',
          resourceId: share.id,
          summary:
            mode === 'public'
              ? `Shared chat ${chatId} publicly (no sign-in required)`
              : `Shared chat ${chatId} with ${
                  mode === 'users' ? `${share.recipients.length} user(s)` : 'signed-in users'
                }`
        });
        res.status(201).json({ share: ownerView(share) });
      } catch (error) {
        sendStorageError(res, error, 'create chat share');
      }
    }
  );

  app.get(buildServerPath('/api/chats/:chatId/shares'), authenticatedOnly, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const deps = requireSharing(res);
      if (!deps) return;
      const auth = await authorizeChat(chatId, req.user, {
        repository: deps.chats,
        intent: 'write'
      });
      if (!auth.ok || !auth.chat) return sendNotFound(res, 'Chat');
      const now = Date.now();
      const items = (await deps.shares.listSharesForChat(chatId)).map(share =>
        ownerView(share, now)
      );
      res.json({ items });
    } catch (error) {
      sendStorageError(res, error, 'list chat shares');
    }
  });

  app.get(buildServerPath('/api/shares/with-me'), authenticatedOnly, async (req, res) => {
    try {
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
    } catch (error) {
      sendStorageError(res, error, 'list shares with me');
    }
  });

  app.get(buildServerPath('/api/shares/:shareId'), async (req, res) => {
    try {
      const loaded = await loadViewableShare(req, res);
      if (!loaded) return;
      const { share, access } = loaded;
      const repository = getChatShareRepository();
      if (access.counts) {
        // Counted under the share's lock, where the view limit is checked
        // again: the open that reaches it is served, the next is not.
        const { counted } = await repository.recordView(share.id, access.viewerId);
        if (!counted) return sendNotFound(res, 'Share');
      }
      const snapshot = await repository.getSnapshot(share.id);
      if (!snapshot) {
        logger.error('Share has no snapshot', { component: COMPONENT, shareId: share.id });
        return sendNotFound(res, 'Share');
      }
      setViewerHeaders(res, share);
      res.json({
        share: viewerView(share),
        messages: viewerMessages(snapshot.messages),
        version: snapshot.version
      });
    } catch (error) {
      sendStorageError(res, error, 'open chat share');
    }
  });

  app.get(buildServerPath('/api/shares/:shareId/artifacts'), async (req, res) => {
    try {
      const loaded = await loadViewableShare(req, res);
      if (!loaded) return;
      const { share } = loaded;
      const allowed = new Set(share.artifactIds || []);
      const scope = getChatRepository().artifactScope(share.chatId);
      const items = (await getArtifactRepository().list(scope)).filter(item =>
        allowed.has(item.id)
      );
      setViewerHeaders(res, share);
      res.json({ items });
    } catch (error) {
      sendStorageError(res, error, 'list shared artifacts');
    }
  });

  app.get(buildServerPath('/api/shares/:shareId/artifacts/:artifactId'), async (req, res) => {
    try {
      const { artifactId } = req.params;
      if (!validateIdForPath(artifactId, 'artifact', res)) return;
      const loaded = await loadViewableShare(req, res);
      if (!loaded) return;
      const { share } = loaded;
      // The allow-list is what the snapshot named. Everything else in the
      // chat's scope — an image from a turn after the share, one from an
      // edited-away exchange — answers 404 exactly like an unknown id.
      if (!(share.artifactIds || []).includes(artifactId)) return sendNotFound(res, 'Artifact');
      const artifact = await getArtifactRepository().get(
        getChatRepository().artifactScope(share.chatId),
        artifactId
      );
      if (!artifact) return sendNotFound(res, 'Artifact');
      const body = artifact.data;
      const download = req.query.download === '1' || req.query.download === 'true';
      res.setHeader('Content-Type', artifact.mimeType);
      res.setHeader('Content-Length', String(body.length));
      // Written once, keyed by a fresh uuid: the bytes behind this URL cannot
      // change. `private`, because the link may be revoked and a shared cache
      // must not keep serving what the owner took back.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (share.mode === 'public') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (download) {
        const name = downloadName(artifact);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
        );
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      return res.send(body);
    } catch (error) {
      return sendStorageError(res, error, 'get shared artifact');
    }
  });

  app.delete(buildServerPath('/api/shares/:shareId'), authenticatedOnly, async (req, res) => {
    try {
      const { shareId } = req.params;
      const repository = getChatShareRepository();
      if (!isShareId(shareId) || !repository.isAvailable()) return sendNotFound(res, 'Share');
      const share = await repository.getShare(shareId);
      // 404 for both unknown and not-yours, as everywhere else in this API.
      if (!share || !(await isShareOwnerOrAdmin(share, req.user))) {
        return sendNotFound(res, 'Share');
      }
      const revoked = await repository.revokeShare(shareId);
      if (!revoked) return sendNotFound(res, 'Share');
      logAudit({
        req,
        action: 'delete',
        resource: 'chatShare',
        resourceId: shareId,
        summary: `Revoked share of chat ${share.chatId} (${share.mode})`
      });
      res.json({ share: ownerView(revoked) });
    } catch (error) {
      sendStorageError(res, error, 'revoke chat share');
    }
  });

  app.get(
    buildServerPath('/api/users/lookup'),
    requireFeature(CHAT_SHARING_FEATURE),
    authenticatedOnly,
    async (req, res) => {
      try {
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
      } catch (error) {
        sendFailedOperationError(res, 'look up users', error);
      }
    }
  );
}
