import {
  createLink,
  getLink,
  recordUsage,
  deleteLink,
  updateLink,
  searchLinks,
  isLinkExpired
} from '../shortLinkManager.js';
import { authRequired } from '../middleware/authRequired.js';
import {
  sendBadRequest,
  sendNotFound,
  sendFailedOperationError
} from '../utils/responseHelpers.js';
import { buildServerPath } from '../utils/basePath.js';

export default function registerShortLinkRoutes(app, basePath = '') {
  app.post(buildServerPath('/api/shortlinks', basePath), authRequired, async (req, res) => {
    try {
      const { code, appId, userId, path, params, url, includeParams, expiresAt } = req.body;
      if (!url && !appId && !path) {
        return sendBadRequest(res, 'appId or url or path required');
      }
      const link = await createLink({
        code,
        appId,
        userId,
        path,
        params,
        url,
        includeParams,
        expiresAt
      });
      res.json(link);
    } catch (e) {
      if (e.message === 'Code already exists') {
        return res.status(409).json({ error: 'Code already exists' });
      }
      sendFailedOperationError(res, 'create short link', e);
    }
  });

  app.get(buildServerPath('/api/shortlinks', basePath), authRequired, async (req, res) => {
    try {
      const { appId, userId } = req.query;
      const links = await searchLinks({ appId, userId });
      res.json(links);
    } catch (e) {
      sendFailedOperationError(res, 'fetch short links', e);
    }
  });

  app.get(buildServerPath('/api/shortlinks/:code', basePath), authRequired, async (req, res) => {
    try {
      const link = await getLink(req.params.code);
      if (!link) return sendNotFound(res, 'Short link');
      res.json(link);
    } catch (e) {
      sendFailedOperationError(res, 'fetch short link', e);
    }
  });

  app.put(buildServerPath('/api/shortlinks/:code', basePath), authRequired, async (req, res) => {
    try {
      const link = await updateLink(req.params.code, req.body);
      if (!link) return sendNotFound(res, 'Short link');
      res.json(link);
    } catch (e) {
      sendFailedOperationError(res, 'update short link', e);
    }
  });

  app.delete(buildServerPath('/api/shortlinks/:code', basePath), authRequired, async (req, res) => {
    try {
      const ok = await deleteLink(req.params.code);
      if (!ok) return sendNotFound(res, 'Short link');
      res.json({ success: true });
    } catch (e) {
      sendFailedOperationError(res, 'delete short link', e);
    }
  });

  app.get(buildServerPath('/s/:code', basePath), async (req, res) => {
    try {
      const link = await recordUsage(req.params.code);
      if (!link) return res.status(404).send('Not found');
      if (isLinkExpired(link)) {
        return res.status(410).send('This short link has expired');
      }
      res.redirect(link.url);
    } catch (e) {
      console.error('Error redirecting short link:', e);
      res.status(500).send('Error');
    }
  });
}
