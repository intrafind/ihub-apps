import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import archiver from 'archiver';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { requireFeature } from '../../featureRegistry.js';
import configCache from '../../configCache.js';
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
    // Normalise and reject traversal sequences
    const normalised = path.normalize(relativePath).replace(/\\/g, '/');
    if (normalised.startsWith('..') || path.isAbsolute(normalised)) {
      throw new Error(`Zip contains unsafe path: ${relativePath}`);
    }

    const destPath = path.join(targetDir, normalised);

    // Guard: resolved destination must stay inside targetDir
    const resolvedDest = path.resolve(destPath);
    const resolvedTarget = path.resolve(targetDir);
    if (!resolvedDest.startsWith(resolvedTarget + path.sep) && resolvedDest !== resolvedTarget) {
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
        logger.error('Error fetching admin skills:', error);
        res.status(500).json({ error: 'Internal server error' });
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
          return res.status(404).json({ error: 'Skill not found' });
        }

        const content = await getSkillContent(req.params.name);
        const files = await listSkillFiles(skill.path);

        res.json({
          ...skill,
          body: content?.body || '',
          frontmatter: content?.frontmatter || {},
          references: content?.references || [],
          scripts: content?.scripts || [],
          assets: content?.assets || [],
          files
        });
      } catch (error) {
        logger.error('Error fetching admin skill detail:', error);
        res.status(500).json({ error: 'Internal server error' });
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
        const skillsDirResolved = path.resolve(skillsDir);
        const skillPath = getSkillPath(req.params.name);
        const skillPathResolved = path.resolve(skillPath);

        // Ensure the resolved skill path is within the skills directory (path traversal protection)
        if (!skillPathResolved.startsWith(skillsDirResolved + path.sep)) {
          logger.warn(
            `Path traversal attempt blocked when deleting skill '${req.params.name}': ${skillPathResolved}`
          );
          return res.status(400).json({ error: 'Invalid skill path' });
        }

        if (!existsSync(skillPathResolved)) {
          return res.status(404).json({ error: 'Skill directory not found' });
        }

        await fs.rm(skillPathResolved, { recursive: true, force: true });
        await configCache.refreshSkillsCache();

        res.json({ success: true });
      } catch (error) {
        logger.error('Error deleting skill:', error);
        res.status(500).json({ error: 'Internal server error' });
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
          return res.status(400).json({ error: 'skillName is required' });
        }

        const nameValidation = validateSkillName(skillName);
        if (!nameValidation.valid) {
          return res.json({ valid: false, errors: [nameValidation.error] });
        }

        // Ensure the resolved skill path stays within the skills root directory
        const skillsRoot = getSkillsDirectory();
        const candidateSkillPath = getSkillPath(skillName);
        const resolvedSkillsRoot = path.resolve(skillsRoot);
        const resolvedSkillPath = path.resolve(candidateSkillPath);
        const normalizedRootWithSep = resolvedSkillsRoot.endsWith(path.sep)
          ? resolvedSkillsRoot
          : resolvedSkillsRoot + path.sep;

        if (
          !resolvedSkillPath.startsWith(normalizedRootWithSep) ||
          path.basename(resolvedSkillPath) !== skillName
        ) {
          logger.warn(
            `Skill directory validation blocked for invalid path derived from name '${skillName}'`
          );
          return res.status(400).json({ error: 'Invalid skill path' });
        }

        const validation = await validateSkillDirectory(resolvedSkillPath);
        res.json(validation);
      } catch (error) {
        logger.error('Error validating skill:', error);
        res.status(500).json({ error: 'Internal server error' });
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

        // Ensure the resolved skill path stays within the skills root directory
        const skillsRoot = getSkillsDirectory();
        const candidateSkillPath = getSkillPath(skillName);
        const resolvedSkillsRoot = path.resolve(skillsRoot);
        const resolvedSkillPath = path.resolve(candidateSkillPath);
        const normalizedRootWithSep = resolvedSkillsRoot.endsWith(path.sep)
          ? resolvedSkillsRoot
          : resolvedSkillsRoot + path.sep;

        if (
          !resolvedSkillPath.startsWith(normalizedRootWithSep) ||
          path.basename(resolvedSkillPath) !== skillName
        ) {
          logger.warn(`Skill export blocked for invalid path derived from name '${skillName}'`);
          return res.status(400).json({ error: 'Invalid skill path' });
        }

        if (!existsSync(resolvedSkillPath)) {
          return res.status(404).json({ error: 'Skill not found' });
        }

        const archive = archiver('zip', { zlib: { level: 9 } });
        const fileName = `${skillName}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        archive.pipe(res);
        archive.directory(resolvedSkillPath, skillName);
        await archive.finalize();
      } catch (error) {
        logger.error('Error exporting skill:', error);
        res.status(500).json({ error: 'Internal server error' });
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
        return res.status(400).json({ error: 'No skill file uploaded' });
      }

      const file = req.files.skill;

      // Enforce upload size limit before any extraction
      if (file.size > MAX_SKILL_ZIP_SIZE) {
        return res
          .status(413)
          .json({ error: `Skill zip must not exceed ${MAX_SKILL_ZIP_SIZE / 1024 / 1024} MB` });
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
          return res
            .status(400)
            .json({ error: 'Zip must contain exactly one top-level skill directory' });
        }

        const skillDir = path.join(tempDir, dirs[0].name);
        const validation = await validateSkillDirectory(skillDir);

        if (!validation.valid) {
          return res.status(400).json({ error: 'Invalid skill', errors: validation.errors });
        }

        const skillName = dirs[0].name;
        const nameValidation = validateSkillName(skillName);
        if (!nameValidation.valid) {
          return res.status(400).json({ error: nameValidation.error });
        }

        const targetPath = getSkillPath(skillName);

        if (existsSync(targetPath) && !req.body.overwrite) {
          return res.status(409).json({
            error: `Skill '${skillName}' already exists. Set overwrite=true to replace.`
          });
        }

        if (existsSync(targetPath)) {
          await fs.rm(targetPath, { recursive: true, force: true });
        }
        await fs.cp(skillDir, targetPath, { recursive: true });

        await configCache.refreshSkillsCache();

        res.json({ success: true, skillName, metadata: validation.metadata });
      } catch (error) {
        logger.error('Error importing skill:', error);
        res.status(500).json({ error: 'Internal server error' });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  /**
   * GET /api/admin/skills/:name/files/* - Read a skill resource file (admin view)
   */
  app.get(
    buildServerPath('/api/admin/skills/:name/files/*'),
    adminAuth,
    requireFeature('skills'),
    async (req, res) => {
      try {
        if (!validateIdForPath(req.params.name, 'skill', res)) return;

        const filePath = req.params[0];
        if (!filePath) {
          return res.status(400).json({ error: 'File path is required' });
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
    }
  );
}
