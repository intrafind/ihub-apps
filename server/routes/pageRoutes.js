import { loadText } from '../configLoader.js';
import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

export default function registerPageRoutes(app, basePath = '') {
  app.get(buildServerPath('/api/pages/:pageId'), async (req, res) => {
    const { pageId } = req.params;
    const lang = req.query.lang || 'en';
    try {
      // Try to get UI config from cache first
      let { data: uiConfig } = configCache.getUI();

      if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
        return res.status(404).json({ error: 'Page not found' });
      }
      const pageConfig = uiConfig.pages[pageId];

      const { authRequired = false, allowedGroups } = pageConfig;

      // Require authentication if configured
      if (authRequired && (!req.user || req.user.id === 'anonymous')) {
        return res.status(401).json({ error: 'Authentication required' });
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
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }
      const langFilePath = pageConfig.filePath[lang] || pageConfig.filePath['en'];
      if (!langFilePath) {
        return res
          .status(404)
          .json({ error: 'Page content not available for the requested language' });
      }
      const content = await loadText(langFilePath);
      if (!content) {
        return res.status(404).json({ error: 'Page content file not found' });
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
      logger.error('Error fetching page content:', error);
      res.status(500).json({ error: 'Failed to fetch page content' });
    }
  });
}
