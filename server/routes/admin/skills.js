import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { ZipArchive } from 'archiver';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { requireFeature } from '../../featureRegistry.js';
import configCache from '../../configCache.js';
import registryService from '../../services/marketplace/RegistryService.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import {
  getSkillContent,
  getSkillResource,
  getSkillsDirectory,
  getSkillPath,
  listSkillFiles,
  validateSkillDirectory,
  validateSkillName
} from '../../services/skillLoader.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import configStore from '../../services/config/ConfigStore.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { logAudit } from '../../services/AuditLogService.js';
import { loadUsers } from '../../utils/userManager.js';
import { localUsersFile } from '../../utils/contentsPath.js';
import { userPromptPermissions } from '../../services/prompts/userPromptAccess.js';
import {
  getUserSkillRepository,
  isUserSkillId
} from '../../services/skills/UserSkillRepository.js';
import { userSkillSettings } from '../../services/skills/userSkillSettings.js';
import { serializeUserSkill } from '../../services/skills/userSkillView.js';
import {
  describeIssues,
  skillPromoteSchema,
  userSkillSettingsSchema
} from '../../validators/userSkillSchema.js';

const MAX_SKILL_ZIP_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Safely extract a zip file to a target directory using JSZip.
 * Validates every entry path to prevent zip-slip (path traversal) attacks.
 * @param {Buffer} zipBuffer - Raw zip file contents
 * @param {string} targetDir - Directory to extract into
 * @returns {Promise<void>}
 */
async function safeExtractZip(zipBuffer, targetDir) {
  const zip = await JSZip.loadAsync(zipBuffer);

  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    const normalised = path.normalize(relativePath).replace(/\\/g, '/');
    const destPath = await resolveAndValidatePath(normalised, targetDir);
    if (!destPath) {
      throw new Error(`Zip path escapes target directory: ${relativePath}`);
    }

    if (zipEntry.dir) {
      await fs.mkdir(destPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const content = await zipEntry.async('nodebuffer');
      await fs.writeFile(destPath, content);
    }
  }
}

/** Display name the admin API stamps on what an admin does. */
function adminName(req) {
  return String(req.user?.name ?? req.user?.username ?? req.user?.id ?? 'unknown');
}

/**
 * The user skills shared with a group or with everyone — what the admin page
 * lists. Private skills and skills shared only with named users stay out of
 * it, as for user prompts.
 *
 * @param {Object} req - Express request.
 * @returns {Promise<{skills: Object[], truncated: boolean, available: boolean}>}
 */
async function listSharedUserSkills(req) {
  const repo = getUserSkillRepository();
  if (!repo.isAvailable()) return { skills: [], truncated: false, available: false };
  const { skills, truncated } = await repo.scan({
    filter: skill =>
      (skill.shares || []).some(share => share.type === 'group' || share.type === 'everyone')
  });
  const platform = configCache.getPlatform() || {};
  const users = loadUsers(localUsersFile(platform.localAuth)).users || {};
  const items = skills.map(skill => {
    const owner = Object.hasOwn(users, skill.ownerId) ? users[skill.ownerId] : null;
    const ownerActive = Boolean(owner) && owner.active !== false;
    return serializeUserSkill(
      skill,
      userPromptPermissions(skill, req.user, { isAdmin: true, ownerActive }),
      { ownerActive, adminView: true }
    );
  });
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { skills: items, truncated, available: true };
}

/**
 * The SKILL.md of a promoted user skill. Name and description go out as JSON
 * strings, which YAML reads as double-quoted scalars, so no description can
 * break the frontmatter.
 *
 * @param {Object} skill - Stored user skill.
 * @param {string} name - Name of the global skill.
 * @returns {string}
 */
