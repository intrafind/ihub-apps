import { authRequired } from '../middleware/authRequired.js';
import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { buildContentDisposition } from '../utils/safeContentDisposition.js';
import { sendInternalError, sendNotFound } from '../utils/responseHelpers.js';
import { getGeneratedFile } from '../services/documents/generatedFiles.js';

/**
 * Downloads of files a tool generated for the user (a PDF the model created).
 *
 * A file is stored under its owner (see `services/documents/generatedFiles.js`),
 * so the lookup itself is the authorization: another user's id is simply not
 * found in the caller's scope.
 */
export default function registerGeneratedFileRoutes(app) {
  app.get(buildServerPath('/api/generated-files/:fileId'), authRequired, async (req, res) => {
    try {
      const platformConfig = configCache.getPlatform() || {};
      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        req.user = enhanceUserWithPermissions(null, platformConfig.auth || {}, platformConfig);
      }
      const file = await getGeneratedFile(req.user, String(req.params.fileId || ''));
      if (!file) return sendNotFound(res, 'File');
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', String(file.data.length));
      res.setHeader('Content-Disposition', buildContentDisposition(file.name || 'download'));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Never cached: the browser's HTTP cache is not partitioned by the
      // signed-in user, so a cached file could outlive a switch of accounts.
      res.setHeader('Cache-Control', 'no-store');
      return res.send(file.data);
    } catch (error) {
      return sendInternalError(res, error, 'download generated file');
    }
  });
}
