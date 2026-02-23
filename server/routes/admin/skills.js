import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import archiver from 'archiver';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { getRootDir } from '../../pathUtils.js';
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

import { loadJson } from '../../configLoader.js';
import logger from '../../utils/logger.js';

const rootDir = getRootDir();

/**
 * Read the raw skills.json config file
 */
async function readSkillsConfig() {
  try {
    const config = await loadJson('config/skills.json', { useCache: false });
    return config || { skills: {}, settings: {} };
  } catch {
    return { skills: {}, settings: {} };
  }
}

/**
 * Write the skills.json config file
 */
async function writeSkillsConfig(config) {
  const filePath = path.join(rootDir, 'contents', 'config', 'skills.json');
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
}

export default function registerAdminSkillsRoutes(app) {
  /**
   * GET /api/admin/skills - List all skills with config
   */
  app.get(buildServerPath('/api/admin/skills'), adminAuth, async (req, res) => {
    try {
      const { data: skills, etag, settings } = configCache.getSkills(true);

      if (etag) {
        const clientEtag = req.headers['if-none-match'];
        if (clientEtag && clientEtag === etag) {
          return res.status(304).end();
        }
        res.setHeader('ETag', etag);
      }

      res.json({ skills, settings });
    } catch (error) {
      logger.error('Error fetching admin skills:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/admin/skills/:name - Get specific skill details
   */
  app.get(buildServerPath('/api/admin/skills/:name'), adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const { data: skills } = configCache.getSkills(true);
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      // Get full content
      const content = await getSkillContent(req.params.name);

      // Get file listing
      const files = await listSkillFiles(skill.path);

      // Get config overrides
      const skillsConfig = await readSkillsConfig();
      const configOverride = skillsConfig.skills?.[req.params.name] || {};

      res.json({
        ...skill,
        body: content?.body || '',
        frontmatter: content?.frontmatter || {},
        references: content?.references || [],
        scripts: content?.scripts || [],
        assets: content?.assets || [],
        files,
        configOverride
      });
    } catch (error) {
      logger.error('Error fetching admin skill detail:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PUT /api/admin/skills/:name - Update skill configuration (overrides)
   */
  app.put(buildServerPath('/api/admin/skills/:name'), adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const { data: skills } = configCache.getSkills(true);
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const { enabled, overrides } = req.body;
      const skillsConfig = await readSkillsConfig();

      skillsConfig.skills[req.params.name] = {
        ...skillsConfig.skills[req.params.name],
        enabled: enabled !== undefined ? enabled : skill.enabled,
        directory: req.params.name,
        ...(overrides && { overrides })
      };

      await writeSkillsConfig(skillsConfig);
      await configCache.refreshSkillsCache();

      res.json({ success: true });
    } catch (error) {
      logger.error('Error updating skill config:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/admin/skills/:name/toggle - Toggle skill enabled/disabled
   */
  app.post(buildServerPath('/api/admin/skills/:name/toggle'), adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const { data: skills } = configCache.getSkills(true);
      const skill = skills.find(s => s.name === req.params.name);

      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const skillsConfig = await readSkillsConfig();
      const currentEnabled = skillsConfig.skills[req.params.name]?.enabled !== false;

      skillsConfig.skills[req.params.name] = {
        ...skillsConfig.skills[req.params.name],
        enabled: !currentEnabled,
        directory: req.params.name
      };

      await writeSkillsConfig(skillsConfig);
      await configCache.refreshSkillsCache();

      res.json({ success: true, enabled: !currentEnabled });
    } catch (error) {
      logger.error('Error toggling skill:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/admin/skills/:name - Remove skill directory
   */
  app.delete(buildServerPath('/api/admin/skills/:name'), adminAuth, async (req, res) => {
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

      // Remove skill directory
      await fs.rm(skillPathResolved, { recursive: true, force: true });

      // Remove from config
      const skillsConfig = await readSkillsConfig();
      delete skillsConfig.skills[req.params.name];
      await writeSkillsConfig(skillsConfig);

      await configCache.refreshSkillsCache();
      res.json({ success: true });
    } catch (error) {
      logger.error('Error deleting skill:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/admin/skills/validate - Validate a skill directory
   */
  app.post(buildServerPath('/api/admin/skills/validate'), adminAuth, async (req, res) => {
    try {
      const { skillName } = req.body;
      if (!skillName) {
        return res.status(400).json({ error: 'skillName is required' });
      }

      const nameValidation = validateSkillName(skillName);
      if (!nameValidation.valid) {
        return res.json({ valid: false, errors: [nameValidation.error] });
      }

      const skillPath = getSkillPath(skillName);
      const validation = await validateSkillDirectory(skillPath);
      res.json(validation);
    } catch (error) {
      logger.error('Error validating skill:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/admin/skills/:name/export - Export single skill as zip
   */
  app.get(buildServerPath('/api/admin/skills/:name/export'), adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.name, 'skill', res)) return;

      const skillPath = getSkillPath(req.params.name);
      if (!existsSync(skillPath)) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const archive = archiver('zip', { zlib: { level: 9 } });
      const fileName = `${req.params.name}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

      archive.pipe(res);
      archive.directory(skillPath, req.params.name);
      await archive.finalize();
    } catch (error) {
      logger.error('Error exporting skill:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/admin/skills/import - Import single skill from zip
   * Expects multipart/form-data with 'skill' file field
   */
  app.post(buildServerPath('/api/admin/skills/import'), adminAuth, async (req, res) => {
    try {
      if (!req.files || !req.files.skill) {
        return res.status(400).json({ error: 'No skill file uploaded' });
      }

      const file = req.files.skill;

      // Create temp directory for extraction
      const tempDir = path.join(rootDir, 'data', 'temp', `skill-import-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });

      try {
        // Save uploaded file
        const zipPath = path.join(tempDir, 'skill.zip');
        await file.mv(zipPath);

        // Extract using unzip command
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        await execAsync(`unzip -o "${zipPath}" -d "${tempDir}/extracted"`);

        // Find the skill directory (should be exactly one top-level dir)
        const extractedPath = path.join(tempDir, 'extracted');
        const entries = await fs.readdir(extractedPath, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory());

        if (dirs.length !== 1) {
          return res
            .status(400)
            .json({ error: 'Zip must contain exactly one top-level skill directory' });
        }

        const skillDir = path.join(extractedPath, dirs[0].name);
        const validation = await validateSkillDirectory(skillDir);

        if (!validation.valid) {
          return res.status(400).json({ error: 'Invalid skill', errors: validation.errors });
        }

        // Determine skill name from directory
        const skillName = dirs[0].name;
        const targetPath = getSkillPath(skillName);

        // Check for conflicts
        if (existsSync(targetPath) && !req.body.overwrite) {
          return res.status(409).json({
            error: `Skill '${skillName}' already exists. Set overwrite=true to replace.`
          });
        }

        // Move to skills directory
        if (existsSync(targetPath)) {
          await fs.rm(targetPath, { recursive: true, force: true });
        }
        await fs.cp(skillDir, targetPath, { recursive: true });

        await configCache.refreshSkillsCache();

        res.json({
          success: true,
          skillName,
          metadata: validation.metadata
        });
      } finally {
        // Cleanup temp directory
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      logger.error('Error importing skill:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/admin/skills/:name/files/* - Read a skill resource file (admin)
   */
  app.get(buildServerPath('/api/admin/skills/:name/files/*'), adminAuth, async (req, res) => {
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
  });

  /**
   * PUT /api/admin/skills/settings - Update global skills settings
   */
  app.put(buildServerPath('/api/admin/skills/settings'), adminAuth, async (req, res) => {
    try {
      const { settings } = req.body;
      if (!settings) {
        return res.status(400).json({ error: 'Settings object is required' });
      }

      const skillsConfig = await readSkillsConfig();
      skillsConfig.settings = { ...skillsConfig.settings, ...settings };

      await writeSkillsConfig(skillsConfig);
      await configCache.refreshSkillsCache();

      res.json({ success: true, settings: skillsConfig.settings });
    } catch (error) {
      logger.error('Error updating skills settings:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
