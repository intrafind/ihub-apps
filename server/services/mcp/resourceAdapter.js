import path from 'path';
import configCache from '../../configCache.js';
import { createSourceManager } from '../../sources/index.js';
import { getSkillContent, validateSkillName } from '../../services/skillLoader.js';
import { isValidId } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

/**
 * Map iHub sources + skills onto MCP `resources/list` + `resources/read`.
 *
 * URI scheme:
 *   ihub://source/<sourceId>      – static + dynamic source content
 *   ihub://skill/<skillName>      – skill SKILL.md body
 *
 * The MCP SDK's `McpServer.registerResource` requires a fixed URI per call;
 * we register each user-visible source/skill individually at gateway build
 * time so per-OAuth-client allowlisting stays tight. Resource lists are
 * filtered against `req.user.permissions` (apps for source visibility,
 * skills for skill visibility) the same way the web UI filters them.
 */

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.en || value.de || Object.values(value)[0] || '';
  }
  return String(value);
}

/**
 * Decide whether a source is visible to a given user. Sources are not
 * tied to group permissions directly today — they're scoped via the apps
 * that reference them. For MCP we expose all enabled sources to any user
 * who carries the `mcp:resources:read` scope; per-OAuth-client narrowing
 * happens later via allowlist (future work).
 */
function isSourceVisible(source) {
  return source && source.enabled !== false;
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
 *   - kind: 'source' | 'skill'
 *   - ref: the underlying source / skill object (so the read callback
 *     can use it without re-resolving by id)
 */
export function listMcpResources({ user, expose }) {
  if (!expose?.resources) return [];

  const resources = [];

  try {
    const { data: sources = [] } = configCache.getSources();
    for (const s of sources) {
      if (!isSourceVisible(s)) continue;
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
export async function readMcpResource(uri, { user, language = 'en' }) {
  if (typeof uri !== 'string' || !uri.startsWith('ihub://')) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }
  const rest = uri.slice('ihub://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error(`Malformed resource URI: ${uri}`);

  const kind = rest.slice(0, slash);
  const rawId = decodeURIComponent(rest.slice(slash + 1));
  // path.basename strips any directory components and is the canonical
  // CodeQL-recognised sanitiser for path injection. Combined with the
  // exact-match check below, anything containing /, \, or .. fails closed.
  const safeId = path.basename(rawId);
  if (safeId !== rawId) {
    throw new Error(`Invalid resource id: ${rawId}`);
  }

  if (kind === 'source') {
    // Reject anything outside the source-id charset before any path build.
    if (!isValidId(safeId)) {
      throw new Error(`Source not found: ${safeId}`);
    }
    const { data: sources = [] } = configCache.getSources();
    const source = sources.find(s => s.id === safeId);
    if (!source || !isSourceVisible(source)) {
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
