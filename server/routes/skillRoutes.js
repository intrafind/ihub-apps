// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { authRequired } from '../middleware/authRequired.js';
import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import { getSkillContent, getSkillResource } from '../services/skillLoader.js';
import { assertValidId } from '../utils/pathSecurity.js';
import { requireFeature } from '../featureRegistry.js';
import { getUsablePersonalSkills } from '../services/skillAccess.js';

/**
 * Give the request's user its permissions, as the skill lookups need them.
 *
 * @param {import('express').Request} req - Express request; `req.user` is set when missing
 * @param {Object} [options]
 * @param {boolean} [options.anonymous=false] - Also resolve an anonymous caller when anonymous access is on
 * @returns {Object} The platform configuration
 */
function resolveCaller(req, { anonymous = false } = {}) {
  const platformConfig = configCache.getPlatform() || {};
  const authConfig = platformConfig.auth || {};

  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
  }

  if (anonymous && !req.user && isAnonymousAccessAllowed(platformConfig)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
  }
  return platformConfig;
}

/**
 * Find a skill the caller may use.
 *
 * @param {import('express').Request} req - Express request
 * @param {string} name - Skill name from the path
 * @returns {Promise<Object>} The skill's metadata
 * @throws {ServiceError} `NOT_FOUND` when no such skill is available to the caller
 */
async function requireUsableSkill(req, name) {
  const platformConfig = resolveCaller(req);
  const { data: skills } = await configCache.getSkillsForUser(req.user, platformConfig);
  const skill = skills.find(s => s.name === name);
  if (!skill) throw new ServiceError('NOT_FOUND', 'Skill not found');
  return skill;
}

export default function registerSkillRoutes(app) {
  /**
   * GET /api/skills - List available skills filtered by user permissions
   */
  app.get(
    buildServerPath('/api/skills'),
    authRequired,
    requireFeature('skills'),
    async (req, res) => {
      const platformConfig = resolveCaller(req, { anonymous: true });

      const { data: skills, etag } = await configCache.getSkillsForUser(req.user, platformConfig);

      // Return only safe metadata (no paths). Global skills go by name.
      const safeSkills = skills.map(({ name, displayName, description, metadata, isSystem }) => ({
        id: name,
        name,
        displayName,
        description,
        metadata,
        scope: 'global',
        isSystem: isSystem === true
      }));

      // The caller's own and shared user skills, for the `/` picker. They
      // change with every save, so the list is not cached when it has any.
      const personal = await getUsablePersonalSkills({ user: req.user });
      if (personal.length > 0) {
        res.setHeader('Cache-Control', 'private, no-store');
        for (const skill of personal) {
          safeSkills.push({
            id: skill.id,
            name: skill.name,
            displayName: skill.name,
            description: skill.description || '',
            scope: String(skill.ownerId) === String(req.user.id) ? 'mine' : 'shared',
            owner: { name: skill.ownerName || '' }
          });
        }
      } else if (etag) {
        res.setHeader('ETag', etag);
      }

      res.json(safeSkills);
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
      assertValidId(req.params.name, 'skill');

      const skill = await requireUsableSkill(req, req.params.name);

      const { name, displayName, description, license, compatibility, metadata } = skill;
      res.json({ name, displayName, description, license, compatibility, metadata });
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
      assertValidId(req.params.name, 'skill');

      // Verify user has access to this skill
      await requireUsableSkill(req, req.params.name);

      const content = await getSkillContent(req.params.name);
      if (!content) {
        throw new ServiceError('NOT_FOUND', 'Skill content not found');
      }

      res.json({
        name: req.params.name,
        body: content.body,
        frontmatter: content.frontmatter,
        references: content.references,
        scripts: content.scripts,
        assets: content.assets
      });
    }
  );

  /**
   * GET /api/skills/:name/files/* - Read a skill resource file
   */
  app.get(
    buildServerPath('/api/skills/:name/files/*filePath'),
    authRequired,
    requireFeature('skills'),
    async (req, res) => {
      assertValidId(req.params.name, 'skill');

      // Express 5 named wildcards arrive as an array of path segments
      const filePath = Array.isArray(req.params.filePath)
        ? req.params.filePath.join('/')
        : req.params.filePath;
      if (!filePath) {
        throw new ServiceError('BAD_REQUEST', 'File path is required');
      }

      // Verify user has access to this skill
      await requireUsableSkill(req, req.params.name);

      const content = await getSkillResource(req.params.name, filePath);
      if (content === null) {
        throw new ServiceError('NOT_FOUND', 'Resource not found');
      }

      res.type('text/plain').send(content);
    }
  );
}
