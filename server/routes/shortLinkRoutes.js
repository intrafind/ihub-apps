import {
  createLink,
  getLink,
  recordUsage,
  deleteLink,
  updateLink,
  searchLinks,
  isLinkExpired,
  canManageLink,
  ShortLinkTargetError
} from '../shortLinkManager.js';
import configCache from '../configCache.js';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { isAdminAuthRequired } from '../middleware/adminAuth.js';
import { isAllowedShortLinkTarget } from '../utils/shortLinkTarget.js';
import {
  sendBadRequest,
  sendNotFound,
  sendFailedOperationError,
  sendErrorResponse,
  sendInsufficientPermissions
} from '../utils/responseHelpers.js';
import { buildServerPath } from '../utils/basePath.js';
import { requireFeature } from '../featureRegistry.js';
import logger from '../utils/logger.js';

/** Hosts an absolute short link target may name (`platform.shortLinks.allowedHosts`). */
function allowedHosts() {
  return configCache.getPlatform()?.shortLinks?.allowedHosts || [];
}

/** Whether the caller is an admin, by the same rule as `adminAuth`. */
function isAdmin(req) {
  return !isAdminAuthRequired(req);
}

const TARGET_NOT_ALLOWED =
  'The target must be a path on this server or a URL on an allowed host (shortLinks.allowedHosts)';

export default function registerShortLinkRoutes(app) {
  // Links belong to the signed-in user who creates them; only they and admins
  // may list, change or delete them.
  app.post(
    buildServerPath('/api/shortlinks'),
    requireFeature('shortLinks'),
    authenticatedOnly,
    async (req, res) => {
      try {
        const { code, appId, path, params, url, includeParams, expiresAt } = req.body;
        if (!url && !appId && !path) {
          return sendBadRequest(res, 'appId or url or path required');
        }
        const link = await createLink(
          {
            code,
            appId,
            ownerId: req.user.id,
            path,
            params,
            url,
            includeParams,
            expiresAt
          },
          { allowedHosts: allowedHosts() }
        );
        res.json(link);
      } catch (error) {
        if (error.message === 'Code already exists') {
          return sendErrorResponse(res, 409, 'Code already exists');
        }
        if (error instanceof ShortLinkTargetError) {
          return sendBadRequest(res, TARGET_NOT_ALLOWED);
        }
        sendFailedOperationError(res, 'create short link', error);
      }
    }
  );

  app.get(
    buildServerPath('/api/shortlinks'),
    requireFeature('shortLinks'),
    authenticatedOnly,
    async (req, res) => {
      try {
        const appId = typeof req.query.appId === 'string' ? req.query.appId : undefined;
        // Admins see every link (optionally one owner's); everyone else their own.
        const ownerId = isAdmin(req)
          ? typeof req.query.ownerId === 'string'
            ? req.query.ownerId
            : undefined
          : req.user.id;
        const links = await searchLinks({ appId, ownerId });
        res.json(links);
      } catch (error) {
        sendFailedOperationError(res, 'fetch short links', error);
      }
    }
  );

  app.get(
    buildServerPath('/api/shortlinks/:code'),
    requireFeature('shortLinks'),
    authenticatedOnly,
    async (req, res) => {
      try {
        const link = await getLink(req.params.code);
        if (!link) return sendNotFound(res, 'Short link');
        // Anyone signed in may learn that a code is taken (the share dialog
        // checks a custom code this way); only the owner and admins see the link.
        if (!canManageLink(link, req.user, isAdmin(req))) {
          return res.json({ code: link.code });
        }
        res.json(link);
      } catch (error) {
        sendFailedOperationError(res, 'fetch short link', error);
      }
    }
  );

  app.put(
    buildServerPath('/api/shortlinks/:code'),
    requireFeature('shortLinks'),
    authenticatedOnly,
    async (req, res) => {
      try {
        const existing = await getLink(req.params.code);
        if (!existing) return sendNotFound(res, 'Short link');
        if (!canManageLink(existing, req.user, isAdmin(req))) {
          return sendInsufficientPermissions(res, 'ownership of the short link');
        }
        const link = await updateLink(req.params.code, req.body || {}, {
          allowedHosts: allowedHosts()
        });
        if (!link) return sendNotFound(res, 'Short link');
        res.json(link);
      } catch (error) {
        if (error instanceof ShortLinkTargetError) {
          return sendBadRequest(res, TARGET_NOT_ALLOWED);
        }
        sendFailedOperationError(res, 'update short link', error);
      }
    }
  );

  app.delete(
    buildServerPath('/api/shortlinks/:code'),
    requireFeature('shortLinks'),
    authenticatedOnly,
    async (req, res) => {
      try {
        const existing = await getLink(req.params.code);
        if (!existing) return sendNotFound(res, 'Short link');
        if (!canManageLink(existing, req.user, isAdmin(req))) {
          return sendInsufficientPermissions(res, 'ownership of the short link');
        }
        const ok = await deleteLink(req.params.code);
        if (!ok) return sendNotFound(res, 'Short link');
        res.json({ success: true });
      } catch (error) {
        sendFailedOperationError(res, 'delete short link', error);
      }
    }
  );

  app.get(buildServerPath('/s/:code'), requireFeature('shortLinks'), async (req, res) => {
    try {
      const link = await getLink(req.params.code);
      if (!link) return res.status(404).send('Not found');
      if (isLinkExpired(link)) {
        return res.status(410).send('This short link has expired');
      }
      // Checked on every redirect, not only on save: links stored before the
      // check existed, or before an admin narrowed the allowlist, are covered.
      if (!isAllowedShortLinkTarget(link.url, allowedHosts())) {
        logger.warn('Short link target not allowed; not redirecting', {
          component: 'ShortLinkRoutes',
          code: link.code
        });
        return res.status(404).send('Not found');
      }
      // Counting the visit must not stand between the user and the link.
      try {
        await recordUsage(link.code);
      } catch (error) {
        logger.warn('Could not record short link usage', {
          component: 'ShortLinkRoutes',
          code: link.code,
          error: error.message
        });
      }
      res.redirect(link.url);
    } catch (error) {
      logger.error('Error redirecting short link', { component: 'ShortLinkRoutes', error });
      res.status(500).send('Error');
    }
  });
}
