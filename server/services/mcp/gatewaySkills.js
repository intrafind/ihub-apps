// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iHub's skills over the MCP Skills extension (`io.modelcontextprotocol/skills`,
 * SEP-2640) on the inbound gateway.
 *
 * A client lists the skills with `skills/list` and reads each file with
 * `resources/read` at `skill://<name>/<path>`, checking it against the SHA-256
 * digest and size the listing published. Each entry carries the skill's
 * frontmatter and its complete file manifest, so a client can choose a skill
 * and ask its user for approval without reading a single file.
 *
 * What is served is what the `ihub://skill/...` resources serve (and the same
 * caller sees): the admin skills the caller's groups grant
 * (`permissions.skills`), each with the text files it bundles under
 * `references/`, `scripts/` and `assets/`. `SKILL.md` keeps its frontmatter
 * byte for byte; its body is what the skill loader resolves (a system skill's
 * `if-skill` text). Binary files are not served, so they are not in the
 * manifest either.
 *
 * One source is built per gateway server, so per caller and per request: its
 * cache holds the bytes the digests were computed over, which is what keeps a
 * `resources/read` consistent with the `skills/list` the same request (or
 * session) answered.
 *
 * @module services/mcp/gatewaySkills
 */
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills';
import configCache from '../../configCache.js';
import { getSkillContent, getSkillResource } from '../skillLoader.js';
import { isSkillVisible, resourceMimeType, skillResourceEntries } from './resourceAdapter.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpGatewaySkills';
const SKILL_FILE = 'SKILL.md';
const BASE_URI = 'skill://';

/** The leading YAML frontmatter block of a SKILL.md, delimiters included. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/**
 * The `SKILL.md` text the gateway serves: the file's own frontmatter, then the
 * body as the skill loader resolves it.
 *
 * @param {string} raw - The file as stored
 * @param {string} body - The loader's body
 * @returns {string|null} null when the file has no frontmatter
 */
export function servedSkillMarkdown(raw, body) {
  const match = typeof raw === 'string' ? raw.match(FRONTMATTER) : null;
  if (!match) return null;
  const frontmatter = match[0].endsWith('\n') ? match[0] : `${match[0]}\n`;
  return `${frontmatter}${body ?? ''}`;
}

/**
 * The skill name a `skill://` URI points into, or null.
 *
 * @param {string} uri
 * @returns {string|null}
 */
function skillNameOf(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(BASE_URI)) return null;
  const [encoded] = uri.slice(BASE_URI.length).split('/');
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * A `SkillSource` over the skills one caller may see.
 *
 * @param {Object} params
 * @param {Object} params.user - The authenticated caller
 * @returns {import('@modelcontextprotocol/server/ext/skills').SkillSource}
 */
export function createGatewaySkillSource({ user }) {
  /** name -> Promise<{entry, files: Map<uri, {text, mimeType}>}|null> */
  const loaded = new Map();

  const visibleSkill = name => {
    const { data: skills = [] } = configCache.getSkills();
    const skill = skills.find(candidate => candidate.name === name);
    return skill && isSkillVisible(skill, user) ? skill : null;
  };

  const visibleSkills = () => {
    const { data: skills = [] } = configCache.getSkills();
    return skills.filter(skill => isSkillVisible(skill, user));
  };

  const load = skill => {
    if (!loaded.has(skill.name)) loaded.set(skill.name, loadSkill(skill));
    return loaded.get(skill.name);
  };

  return {
    async list() {
      const results = await Promise.all(visibleSkills().map(load));
      return { skills: results.filter(Boolean).map(result => result.entry) };
    },
    async get(uri) {
      const skill = visibleSkill(skillNameOf(uri));
      if (!skill) return undefined;
      const result = await load(skill);
      return result && result.entry.uri === uri ? result.entry : undefined;
    },
    async read(uri) {
      // Re-checked on every read: a session outlives a change to the grants.
      const skill = visibleSkill(skillNameOf(uri));
      if (!skill) return undefined;
      const result = await load(skill);
      return result?.files.get(uri);
    }
  };
}

/**
 * Read one skill's files and build its entry (digests, sizes, frontmatter).
 * A skill that cannot be read, or that breaks the Agent Skills rules, is left
 * out with a warning; the others are still served.
 *
 * @param {{name: string}} skill - A skill from the config cache
 * @returns {Promise<{entry: Object, files: Map<string, {text: string, mimeType: string}>}|null>}
 */
async function loadSkill(skill) {
  try {
    const content = await getSkillContent(skill.name);
    if (!content) return null;
    const markdown = servedSkillMarkdown(
      await getSkillResource(skill.name, SKILL_FILE),
      content.body
    );
    if (markdown === null) {
      logger.warn('Skill left out of the MCP gateway: SKILL.md has no frontmatter', {
        component: COMPONENT,
        skill: skill.name
      });
      return null;
    }
    const texts = { [SKILL_FILE]: markdown };
    const mimeTypes = { [SKILL_FILE]: 'text/markdown' };
    for (const relativePath of skillResourceEntries(content)) {
      const text = await getSkillResource(skill.name, relativePath);
      if (text === null) continue;
      texts[relativePath] = text;
      mimeTypes[relativePath] = resourceMimeType(relativePath);
    }
    const entry = await skillEntry(skill.name, texts, { baseUri: BASE_URI });
    // Keyed by the URIs the manifest publishes, so a read answers exactly
    // the URIs a client verifies against.
    const files = new Map();
    const root = entry.uri.slice(0, -SKILL_FILE.length);
    for (const { uri } of entry.resources) {
      const relativePath = uri
        .slice(root.length)
        .split('/')
        .map(segment => decodeURIComponent(segment))
        .join('/');
      if (!(relativePath in texts)) continue;
      files.set(uri, { text: texts[relativePath], mimeType: mimeTypes[relativePath] });
    }
    return { entry, files };
  } catch (error) {
    logger.warn('Skill left out of the MCP gateway', {
      component: COMPONENT,
      skill: skill.name,
      error: error.message
    });
    return null;
  }
}

/**
 * Serve the caller's skills on a gateway server.
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Object} params
 * @param {Object} params.user
 */
export function attachGatewaySkills(server, { user }) {
  new SkillsExtension({
    source: createGatewaySkillSource({ user }),
    onWarning: ({ path, message }) =>
      logger.warn('MCP gateway skill warning', { component: COMPONENT, path, message })
  }).attach(server);
}
