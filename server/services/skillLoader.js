import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import logger from '../utils/logger.js';

// Agent Skills spec constraints
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_FILE = 'SKILL.md';

/**
 * Validate a skill name against the Agent Skills spec
 * @param {string} name - Skill name to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSkillName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Skill name is required' };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, error: `Skill name exceeds ${MAX_SKILL_NAME_LENGTH} characters` };
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      valid: false,
      error:
        'Skill name must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens'
    };
  }
  return { valid: true };
}

/**
 * Get the resolved skills directory path
 * @param {string} [customDir] - Optional custom directory path
 * @returns {string} Absolute path to skills directory
 */
function getSkillsDirectory(customDir) {
  const rootDir = getRootDir();
  const contentsDir = config.CONTENTS_DIR || 'contents';
  return customDir
    ? path.resolve(rootDir, customDir)
    : path.resolve(rootDir, contentsDir, 'skills');
}

/**
 * Parse SKILL.md frontmatter and body
 * @param {string} filePath - Path to SKILL.md
 * @returns {Promise<{ frontmatter: object, body: string } | null>}
 */
async function parseSkillFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const { data: frontmatter, content: body } = matter(content);
    return { frontmatter, body: body.trim() };
  } catch (error) {
    logger.error(`Failed to parse SKILL.md at ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Validate parsed skill data against the Agent Skills spec
 * @param {object} frontmatter - Parsed YAML frontmatter
 * @param {string} dirName - Directory name for the skill
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSkillData(frontmatter, dirName) {
  const errors = [];

  if (!frontmatter.name) {
    errors.push('Missing required field: name');
  } else {
    const nameValidation = validateSkillName(frontmatter.name);
    if (!nameValidation.valid) {
      errors.push(`Invalid name: ${nameValidation.error}`);
    }
    if (frontmatter.name !== dirName) {
      // Warn but don't fail — use directory name as the canonical ID
      logger.warn(
        `Skill name '${frontmatter.name}' does not match directory name '${dirName}'. Using directory name.`
      );
    }
  }

  if (!frontmatter.description) {
    errors.push('Missing required field: description');
  } else if (typeof frontmatter.description !== 'string') {
    errors.push('Description must be a string');
  } else if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (frontmatter.compatibility && typeof frontmatter.compatibility !== 'string') {
    errors.push('Compatibility must be a string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Scan a directory for subdirectories that may be skills
 * @param {string} dirPath - Path to scan
 * @returns {Promise<string[]>} Array of subdirectory names
 */
async function scanForSkillDirs(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Directory doesn't exist yet — create it
      try {
        await fs.mkdir(dirPath, { recursive: true });
        logger.info(`Created skills directory: ${dirPath}`);
      } catch (mkdirError) {
        logger.error(`Failed to create skills directory: ${mkdirError.message}`);
      }
      return [];
    }
    logger.error(`Failed to scan skills directory: ${error.message}`);
    return [];
  }
}

/**
 * List files in a skill directory (for file browser)
 * @param {string} skillDir - Absolute path to the skill directory
 * @returns {Promise<string[]>} Relative file paths
 */
async function listSkillFiles(skillDir) {
  const files = [];

  async function walk(dir, prefix = '') {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relPath);
        } else {
          files.push(relPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  await walk(skillDir);
  return files;
}

/**
 * Load metadata for all skills in the skills directory
 * @param {string} [customDir] - Optional custom skills directory
 * @returns {Promise<Map<string, object>>} Map of skill name to metadata
 */
export async function loadSkillsMetadata(customDir) {
  const skillsDir = getSkillsDirectory(customDir);
  const skillDirs = await scanForSkillDirs(skillsDir);
  const skills = new Map();

  for (const dirName of skillDirs) {
    const skillPath = path.join(skillsDir, dirName);
    const skillFilePath = path.join(skillPath, SKILL_FILE);

    try {
      await fs.access(skillFilePath);
    } catch {
      // No SKILL.md in this directory — skip
      continue;
    }

    const parsed = await parseSkillFile(skillFilePath);
    if (!parsed) continue;

    const validation = validateSkillData(parsed.frontmatter, dirName);
    if (!validation.valid) {
      logger.warn(`Skipping invalid skill '${dirName}': ${validation.errors.join(', ')}`);
      continue;
    }

    const fm = parsed.frontmatter;

    skills.set(dirName, {
      name: dirName, // Use directory name as canonical ID
      displayName: fm.name || dirName,
      description: fm.description || '',
      license: fm.license || null,
      compatibility: fm.compatibility || null,
      metadata: fm.metadata || {},
      allowedTools: fm['allowed-tools'] || null,
      path: skillPath,
      enabled: true // Default, can be overridden by skills.json
    });
  }

  return skills;
}

/**
 * Get the full content (body) of a skill's SKILL.md
 * @param {string} skillName - Skill name/directory
 * @param {string} [customDir] - Optional custom skills directory
 * @returns {Promise<{ body: string, references: string[], scripts: string[], assets: string[] } | null>}
 */
export async function getSkillContent(skillName, customDir) {
  // Validate skill name to prevent path traversal and enforce spec
  const nameValidation = validateSkillName(skillName);
  if (!nameValidation.valid) {
    logger.warn(`Rejected invalid skill name '${skillName}': ${nameValidation.error}`);
    return null;
  }

  const skillsDir = getSkillsDirectory(customDir);
  // Resolve the skill path against the skills directory and ensure it stays within it
  const resolvedSkillPath = path.resolve(skillsDir, skillName);
  const normalizedSkillsDir = path.resolve(skillsDir);
  if (resolvedSkillPath !== normalizedSkillsDir && !resolvedSkillPath.startsWith(normalizedSkillsDir + path.sep)) {
    logger.warn(`Rejected skill path traversal attempt for skill '${skillName}'`);
    return null;
  }

  const skillFilePath = path.join(resolvedSkillPath, SKILL_FILE);

  const parsed = await parseSkillFile(skillFilePath);
  if (!parsed) return null;

  // Discover referenced directories
  const references = [];
  const scripts = [];
  const assets = [];

  for (const [dirName, arr] of [
    ['references', references],
    ['scripts', scripts],
    ['assets', assets]
  ]) {
    const dirPath = path.join(resolvedSkillPath, dirName);
    try {
      const entries = await fs.readdir(dirPath);
      arr.push(...entries.map(e => `${dirName}/${e}`));
    } catch {
      // Directory doesn't exist — that's fine
    }
  }

  return {
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    references,
    scripts,
    assets
  };
}

/**
 * Read a resource file from a skill directory with path traversal prevention
 * @param {string} skillName - Skill name/directory
 * @param {string} filePath - Relative path from skill root
 * @param {string} [customDir] - Optional custom skills directory
 * @returns {Promise<string | null>}
 */
export async function getSkillResource(skillName, filePath, customDir) {
  const skillsDir = getSkillsDirectory(customDir);
  const skillPath = path.join(skillsDir, skillName);

  // Path traversal prevention
  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    logger.warn(`Path traversal attempt blocked for skill '${skillName}': ${filePath}`);
    return null;
  }

  const resolvedPath = path.resolve(skillPath, filePath);
  if (!resolvedPath.startsWith(skillPath)) {
    logger.warn(`Path traversal attempt blocked for skill '${skillName}': ${filePath}`);
    return null;
  }

  try {
    const content = await fs.readFile(resolvedPath, 'utf-8');
    return content;
  } catch (error) {
    logger.error(`Failed to read skill resource '${filePath}' from '${skillName}':`, error.message);
    return null;
  }
}

/**
 * Validate a skill directory structure
 * @param {string} dirPath - Absolute path to the skill directory
 * @returns {Promise<{ valid: boolean, errors: string[], metadata?: object }>}
 */
export async function validateSkillDirectory(dirPath) {
  const errors = [];

  // Check SKILL.md exists
  const skillFilePath = path.join(dirPath, SKILL_FILE);
  try {
    await fs.access(skillFilePath);
  } catch {
    errors.push(`Missing required file: ${SKILL_FILE}`);
    return { valid: false, errors };
  }

  // Parse and validate
  const parsed = await parseSkillFile(skillFilePath);
  if (!parsed) {
    errors.push('Failed to parse SKILL.md');
    return { valid: false, errors };
  }

  const dirName = path.basename(dirPath);
  const validation = validateSkillData(parsed.frontmatter, dirName);
  if (!validation.valid) {
    errors.push(...validation.errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    metadata: parsed.frontmatter
  };
}

/**
 * Get the absolute path for a skill directory
 * @param {string} skillName - Skill name
 * @param {string} [customDir] - Optional custom skills directory
 * @returns {string}
 */
export function getSkillPath(skillName, customDir) {
  return path.join(getSkillsDirectory(customDir), skillName);
}

export { getSkillsDirectory, listSkillFiles, validateSkillName };
