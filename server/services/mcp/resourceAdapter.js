import path from 'path';
import configCache from '../../configCache.js';
import { createSourceManager } from '../../sources/index.js';
import {
  getSkillContent,
  getSkillResource,
  validateSkillName
} from '../../services/skillLoader.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getVisibleSourceIds } from './permissions.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';

/**
 * Map iHub sources + skills onto MCP `resources/list` + `resources/read`.
 *
 * URI scheme:
 *   ihub://source/<sourceId>      – static + dynamic source content
 *   ihub://skill/<skillName>      – skill SKILL.md body
 *   ihub://skill/<skillName>/<path> – a file the skill bundles, e.g.
 *                                   references/query-cookbook.md
 *
 * The MCP SDK's `McpServer.registerResource` requires a fixed URI per call;
 * we register each visible source/skill individually at gateway build time.
 * Visibility is scoped per caller: sources are limited to those referenced
 * by apps the caller can access (getVisibleSourceIds), and skills are
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
 * Decide whether a source is visible to a given caller. Sources are scoped
 * through the apps that reference them, so a source is only visible if it is
 * enabled AND referenced by an app the caller can access. `visibleSourceIds`
 * is the union of `app.sources` across the caller's accessible apps (built by
 * ./permissions.js getVisibleSourceIds). Without this filter, any caller with
 * `mcp:resources:read` would see every source on the platform.
 */
function isSourceVisible(source, visibleSourceIds) {
  if (!source || source.enabled === false) return false;
  if (!(visibleSourceIds instanceof Set)) return false;
  return visibleSourceIds.has('*') || visibleSourceIds.has(source.id);
}

/** The files a skill bundles next to its SKILL.md, as the loader reports them. */
function skillResourceEntries(content) {
  return [...(content?.references || []), ...(content?.scripts || []), ...(content?.assets || [])];
}

function resourceMimeType(relativePath) {
  return relativePath.endsWith('.md') ? 'text/markdown' : 'text/plain';
}

/** `ihub://skill/<name>/<relative/path>`, each segment encoded on its own. */
function skillResourceUri(skillName, relativePath) {
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  return `ihub://skill/${encodeURIComponent(skillName)}/${encodedPath}`;
}

function isSkillVisible(skill, user) {
  if (!skill) return false;
  if (skill.enabled === false) return false;
  // Honour user.permissions.skills if it's a Set (built by
  // enhanceUserWithPermissions). Wildcard '*' grants all.
  const allowed = user?.permissions?.skills;
  if (!(allowed instanceof Set)) return true;
  return allowed.has('*') || allowed.has(skill.name);
}

/**
 * Enumerate resources for the per-request McpServer construction. Returns
 * an array of { uri, name, description, mimeType, kind, ref } where:
 *   - kind: 'source' | 'skill' | 'skill-resource'
 *   - ref: the underlying source / skill object (so the read callback
 *     can use it without re-resolving by id)
 */
export async function listMcpResources({ user, platform, expose }) {
  if (!expose?.resources) return [];

  const resources = [];
  const visibleSourceIds = await getVisibleSourceIds(user, platform);

  try {
    const { data: sources = [] } = configCache.getSources();
    for (const s of sources) {
      if (!isSourceVisible(s, visibleSourceIds)) continue;
      resources.push({
        uri: `ihub://source/${encodeURIComponent(s.id)}`,
        name: extractText(s.name) || s.id,
        description: extractText(s.description) || `iHub source: ${s.id}`,
        mimeType: 'text/plain',
        kind: 'source',
        ref: s
      });
    }
  } catch (err) {
    logger.warn('listMcpResources: source enumeration failed', {
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
      // ponytail: one SKILL.md read per visible skill per gateway build.
      // Cache in skillLoader if a deployment ever ships enough skills to notice.
      const content = await getSkillContent(skill.name);
      for (const entry of skillResourceEntries(content)) {
        resources.push({
          uri: skillResourceUri(skill.name, entry),
          name: `${skill.name}/${entry}`,
          description: `Reference bundled with the ${skill.name} skill: ${entry}`,
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

  if (kind === 'source') {
    // Sources are single documents; nothing addresses a path inside one.
    if (relativePath !== null) {
      throw new Error(`Source not found: ${safeId}/${relativePath}`);
    }
    // Reject anything outside the source-id charset before any path build.
    if (!isValidId(safeId)) {
      throw new Error(`Source not found: ${safeId}`);
    }
    // Recompute the caller's visible source set so a read can't reach a
    // source outside the apps they can access (same check as list).
    const visibleSourceIds = await getVisibleSourceIds(user, platform);
    const { data: sources = [] } = configCache.getSources();
    const source = sources.find(s => s.id === safeId);
    if (!source || !isSourceVisible(source, visibleSourceIds)) {
      throw new Error(`Source not found: ${safeId}`);
    }
    // From this point on, only properties of the admin-managed `source`
    // object flow downstream. The user-controlled `safeId` is used solely
    // as a Map lookup key.
    const text = await readSourceContent(source, { user, language });
    return {
      contents: [
        {
          uri,
          mimeType: 'text/plain',
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

async function readSourceContent(source, { user, language }) {
  // Tool-exposed sources don't have static content — return a sentinel
  // describing the tool route so the agent doesn't get an empty payload.
  if (source.exposeAs === 'tool') {
    return `This source is exposed as a tool (\`source_${source.id}_*\`), not as static content. Call the tool via MCP \`tools/call\` to query it.`;
  }
  const manager = createSourceManager();
  const result = await manager.loadSources([source], { user, language });
  if (!result || !Array.isArray(result.sources)) return '';
  const loaded = result.sources[0];
  if (!loaded) return '';
  if (!loaded.success && loaded.error) {
    throw new Error(`Source load failed: ${loaded.error}`);
  }
  return loaded.content || result.content || '';
}
