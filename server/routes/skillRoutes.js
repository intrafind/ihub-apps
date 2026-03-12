import { authRequired } from '../middleware/authRequired.js';
import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { getSkillContent, getSkillResource } from '../services/skillLoader.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { requireFeature } from '../featureRegistry.js';
import { sendInternalError, sendNotFound, sendBadRequest } from '../utils/responseHelpers.js';

export default function registerSkillRoutes(app) {
  /**
   * GET /api/skills - List available skills filtered by user permissions
   */
  app.get(
    buildServerPath('/api/skills'),
    authRequired,
    requireFeature('skills'),
    async (req, res) => {
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
        const safeSkills = skills.map(({ name, displayName, description, metadata }) => ({
          name,
          displayName,
          description,
          metadata
        }));

        res.json(safeSkills);
      } catch (error) {
        return sendInternalError(res, error, 'fetch skills');
      }
    }
  );

  /**
   * GET /api/skills/:name - Get skill metadata
   */
  app.get(
    buildServerPath('/api/skills/:name'),
    authRequired,
    requireFeature('skills'),
    async (req, res) => {
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
          return sendNotFound(res, 'Skill');
        }

        const { name, displayName, description, license, compatibility, metadata } = skill;
        res.json({ name, displayName, description, license, compatibility, metadata });
      } catch (error) {
        return sendInternalError(res, error, 'fetch skill');
      }
    }
  );

  /**
   * GET /api/skills/:name/content - Get full SKILL.md body
   */
  app.get(
    buildServerPath('/api/skills/:name/content'),
    authRequired,
    requireFeature('skills'),
    async (req, res) => {
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
          return sendNotFound(res, 'Skill');
        }

        const content = await getSkillContent(req.params.name);
        if (!content) {
          return sendNotFound(res, 'Skill content');
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
        return sendInternalError(res, error, 'fetch skill content');
      }
    }
  );

  /**
   * GET /api/skills/:name/files/* - Read a skill resource file
   */
  app.get(
    buildServerPath('/api/skills/:name/files/*'),
    authRequired,
    requireFeature('skills'),
    async (req, res) => {
      try {
        if (!validateIdForPath(req.params.name, 'skill', res)) return;

        const filePath = req.params[0];
        if (!filePath) {
          return sendBadRequest(res, 'File path is required');
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
          return sendNotFound(res, 'Skill');
        }

        const content = await getSkillResource(req.params.name, filePath);
        if (content === null) {
          return sendNotFound(res, 'Resource');
        }

        res.type('text/plain').send(content);
      } catch (error) {
        return sendInternalError(res, error, 'fetch skill resource');
      }
    }
  );
}