export function skillMarkdownFromUserSkill(skill, name) {
  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(String(skill.description || ''))}`,
    'metadata:',
    `  author: ${JSON.stringify(String(skill.ownerName || skill.ownerId || ''))}`,
    `  sourceSkillId: ${JSON.stringify(String(skill.id))}`,
    '---',
    '',
    String(skill.body || '').trim(),
    ''
  ].join('\n');
}

export default function registerAdminSkillsRoutes(app) {
  /**
   * GET /api/admin/skills - List all skills
   */
  app.get(
    buildServerPath('/api/admin/skills'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        const { data: skills, etag } = configCache.getSkills();

        if (etag) {
          const clientEtag = req.headers['if-none-match'];
          if (clientEtag && clientEtag === etag) {
            return res.status(304).end();
          }
          res.setHeader('ETag', etag);
        }

        const platformConfig = configCache.getPlatform();
        const settings = platformConfig?.skills || {};

        res.json({ skills, settings });
      } catch (error) {
        return sendInternalError(res, error, 'fetch admin skills');
      }
    }
  );

  /**
   * GET /api/admin/skills/:name - Get specific skill details
   */
  app.get(
    buildServerPath('/api/admin/skills/:name'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        if (!validateIdForPath(req.params.name, 'skill', res)) return;

        const { data: skills } = configCache.getSkills();
        const skill = skills.find(s => s.name === req.params.name);

        if (!skill) {
          return sendNotFound(res, 'Skill');
        }

        const content = await getSkillContent(req.params.name);
        const files = await listSkillFiles(skill.path);

        // Look up marketplace source URL from installation manifest for relative link rewriting
        const { data: installationsData } = configCache.getInstallations();
        const installations = installationsData?.installations || {};
        const installation = installations[`skill:${req.params.name}`];
        const sourceUrl = installation?.sourceUrl || null;

        const body = registryService.rewriteSkillLinks(content?.body || '', sourceUrl);

        res.json({
          ...skill,
          body,
          frontmatter: content?.frontmatter || {},
          references: content?.references || [],
          scripts: content?.scripts || [],
          assets: content?.assets || [],
          files
        });
      } catch (error) {
        return sendInternalError(res, error, 'fetch admin skill detail');
      }
    }
  );

  /**
   * DELETE /api/admin/skills/:name - Remove skill directory
   */
  app.delete(
    buildServerPath('/api/admin/skills/:name'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        if (!validateIdForPath(req.params.name, 'skill', res)) return;

        const skillsDir = getSkillsDirectory();
        const skillPathResolved = await resolveAndValidatePath(req.params.name, skillsDir);
        if (!skillPathResolved) {
          logger.warn('Path traversal attempt blocked when deleting skill', {
            component: 'AdminSkills',
            name: req.params.name
          });
          return sendBadRequest(res, 'Invalid skill path');
        }

        if (!existsSync(skillPathResolved)) {
          return sendNotFound(res, 'Skill directory');
        }

        await fs.rm(skillPathResolved, { recursive: true, force: true });
        await configCache.refreshSkillsCache();

        await removeMarketplaceInstallation('skill', req.params.name);

        res.json({ success: true });
      } catch (error) {
        return sendInternalError(res, error, 'delete skill');
      }
    }
  );

  /**
   * POST /api/admin/skills/validate - Validate a skill directory
   */
  app.post(
    buildServerPath('/api/admin/skills/validate'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        const { skillName } = req.body;
        if (!skillName) {
          return sendBadRequest(res, 'skillName is required');
        }

        const nameValidation = validateSkillName(skillName);
        if (!nameValidation.valid) {
          return res.json({ valid: false, errors: [nameValidation.error] });
        }

        const skillsRoot = getSkillsDirectory();
        const resolvedSkillPath = await resolveAndValidatePath(skillName, skillsRoot);
        if (!resolvedSkillPath || path.basename(resolvedSkillPath) !== skillName) {
          logger.warn('Skill directory validation blocked for invalid path', {
            component: 'AdminSkills',
            skillName
          });
          return sendBadRequest(res, 'Invalid skill path');
        }

        const validation = await validateSkillDirectory(resolvedSkillPath);
        res.json(validation);
      } catch (error) {
        return sendInternalError(res, error, 'validate skill');
      }
    }
  );

  /**
   * GET /api/admin/skills/:name/export - Export single skill as zip
   */
  app.get(
    buildServerPath('/api/admin/skills/:name/export'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        const skillName = req.params.name;
        if (!validateIdForPath(skillName, 'skill', res)) return;

        const skillsRoot = getSkillsDirectory();
        const resolvedSkillPath = await resolveAndValidatePath(skillName, skillsRoot);
        if (!resolvedSkillPath || path.basename(resolvedSkillPath) !== skillName) {
          logger.warn('Skill export blocked for invalid path', {
            component: 'AdminSkills',
            skillName
          });
          return sendBadRequest(res, 'Invalid skill path');
        }

        if (!existsSync(resolvedSkillPath)) {
          return sendNotFound(res, 'Skill');
        }

        const archive = new ZipArchive({ zlib: { level: 9 } });
        const fileName = `${skillName}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        archive.pipe(res);
        archive.directory(resolvedSkillPath, skillName);
        await archive.finalize();
      } catch (error) {
        return sendInternalError(res, error, 'export skill');
      }
    }
  );

  /**
   * POST /api/admin/skills/import - Import a skill from a zip file.
   *
   * Expects multipart/form-data with a 'skill' file field.
   * Uses JSZip for safe in-process extraction — no shell commands are invoked.
   * Each entry path is validated to prevent zip-slip attacks.
   * Maximum upload size: 10 MB.
   */
  app.post(
    buildServerPath('/api/admin/skills/import'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      if (!req.files || !req.files.skill) {
        return sendBadRequest(res, 'No skill file uploaded');
      }

      const file = req.files.skill;

      // Enforce upload size limit before any extraction
      if (file.size > MAX_SKILL_ZIP_SIZE) {
        return sendErrorResponse(
          res,
          413,
          `Skill zip must not exceed ${MAX_SKILL_ZIP_SIZE / 1024 / 1024} MB`
        );
      }

      const skillsDir = getSkillsDirectory();
      const tempDir = path.join(skillsDir, '..', '.skill-import-tmp-' + Date.now());

      try {
        await fs.mkdir(tempDir, { recursive: true });

        // Extract zip safely — no shell, no exec, path-traversal-safe
        await safeExtractZip(file.data, tempDir);

        // The zip must contain exactly one top-level directory (no symlinks)
        const entries = await fs.readdir(tempDir, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory() && !e.isSymbolicLink());

        if (dirs.length !== 1) {
          return sendBadRequest(res, 'Zip must contain exactly one top-level skill directory');
        }

        const skillDir = path.join(tempDir, dirs[0].name);
        const validation = await validateSkillDirectory(skillDir);

        if (!validation.valid) {
          return sendBadRequest(res, 'Invalid skill', validation.errors);
        }

        const skillName = dirs[0].name;
        const nameValidation = validateSkillName(skillName);
        if (!nameValidation.valid) {
          return sendBadRequest(res, nameValidation.error);
        }

        const targetPath = getSkillPath(skillName);

        if (existsSync(targetPath) && !req.body.overwrite) {
          return sendErrorResponse(
            res,
            409,
            `Skill '${skillName}' already exists. Set overwrite=true to replace.`
          );
        }

        if (existsSync(targetPath)) {
          await fs.rm(targetPath, { recursive: true, force: true });
        }
        await fs.cp(skillDir, targetPath, { recursive: true });

        await configCache.refreshSkillsCache();

        res.json({ success: true, skillName, metadata: validation.metadata });
      } catch (error) {
        sendInternalError(res, error, 'import skill');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  /**
   * GET /api/admin/skills/:name/files/* - Read a skill resource file (admin view)
   */
  app.get(
    buildServerPath('/api/admin/skills/:name/files/*filePath'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        if (!validateIdForPath(req.params.name, 'skill', res)) return;

        // Express 5 named wildcards arrive as an array of path segments
        const filePath = Array.isArray(req.params.filePath)
          ? req.params.filePath.join('/')
          : req.params.filePath;
        if (!filePath) {
          return sendBadRequest(res, 'File path is required');
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

  /**
   * @swagger
   * /api/admin/user-skills:
   *   get:
   *     summary: User skills shared with a group or with everyone
   *     tags:
   *       - Admin - Skills
   */
  app.get(
    buildServerPath('/api/admin/user-skills'),
    contentAdminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await listSharedUserSkills(req));
      } catch (error) {
        sendInternalError(res, error, 'list user skills');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/user-skills/settings:
   *   get:
   *     summary: The settings for user skills
   *     tags:
   *       - Admin - Skills
   *   put:
   *     summary: Update the settings for user skills (any subset)
   *     tags:
   *       - Admin - Skills
   */
  app.get(buildServerPath('/api/admin/user-skills/settings'), adminAuth, async (req, res) => {
    try {
      res.json({
        settings: userSkillSettings(configCache.getPlatform() || {}),
        storageAvailable: getUserSkillRepository().isAvailable()
      });
    } catch (error) {
      sendInternalError(res, error, 'read user skill settings');
    }
  });

  app.put(buildServerPath('/api/admin/user-skills/settings'), adminAuth, async (req, res) => {
    const parsed = userSkillSettingsSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendBadRequest(res, `Invalid user skill settings: ${describeIssues(parsed.error)}`);
    }
    try {
      const platformConfig = await configStore.readJson('config/platform.json');
      if (!platformConfig) throw new Error('Unable to read config/platform.json');
      const { sharing, ...rest } = parsed.data;
      const stored = platformConfig.userSkills || {};
      platformConfig.userSkills = {
        ...stored,
        ...rest,
        sharing: { ...(stored.sharing || {}), ...(sharing || {}) }
      };
      await configStore.writeJson('config/platform.json', platformConfig);
      await configCache.refreshCacheEntry('config/platform.json');
      await logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'user-skills',
        summary: `Updated user skill settings (${[
          ...Object.keys(rest),
          ...Object.keys(sharing || {}).map(key => `sharing.${key}`)
        ].join(', ')})`
      });
      res.json({
        settings: userSkillSettings(configCache.getPlatform() || platformConfig),
        storageAvailable: getUserSkillRepository().isAvailable()
      });
    } catch (error) {
      sendInternalError(res, error, 'update user skill settings');
    }
  });

  /**
   * @swagger
   * /api/admin/user-skills/{skillId}/promote:
   *   post:
   *     summary: Promote a user skill to a global skill
   *     description: |
   *       Writes `contents/skills/<name>/` from the user skill's instructions
   *       and files. The user skill stays as it is and records where it was
   *       promoted to. Who can use the new global skill follows the groups'
   *       `skills` permission and the apps it is assigned to.
   *     tags:
   *       - Admin - Skills
   *     responses:
   *       201:
   *         description: The global skill was written
   *       409:
   *         description: A global skill with this name already exists
   */
  app.post(
    buildServerPath('/api/admin/user-skills/:skillId/promote'),
    contentAdminAuth,
    requireFeature('skills'),
    async (req, res) => {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) return sendNotFound(res, 'User skill');
      const repo = getUserSkillRepository();
      if (!repo.isAvailable()) {
        return sendErrorResponse(res, 503, 'User skills are unavailable', {
          details: { code: 'USER_SKILLS_UNAVAILABLE' }
        });
      }
      const parsed = skillPromoteSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
      }
      let created = false;
      let targetPath = null;
      try {
        const skill = await repo.get(skillId);
        if (!skill) return sendNotFound(res, 'User skill');
        const name = parsed.data.name || skill.name;
        const nameValidation = validateSkillName(name);
        if (!nameValidation.valid) return sendBadRequest(res, nameValidation.error);

        targetPath = await resolveAndValidatePath(name, getSkillsDirectory());
        if (!targetPath) return sendBadRequest(res, 'Invalid skill name');
        const taken =
          existsSync(targetPath) ||
          (configCache.getSkills().data || []).some(entry => entry.name === name);
        if (taken) {
          return sendErrorResponse(res, 409, `A global skill named '${name}' already exists`, {
            details: { code: 'SKILL_NAME_TAKEN' }
          });
        }

        // Claim the name with a non-recursive mkdir: of two promotions to the
        // same name, only one creates the folder; the other gets EEXIST and
        // leaves the winner's files alone.
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        try {
          await fs.mkdir(targetPath);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          return sendErrorResponse(res, 409, `A global skill named '${name}' already exists`, {
            details: { code: 'SKILL_NAME_TAKEN' }
          });
        }
        created = true;
        const files = [
          { path: 'SKILL.md', content: skillMarkdownFromUserSkill(skill, name) },
          ...(skill.files || [])
        ];
        for (const file of files) {
          const destPath = await resolveAndValidatePath(file.path, targetPath);
          if (!destPath) throw new Error(`Skill file path escapes the skill folder: ${file.path}`);
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.writeFile(destPath, String(file.content), 'utf8');
        }
        const validation = await validateSkillDirectory(targetPath);
        if (!validation.valid) {
          await fs.rm(targetPath, { recursive: true, force: true });
          created = false;
          return sendBadRequest(res, 'This skill cannot become a global skill', validation.errors);
        }

        await configCache.refreshSkillsCache();
        const promotedTo = {
          skillName: name,
          at: new Date().toISOString(),
          by: { id: String(req.user?.id ?? ''), name: adminName(req) }
        };
        await repo.markPromoted(skillId, promotedTo);
        await logAudit({
          req,
          action: 'create',
          resource: 'skill',
          resourceId: name,
          summary: `Promoted user skill "${skill.name}" by ${
            skill.ownerName || skill.ownerId
          } to global skill ${name}`
        });
        res.status(201).json({ name, promotedTo });
      } catch (error) {
        if (created && targetPath) {
          await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
        }
        sendInternalError(res, error, 'promote skill');
      }
    }
  );
}
