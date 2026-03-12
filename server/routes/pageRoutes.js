import { loadText } from '../configLoader.js';
import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath, sanitizeLanguageCode } from '../utils/pathSecurity.js';
import {
  sendInternalError,
  sendNotFound,
  sendAuthRequired,
  sendInsufficientPermissions,
  sendErrorResponse
} from '../utils/responseHelpers.js';

export default function registerPageRoutes(app) {
  app.get(buildServerPath('/api/pages/:pageId'), async (req, res) => {
    const { pageId } = req.params;

    // Validate pageId to prevent path traversal
    if (!validateIdForPath(pageId, 'page', res)) return;

    const lang = sanitizeLanguageCode(req.query.lang);
    try {
      // Try to get UI config from cache first
      let { data: uiConfig } = configCache.getUI();

      if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
        return sendNotFound(res, 'Page');
      }
      const pageConfig = uiConfig.pages[pageId];

      const { authRequired = false, allowedGroups } = pageConfig;

      // Require authentication if configured
      if (authRequired && (!req.user || req.user.id === 'anonymous')) {
        return sendAuthRequired(res);
      }

      // Check allowed groups if specified
      if (
        Array.isArray(allowedGroups) &&
        allowedGroups.length > 0 &&
        !allowedGroups.includes('*')
      ) {
        const userGroups = req.user?.groups || [];
        const hasGroup = userGroups.some(g => allowedGroups.includes(g));
        if (!hasGroup) {
          return sendInsufficientPermissions(res);
        }
      }
      const langFilePath = pageConfig.filePath[lang] || pageConfig.filePath['en'];
      if (!langFilePath) {
        return sendErrorResponse(res, 404, 'Page content not available for the requested language');
      }
      const content = await loadText(langFilePath);
      if (!content) {
        return sendNotFound(res, 'Page content file');
      }

      // Determine content type from configuration or file extension
      let contentType = pageConfig.contentType;
      if (!contentType) {
        // Auto-detect from file extension
        if (langFilePath.endsWith('.jsx') || langFilePath.endsWith('.js')) {
          contentType = 'react';
        } else {
          contentType = 'markdown';
        }
      }

      res.json({
        id: pageId,
        title: pageConfig.title[lang] || pageConfig.title['en'],
        content,
        contentType
      });
    } catch (error) {
      return sendInternalError(res, error, 'fetch page content');
    }
  });
}
