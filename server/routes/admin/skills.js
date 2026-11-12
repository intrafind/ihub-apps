// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import { ZipArchive } from 'archiver';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { responseEtag } from '../../utils/etag.js';
import { assertValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { requireFeature } from '../../featureRegistry.js';
import configCache from '../../configCache.js';
import registryService from '../../services/marketplace/RegistryService.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import {
  getSkillContent,
  getSkillResource,
  getSkillsDirectory,
  getSkillPath,
  getSystemSkillsDirectory,
  isSystemSkill,
  listSkillFiles,
  validateSkillDirectory,
  validateSkillName
} from '../../services/skillLoader.js';
import logger from '../../utils/logger.js';
import { ServiceError } from '../../utils/ServiceError.js';
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
import { sendCreated, segment } from '../../utils/created.js';
import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  updateSkillOverride
} from '../../services/skills/skillOverrides.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

/** `PUT /api/admin/skills/:name`: the settings an administrator may change. */
const skillSettingsBodySchema = z
  .object({
    configOverrides: z
      .object({ description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).optional() })
      .strict()
  })
  .strict();

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
    const normalised = path.normalize(relativePath).replaceAll('\\', '/');
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
 * The installed skill an admin may change: it must exist and not be a system
 * skill (those ship with iHub and are always on).
 *
 * @param {string} name - From the path
 * @returns {object} The skill as the cache holds it
 */
