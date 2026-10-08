import { promises as fs, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';
import { parseFrontMatter } from '../utils/frontMatter.js';
import { getContentsPath } from '../utils/contentsPath.js';
import { resolveAndValidatePath, resolveAndValidateRealPath } from '../utils/pathSecurity.js';

// Agent Skills spec constraints
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_FILE = 'SKILL.md';

/**
 * System skills: skills iHub ships as part of the server (e.g. `pdf`).
 *
 * They live next to the code, not in `contents/`, so they are never copied
 * into an installation and cannot be edited, replaced or deleted there. A
 * skill is a system skill because of *where it lives* — an `isSystem` field
 * in a SKILL.md frontmatter means nothing. Their names are reserved: a
 * `contents/skills/<name>` directory with the same name is ignored.
 */
/**
 * @returns {string} Absolute path of the directory holding the system skills
 *   (`server/systemSkills`, in a checkout and in every packaged build).
 */
export function getSystemSkillsDirectory() {
  return path.join(getRootDir(), 'server', 'systemSkills');
}

/**
 * Whether a name belongs to a system skill.
 *
 * @param {string} skillName
 * @returns {boolean}
 */
export function isSystemSkill(skillName) {
  return typeof skillName === 'string' && systemSkillNames().has(skillName);
}

const systemSkillNamesByDir = new Map();

/**
 * Names of the shipped system skills: the directories under the system
 * skills directory that hold a SKILL.md. They only change with a deployment,
 * so the listing is read once per process.
 *
 * @returns {Set<string>}
 */
function systemSkillNames() {
  const dir = getSystemSkillsDirectory();
  if (!systemSkillNamesByDir.has(dir)) {
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => entry.name)
        .filter(name => validateSkillName(name).valid)
        .filter(name => existsSync(path.join(dir, name, SKILL_FILE)));
    } catch {
      // No system skills directory (a stripped-down build): no system skills.
    }
    systemSkillNamesByDir.set(dir, new Set(names));
  }
  return systemSkillNamesByDir.get(dir);
}

/**
 * Tool ids named by a skill's `allowed-tools` frontmatter (a space- or
 * comma-separated string, or a YAML list).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseAllowedTools(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  return [...new Set(list.map(v => String(v).trim()).filter(v => /^[A-Za-z0-9_-]{1,64}$/.test(v)))];
}

/**
 * Whether a skill's frontmatter sets `disable-model-invocation: true` (the
 * field Claude Code uses): only a user starts the skill, with `/name`. The
 * model is not offered it and cannot load it on its own.
 *
 * @param {Object} [frontmatter]
 * @returns {boolean}
 */
export function disablesModelInvocation(frontmatter) {
  const value = frontmatter?.['disable-model-invocation'];
  return value === true || value === 'true';
}

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
  return customDir ? path.resolve(getRootDir(), customDir) : getContentsPath('skills');
}

/**
 * The directory a skill's files are read from: the system skills directory
 * for a system skill (they win over a same-named contents skill), otherwise
 * the contents skills directory.
 *
 * @param {string} skillName - A validated skill name.
 * @param {string} [customDir]
 * @returns {string}
 */
function resolveSkillRoot(skillName, customDir) {
  return isSystemSkill(skillName) ? getSystemSkillsDirectory() : getSkillsDirectory(customDir);
}

/**
 * Parse SKILL.md frontmatter and body.
 *
 * The frontmatter must be YAML (see `utils/frontMatter.js`). A file that cannot
 * be read, has invalid YAML, or declares another frontmatter language is
 * logged and yields `null`, so callers skip that skill instead of failing.
 *
 * @param {string} filePath - Path to SKILL.md
 * @returns {Promise<{ frontmatter: object, body: string } | null>}
 */
async function parseSkillFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const { data: frontmatter, content: body } = parseFrontMatter(content);
    return { frontmatter, body: body.trim() };
  } catch (error) {
    logger.error('Failed to parse SKILL.md', { component: 'SkillLoader', filePath, error });
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
      logger.warn('Skill name does not match directory name, using directory name', {
        component: 'SkillLoader',
        skillName: frontmatter.name,
        dirName
      });
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
 * Scan a directory for subdirectories that may be skills.
 * Symlinks are skipped to prevent directory traversal attacks.
 * @param {string} dirPath - Path to scan
 * @returns {Promise<string[]>} Array of subdirectory names
 */
async function scanForSkillDirs(dirPath, { create = true } = {}) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    // Exclude symlinks — only real directories are valid skill containers
    return entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!create) return [];
      // Directory doesn't exist yet — create it
      try {
        await fs.mkdir(dirPath, { recursive: true });
        logger.info('Created skills directory', { component: 'SkillLoader', dirPath });
      } catch (mkdirError) {
        logger.error('Failed to create skills directory', {
          component: 'SkillLoader',
          error: mkdirError
        });
      }
      return [];
    }
    logger.error('Failed to scan skills directory', { component: 'SkillLoader', error });
    return [];
  }
}

/**
 * List files in a skill directory (for file browser).
 * Symlinks are excluded to prevent path traversal attacks.
 * @param {string} skillDir - Absolute path to the skill directory
 * @returns {Promise<string[]>} Relative file paths
 */
