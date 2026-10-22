// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import path from 'node:path';
import configCache from '../../configCache.js';
import { providerFor } from '../knowledge/registry.js';
import {
  getSkillContent,
  getSkillResource,
  validateSkillName
} from '../../services/skillLoader.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getVisibleProjectIds } from './permissions.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';

/**
 * Map iHub projects + skills onto MCP `resources/list` + `resources/read`.
 *
 * URI scheme:
 *   ihub://project/<projectId>    – the text of an admin project's items (#1036)
 *   ihub://skill/<skillName>      – skill SKILL.md body
 *   ihub://skill/<skillName>/<path> – a file the skill bundles, e.g.
 *                                   references/query-cookbook.md
 *
 * The MCP SDK's `McpServer.registerResource` requires a fixed URI per call;
 * we register each visible project/skill individually at gateway build time.
 * Visibility is scoped per caller: projects are limited to those linked by
 * apps the caller can access (getVisibleProjectIds), and skills are
 * filtered against the caller's group `skills` permission — the same model
 * the web UI applies.
 */

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return getLocalizedString(value, 'en');
  return String(value);
}

/**
 * Decide whether an admin project is visible to a given caller. Projects are
 * scoped through the apps that link them, so a project is only visible if it
 * is enabled AND linked by an app the caller can access. `visibleProjectIds`
 * is the union of `app.projects` across the caller's accessible apps (built
 * by ./permissions.js getVisibleProjectIds). Without this filter, any caller
 * with `mcp:resources:read` would see every project on the platform.
 */
function isProjectVisible(project, visibleProjectIds) {
  if (!project || project.enabled === false) return false;
  if (!(visibleProjectIds instanceof Set)) return false;
  return visibleProjectIds.has('*') || visibleProjectIds.has(project.id);
}

/**
 * Text formats a skill may bundle, by extension. The loader reads a resource
 * as UTF-8, so a binary asset (an image, a font) would reach the caller
 * corrupted, and a subdirectory is not readable at all — anything without one
 * of these extensions is neither listed nor readable.
 */
const TEXT_MIME_TYPES = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript'
};

function resourceMimeType(relativePath) {
  return TEXT_MIME_TYPES[path.extname(relativePath).toLowerCase()] || null;
}

/** The text files a skill bundles next to its SKILL.md, as the loader reports them. */
function skillResourceEntries(content) {
  return [
    ...(content?.references || []),
    ...(content?.scripts || []),
    ...(content?.assets || [])
  ].filter(entry => resourceMimeType(entry) !== null);
}

/** `ihub://skill/<name>/<relative/path>`, each segment encoded on its own. */
function skillResourceUri(skillName, relativePath) {
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  return `ihub://skill/${encodeURIComponent(skillName)}/${encodedPath}`;
}

function isSkillVisible(skill, user) {
  if (!skill) return false;
  if (skill.enabled === false) return false;
  // Honour user.permissions.skills (built by enhanceUserWithPermissions).
  // Wildcard '*' grants all; a principal without the set sees none.
  const allowed = user?.permissions?.skills;
  if (!(allowed instanceof Set)) return false;
  return allowed.has('*') || allowed.has(skill.name);
}

/**
 * Enumerate resources for the per-request McpServer construction. Returns
 * an array of { uri, name, description, mimeType, kind, ref } where:
 *   - kind: 'project' | 'skill' | 'skill-resource'
 *   - ref: the underlying project / skill object (so the read callback
 *     can use it without re-resolving by id)
 */
export async function listMcpResources({ user, platform, expose }) {
  if (!expose?.resources) return [];

  const resources = [];
  const visibleProjectIds = await getVisibleProjectIds(user, platform);

  try {
    const { data: projects = [] } = configCache.getProjects(true);
    for (const project of projects) {
      if (!isProjectVisible(project, visibleProjectIds)) continue;
      resources.push({
        uri: `ihub://project/${encodeURIComponent(project.id)}`,
        name: extractText(project.name) || project.id,
        description: extractText(project.description) || `iHub project: ${project.id}`,
        mimeType: 'text/markdown',
        kind: 'project',
        ref: project
      });
    }
  } catch (err) {
    logger.warn('listMcpResources: project enumeration failed', {
      component: 'McpResourceAdapter',
      error: err.message
    });
  }

  try {
    const { data: skills = [] } = configCache.getSkills();
    for (const skill of skills) {
      if (!isSkillVisible(skill, user)) continue;
      resources.push({
        uri: `ihub://skill/${encodeURIComponent(skill.name)}`,
        name: skill.name,
        description: skill.description || `iHub skill: ${skill.name}`,
        mimeType: 'text/markdown',
        kind: 'skill',
        ref: skill
      });

      // List the files the SKILL.md points at as resources of their own.
      // Internally an agent reaches these through `read_skill_resource`, but
      // that tool wraps filesystem access and is deliberately kept out of the
      // gateway — without this, every "see references/…" link in a skill is a
      // dead end for an external caller.
      // Cost: one SKILL.md read per visible skill per gateway build. Cache in
      // skillLoader if a deployment ever ships enough skills to notice.
      const content = await getSkillContent(skill.name);
      for (const entry of skillResourceEntries(content)) {
        resources.push({
          uri: skillResourceUri(skill.name, entry),
          name: `${skill.name}/${entry}`,
          description: `File bundled with the ${skill.name} skill: ${entry}`,
          mimeType: resourceMimeType(entry),
          kind: 'skill-resource',
          ref: skill
        });
      }
    }
  } catch (err) {
    logger.warn('listMcpResources: skill enumeration failed', {
      component: 'McpResourceAdapter',
      error: err.message
    });
  }

  return resources;
}

