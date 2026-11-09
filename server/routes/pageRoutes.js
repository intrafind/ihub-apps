// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { loadText } from '../configLoader.js';
import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import { assertValidId, sanitizeLanguageCode } from '../utils/pathSecurity.js';

export default function registerPageRoutes(app) {
  app.get(buildServerPath('/api/pages/:pageId'), async (req, res) => {
    const { pageId } = req.params;

    // Validate pageId to prevent path traversal
    assertValidId(pageId, 'page');

    const lang = sanitizeLanguageCode(req.query.lang);
    // Try to get UI config from cache first
    let { data: uiConfig } = configCache.getUI();

    if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
      throw new ServiceError('NOT_FOUND', 'Page not found');
    }
    const pageConfig = uiConfig.pages[pageId];

    const { authRequired = false, allowedGroups } = pageConfig;

    // Require authentication if configured
    if (authRequired && (!req.user || req.user.id === 'anonymous')) {
      throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
    }

    // Check allowed groups if specified
    if (Array.isArray(allowedGroups) && allowedGroups.length > 0 && !allowedGroups.includes('*')) {
      const userGroups = req.user?.groups || [];
      const hasGroup = userGroups.some(g => allowedGroups.includes(g));
      if (!hasGroup) {
        throw new ServiceError('FORBIDDEN', 'Insufficient permissions');
      }
    }
    const langFilePath = pageConfig.filePath[lang] || pageConfig.filePath['en'];
    if (!langFilePath) {
      throw new ServiceError('NOT_FOUND', 'Page content not available for the requested language');
    }
    const content = await loadText(langFilePath);
    if (!content) {
      throw new ServiceError('NOT_FOUND', 'Page content file not found');
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
  });
}