function findChangeableSkill(name) {
  assertValidId(name, 'skill');
  const skill = (configCache.getSkills().data || []).find(entry => entry.name === name);
  if (!skill) throw new ServiceError('NOT_FOUND', 'Skill not found');
  if (skill.isSystem) {
    throw new ServiceError('FORBIDDEN', `'${name}' is a system skill and cannot be changed`);
  }
  return skill;
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
      const { data: skills, etag: skillsEtag } = configCache.getSkills();
      const etag = responseEtag(skillsEtag);

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
      assertValidId(req.params.name, 'skill');

      const { data: skills } = configCache.getSkills();
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        throw new ServiceError('NOT_FOUND', 'Skill not found');
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
    }
  );

  /**
   * @swagger
   * /api/admin/skills/{name}:
   *   put:
   *     summary: Change the settings of an installed skill
   *     description: |
   *       Sets the description shown for the skill (`configOverrides.description`;
   *       an empty string removes the override). The skill's own files are not
   *       touched. System skills cannot be changed. Answers the skill.
   *     tags:
   *       - Admin - Skills
   *     parameters:
   *       - name: name
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [configOverrides]
   *             properties:
   *               configOverrides:
   *                 type: object
   *                 properties:
   *                   description:
   *                     type: string
   *     responses:
   *       200:
   *         description: The skill with its settings applied
   *       400:
   *         description: Invalid body
   *       403:
   *         description: System skills cannot be changed
   *       404:
   *         description: Skill not found
   */
  app.put(
    buildServerPath('/api/admin/skills/:name'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      const skill = findChangeableSkill(req.params.name);
      const body = skillSettingsBodySchema.parse(req.body ?? {});

      await updateSkillOverride(skill.name, {
        description: body.configOverrides.description ?? ''
      });
      await configCache.refreshSkillsCache();

      await logAudit({
        req,
        action: 'update',
        resource: 'skill',
        resourceId: skill.name,
        summary: `Changed the settings of skill "${skill.name}"`
      });
      res.json(findChangeableSkill(skill.name));
    }
  );

  /**
   * @swagger
   * /api/admin/skills/{name}/_toggle:
   *   post:
   *     summary: Switch an installed skill on or off
   *     description: |
   *       A skill that is off is offered to no app, user or MCP client; its files stay
   *       installed. System skills cannot be switched off. Answers the skill.
   *     tags:
   *       - Admin - Skills
   *     parameters:
   *       - name: name
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The skill with its new `enabled` state
   *       403:
   *         description: System skills cannot be switched off
   *       404:
   *         description: Skill not found
   */
  app.post(
    buildServerPath('/api/admin/skills/:name/_toggle'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      const skill = findChangeableSkill(req.params.name);
      const enabled = skill.enabled === false;

      await updateSkillOverride(skill.name, { enabled });
      await configCache.refreshSkillsCache();

      await logAudit({
        req,
        action: 'update',
        resource: 'skill',
        resourceId: skill.name,
        summary: `${enabled ? 'Enabled' : 'Disabled'} skill "${skill.name}"`
      });
      res.json(findChangeableSkill(skill.name));
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
      assertValidId(req.params.name, 'skill');

      // System skills ship with iHub; they are not an installation's to remove.
      if (isSystemSkill(req.params.name)) {
        throw new ServiceError(
          'FORBIDDEN',
          `'${req.params.name}' is a system skill and cannot be deleted`
        );
      }

      const skillsDir = getSkillsDirectory();
      const skillPathResolved = await resolveAndValidatePath(req.params.name, skillsDir);
      if (!skillPathResolved) {
        logger.warn('Path traversal attempt blocked when deleting skill', {
          component: 'AdminSkills',
          name: req.params.name
        });
        throw new ServiceError('BAD_REQUEST', 'Invalid skill path');
      }

      if (!existsSync(skillPathResolved)) {
        throw new ServiceError('NOT_FOUND', 'Skill directory not found');
      }

      await fs.rm(skillPathResolved, { recursive: true, force: true });
      await configCache.refreshSkillsCache();

      await removeMarketplaceInstallation('skill', req.params.name);

      res.status(204).end();
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
      const skillName = req.params.name;
      assertValidId(skillName, 'skill');

      const skillsRoot = isSystemSkill(skillName)
        ? getSystemSkillsDirectory()
        : getSkillsDirectory();
      const resolvedSkillPath = await resolveAndValidatePath(skillName, skillsRoot);
      if (!resolvedSkillPath || path.basename(resolvedSkillPath) !== skillName) {
        logger.warn('Skill export blocked for invalid path', {
          component: 'AdminSkills',
          skillName
        });
        throw new ServiceError('BAD_REQUEST', 'Invalid skill path');
      }

      if (!existsSync(resolvedSkillPath)) {
        throw new ServiceError('NOT_FOUND', 'Skill not found');
      }

      const archive = new ZipArchive({ zlib: { level: 9 } });
      const fileName = `${skillName}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

      archive.pipe(res);
      archive.directory(resolvedSkillPath, skillName);
      await archive.finalize();
    }
  );

  /**
   * POST /api/admin/skills/_import - Import a skill from a zip file.
   *
   * Expects multipart/form-data with a 'skill' file field.
   * Uses JSZip for safe in-process extraction — no shell commands are invoked.
   * Each entry path is validated to prevent zip-slip attacks.
   * Maximum upload size: 10 MB.
   */
  app.post(
    buildServerPath('/api/admin/skills/_import'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      if (!req.files || !req.files.skill) {
        throw new ServiceError('BAD_REQUEST', 'No skill file uploaded');
      }

      const file = req.files.skill;

      // Enforce upload size limit before any extraction
      if (file.size > MAX_SKILL_ZIP_SIZE) {
        throw new ServiceError(
          'PAYLOAD_TOO_LARGE',
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
          throw new ServiceError(
            'BAD_REQUEST',
            'Zip must contain exactly one top-level skill directory'
          );
        }

        const skillDir = path.join(tempDir, dirs[0].name);
        const validation = await validateSkillDirectory(skillDir);

        if (!validation.valid) {
          throw new ServiceError('BAD_REQUEST', 'Invalid skill', {
            details: { errors: validation.errors }
          });
        }

        const skillName = dirs[0].name;
        const nameValidation = validateSkillName(skillName);
        if (!nameValidation.valid) {
          throw new ServiceError('BAD_REQUEST', nameValidation.error);
        }

        // A system skill's name is reserved, overwrite or not.
        if (isSystemSkill(skillName)) {
          throw new ServiceError(
            'SKILL_NAME_RESERVED',
            `'${skillName}' is the name of a system skill. Rename the skill directory to import it.`
          );
        }

        const targetPath = getSkillPath(skillName);

        if (existsSync(targetPath) && !req.body.overwrite) {
          throw new ServiceError(
            'CONFLICT',
            `Skill '${skillName}' already exists. Set overwrite=true to replace.`
          );
        }

        if (existsSync(targetPath)) {
          await fs.rm(targetPath, { recursive: true, force: true });
        }
        await fs.cp(skillDir, targetPath, { recursive: true });

        await configCache.refreshSkillsCache();

        res.json({ skillName, metadata: validation.metadata });
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
      assertValidId(req.params.name, 'skill');

      // Express 5 named wildcards arrive as an array of path segments
      const filePath = Array.isArray(req.params.filePath)
        ? req.params.filePath.join('/')
        : req.params.filePath;
      if (!filePath) {
        throw new ServiceError('BAD_REQUEST', 'File path is required');
      }

      const content = await getSkillResource(req.params.name, filePath);
      if (content === null) {
        throw new ServiceError('NOT_FOUND', 'Resource not found');
      }

      res.type('text/plain').send(content);
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
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await listSharedUserSkills(req));
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
    res.json({
      settings: userSkillSettings(configCache.getPlatform() || {}),
      storageAvailable: getUserSkillRepository().isAvailable()
    });
  });

  app.put(buildServerPath('/api/admin/user-skills/settings'), adminAuth, async (req, res) => {
    const settings = userSkillSettingsSchema.parse(req.body || {});
    const { sharing, ...rest } = settings;
    const { data: platformConfig } = await updatePlatform(platformConfig => {
      const stored = platformConfig.userSkills || {};
      platformConfig.userSkills = {
        ...stored,
        ...rest,
        sharing: { ...stored.sharing, ...sharing }
      };
    });
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
      assertValidId(skillId, 'skill');
      if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'User skill not found');
      const repo = getUserSkillRepository();
      if (!repo.isAvailable()) {
        throw new ServiceError('USER_SKILLS_UNAVAILABLE', 'User skills are unavailable');
      }
      const parsed = skillPromoteSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new ServiceError('BAD_REQUEST', `Invalid request: ${describeIssues(parsed.error)}`);
      }
      let created = false;
      let targetPath = null;
      try {
        const skill = await repo.get(skillId);
        if (!skill) throw new ServiceError('NOT_FOUND', 'User skill not found');
        const name = parsed.data.name || skill.name;
        const nameValidation = validateSkillName(name);
        if (!nameValidation.valid) throw new ServiceError('BAD_REQUEST', nameValidation.error);
        // A system skill's name is reserved.
        if (isSystemSkill(name)) {
          throw new ServiceError(
            'SKILL_NAME_RESERVED',
            `'${name}' is the name of a system skill. Promote the skill under another name.`
          );
        }

        targetPath = await resolveAndValidatePath(name, getSkillsDirectory());
        if (!targetPath) throw new ServiceError('BAD_REQUEST', 'Invalid skill name');
        const taken =
          existsSync(targetPath) ||
          (configCache.getSkills().data || []).some(entry => entry.name === name);
        if (taken) {
          throw new ServiceError(
            'SKILL_NAME_TAKEN',
            `A global skill named '${name}' already exists`
          );
        }

        // Claim the name with a non-recursive mkdir: of two promotions to the
        // same name, only one creates the folder; the other gets EEXIST and
        // leaves the winner's files alone.
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        try {
          await fs.mkdir(targetPath);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          throw new ServiceError(
            'SKILL_NAME_TAKEN',
            `A global skill named '${name}' already exists`
          );
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
          throw new ServiceError('BAD_REQUEST', 'This skill cannot become a global skill', {
            details: { errors: validation.errors }
          });
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
        sendCreated(res, `/api/admin/skills/${segment(name)}`, { name, promotedTo });
      } catch (error) {
        if (created && targetPath) {
          await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      }
    }
  );
}