/**
 * Read a resource by URI. Returns the MCP `ReadResourceResult` shape:
 *   { contents: [{ uri, mimeType, text }] }
 *
 * Throws if the URI doesn't resolve to a visible resource.
 */
export async function readMcpResource(uri, { user, platform, language = 'en' }) {
  if (typeof uri !== 'string' || !uri.startsWith('ihub://')) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }
  const rest = uri.slice('ihub://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error(`Malformed resource URI: ${uri}`);

  const kind = rest.slice(0, slash);
  // Split on the literal separators *before* decoding, so an id carrying an
  // encoded slash stays one segment and still fails the basename check below
  // instead of silently becoming a path.
  const [encodedId, ...encodedPathSegments] = rest.slice(slash + 1).split('/');
  const rawId = decodeURIComponent(encodedId);
  const relativePath = encodedPathSegments.length
    ? encodedPathSegments.map(decodeURIComponent).join('/')
    : null;
  // path.basename strips any directory components and is the canonical
  // CodeQL-recognised sanitiser for path injection. Combined with the
  // exact-match check below, anything containing /, \, or .. fails closed.
  const safeId = path.basename(rawId);
  if (safeId !== rawId) {
    throw new Error(`Invalid resource id: ${rawId}`);
  }

  if (kind === 'project') {
    // A project is read whole; nothing addresses a path inside one.
    if (relativePath !== null) {
      throw new Error(`Project not found: ${safeId}/${relativePath}`);
    }
    if (!isValidId(safeId)) {
      throw new Error(`Project not found: ${safeId}`);
    }
    // Recompute the caller's visible project set so a read can't reach a
    // project outside the apps they can access (same check as list).
    const visibleProjectIds = await getVisibleProjectIds(user, platform);
    const { data: projects = [] } = configCache.getProjects(true);
    const project = projects.find(entry => entry.id === safeId);
    if (!project || !isProjectVisible(project, visibleProjectIds)) {
      throw new Error(`Project not found: ${safeId}`);
    }
    const text = await readProjectContent(project, { user, language });
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text
        }
      ]
    };
  }

  if (kind === 'skill') {
    const nameCheck = validateSkillName(safeId);
    if (!nameCheck.valid) {
      throw new Error(`Skill not found: ${safeId}`);
    }
    const { data: skills = [] } = configCache.getSkills();
    const skill = skills.find(s => s.name === safeId);
    if (!skill || !isSkillVisible(skill, user)) {
      throw new Error(`Skill not found: ${safeId}`);
    }
    // Pass skill.name (from configCache, admin-managed) to getSkillContent
    // rather than the user-controlled safeId. The lookup above is what
    // certifies that this skill is allowed; the value we send downstream
    // must come from the trusted side of that lookup.
    const content = await getSkillContent(skill.name);
    if (!content) throw new Error(`Skill not readable: ${skill.name}`);

    if (relativePath !== null) {
      // A SKILL.md that says "see references/x.md" is a dead end unless the
      // bundled file is readable too. The caller-supplied path is only ever
      // used after it matches an entry the loader itself enumerated — the
      // same "the lookup certifies it" rule the source branch follows, and
      // the reason a `../` never reaches the filesystem.
      const bundled = skillResourceEntries(content);
      const entry = bundled.find(e => e === relativePath);
      if (!entry) {
        throw new Error(`Skill resource not found: ${skill.name}/${relativePath}`);
      }
      const text = await getSkillResource(skill.name, entry);
      if (text === null) {
        throw new Error(`Skill resource not readable: ${skill.name}/${entry}`);
      }
      return {
        contents: [{ uri, mimeType: resourceMimeType(entry), text }]
      };
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: content.body || ''
        }
      ]
    };
  }

  throw new Error(`Unknown resource kind: ${kind}`);
}

/**
 * The text of a project's items, each under its name, through the
 * knowledge provider (spec 2 §2): what a chat with the project loaded would
 * see. Items that cannot be read are named with their reason.
 */
async function readProjectContent(project, { user, language }) {
  const provider = providerFor(project);
  const result = await provider.loadAll(project, {
    user,
    language,
    chatId: `mcp-${project.id}`,
    purpose: 'mcp'
  });
  const parts = result.docs.map(({ doc, text }) => `# ${doc.name}\n\n${text}`);
  for (const entry of result.unavailable || []) {
    parts.push(`# ${entry.name || entry.document}\n\n_unavailable: ${entry.reason}_`);
  }
  return parts.join('\n\n');
}