async function listSkillFiles(skillDir) {
  const files = [];

  async function walk(dir, prefix = '') {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip symlinks to prevent traversal outside skill directory
        if (entry.isSymbolicLink()) continue;
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
  const skills = new Map();
  // System skills first: their names are reserved.
  await collectSkills(getSystemSkillsDirectory(), skills, { isSystem: true, create: false });
  await collectSkills(getSkillsDirectory(customDir), skills, { isSystem: false, create: true });
  return skills;
}

/**
 * Read every skill in one directory into `skills`.
 *
 * @param {string} skillsDir
 * @param {Map<string, object>} skills - Filled in place; existing names win.
 * @param {{ isSystem: boolean, create: boolean }} options
 */
async function collectSkills(skillsDir, skills, { isSystem, create }) {
  const skillDirs = await scanForSkillDirs(skillsDir, { create });

  for (const dirName of skillDirs) {
    const skillPath = path.join(skillsDir, dirName);
    const skillFilePath = path.join(skillPath, SKILL_FILE);

    try {
      await fs.access(skillFilePath);
    } catch {
      // No SKILL.md in this directory — skip
      continue;
    }

    if (skills.has(dirName)) {
      logger.warn('Ignoring skill that uses the name of a system skill', {
        component: 'SkillLoader',
        dirName,
        skillPath
      });
      continue;
    }

    const parsed = await parseSkillFile(skillFilePath);
    if (!parsed) continue;

    const validation = validateSkillData(parsed.frontmatter, dirName);
    if (!validation.valid) {
      logger.warn('Skipping invalid skill', {
        component: 'SkillLoader',
        dirName,
        errors: validation.errors
      });
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
      // Only a system skill can bring tools with it: its `allowed-tools` name
      // built-in tools that come with the skill when an app enables it. An
      // installed skill's list stays informational.
      providedTools: isSystem ? parseAllowedTools(fm['allowed-tools']) : [],
      // false: only users start it with `/name`; it is not listed for the model.
      modelInvocable: !disablesModelInvocation(fm),
      isSystem,
      path: skillPath,
      enabled: true // Default, can be overridden by skills.json
    });
  }
}

/**
 * Get the full content (body) of a skill's SKILL.md
 * @param {string} skillName - Skill name/directory
 * @param {string} [customDir] - Optional custom skills directory
 * @returns {Promise<{ body: string, description: string, frontmatter: object, isSystem: boolean, references: string[], scripts: string[], assets: string[] } | null>}
 */
export async function getSkillContent(skillName, customDir) {
  // Validate skill name to prevent path traversal and enforce spec
  const nameValidation = validateSkillName(skillName);
  if (!nameValidation.valid) {
    logger.warn('Rejected invalid skill name', {
      component: 'SkillLoader',
      skillName,
      error: nameValidation.error
    });
    return null;
  }

  const skillsDir = resolveSkillRoot(skillName, customDir);
  const resolvedSkillPath = await resolveAndValidatePath(skillName, skillsDir);
  if (!resolvedSkillPath) {
    logger.warn('Rejected skill path traversal attempt', { component: 'SkillLoader', skillName });
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
    description:
      typeof parsed.frontmatter?.description === 'string' ? parsed.frontmatter.description : '',
    frontmatter: parsed.frontmatter,
    isSystem: skillsDir === getSystemSkillsDirectory(),
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
  // Validate skill name to prevent path traversal and enforce spec
  const nameValidation = validateSkillName(skillName);
  if (!nameValidation.valid) {
    logger.warn('Rejected invalid skill name', {
      component: 'SkillLoader',
      skillName,
      error: nameValidation.error
    });
    return null;
  }

  // Ensure filePath is a simple string to avoid type confusion attacks
  if (typeof filePath !== 'string') {
    logger.warn('Rejected non-string file path for skill', {
      component: 'SkillLoader',
      skillName,
      filePath: String(filePath)
    });
    return null;
  }

  const skillsDir = resolveSkillRoot(skillName, customDir);
  const resolvedSkillPath = await resolveAndValidatePath(skillName, skillsDir);
  if (!resolvedSkillPath) {
    logger.warn('Rejected skill path traversal attempt', { component: 'SkillLoader', skillName });
    return null;
  }

  // Validate the file path stays within the skill directory (handles ".." and absolute paths)
  const resolvedFilePath = await resolveAndValidatePath(filePath, resolvedSkillPath);
  if (!resolvedFilePath) {
    logger.warn('Path traversal attempt blocked', {
      component: 'SkillLoader',
      skillName,
      filePath
    });
    return null;
  }

  // Resolve real paths (follows symlinks) to detect symlink-based traversal
  const realResolvedPath = await resolveAndValidateRealPath(filePath, resolvedSkillPath);
  if (!realResolvedPath) {
    logger.warn('Symlink-based path traversal blocked', {
      component: 'SkillLoader',
      skillName,
      filePath
    });
    return null;
  }

  try {
    const content = await fs.readFile(realResolvedPath, 'utf-8');
    return content;
  } catch (error) {
    logger.error('Failed to read skill resource', {
      component: 'SkillLoader',
      filePath,
      skillName,
      error
    });
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
 * Get the absolute path for a skill directory (the system skills directory
 * for a system skill)
 * @param {string} skillName - Skill name
 * @param {string} [customDir] - Optional custom skills directory
 * @returns {string}
 */
export function getSkillPath(skillName, customDir) {
  return path.join(resolveSkillRoot(skillName, customDir), skillName);
}

export { getSkillsDirectory, listSkillFiles, validateSkillName };
