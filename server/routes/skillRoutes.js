import { authRequired } from '../middleware/authRequired.js';
import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { getSkillContent, getSkillResource } from '../services/skillLoader.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import logger from '../utils/logger.js';

export default function registerSkillRoutes(app) {
  /**
   * GET /api/skills - List available skills filtered by user permissions
   */
  app.get(buildServerPath('/api/skills'), authRequired, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      if (req.user && !req.user.permissions) {
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
      }

      const { data: skills, etag } = await configCache.getSkillsForUser(req.user, platformConfig);

      if (etag) {
        res.setHeader('ETag', etag);
      }

      // Return only safe metadata (no paths)
      const safeSkills = skills.map(({ name, displayName, description, metadata, enabled }) => ({
        name,
        displayName,
        description,
        metadata,
        enabled
      }));

      res.json(safeSkills);
    } catch (error) {
      logger.error('Error fetching skills:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/skills/:name - Get skill metadata
   */
  app.get(buildServerPath('/api/skills/:name'), authRequired, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      if (req.user && !req.user.permissions) {
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      const { data: skills } = await configCache.getSkillsForUser(req.user, platformConfig);
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const { name, displayName, description, license, compatibility, metadata, enabled } = skill;
      res.json({ name, displayName, description, license, compatibility, metadata, enabled });
    } catch (error) {
      logger.error('Error fetching skill:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/skills/:name/content - Get full SKILL.md body
   */
  app.get(buildServerPath('/api/skills/:name/content'), authRequired, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      if (req.user && !req.user.permissions) {
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Verify user has access to this skill
      const { data: skills } = await configCache.getSkillsForUser(req.user, platformConfig);
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = await getSkillContent(req.params.name);
      if (!content) {
        return res.status(404).json({ error: 'Skill content not found' });
      }

      res.json({
        name: req.params.name,
        body: content.body,
        frontmatter: content.frontmatter,
        references: content.references,
        scripts: content.scripts,
        assets: content.assets
      });
    } catch (error) {
      logger.error('Error fetching skill content:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/skills/:name/files/* - Read a skill resource file
   */
  app.get(buildServerPath('/api/skills/:name/files/*'), authRequired, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const filePath = req.params[0];
      if (!filePath) {
        return res.status(400).json({ error: 'File path is required' });
      }

      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      if (req.user && !req.user.permissions) {
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Verify user has access to this skill
      const { data: skills } = await configCache.getSkillsForUser(req.user, platformConfig);
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = await getSkillResource(req.params.name, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      res.type('text/plain').send(content);
    } catch (error) {
      logger.error('Error fetching skill resource:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
