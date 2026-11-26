// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Skills of connected MCP servers (MCP Skills extension,
 * `io.modelcontextprotocol/skills`, SEP-2640) as skills of iHub.
 *
 * A server that declares the extension lists its skills with `skills/list`:
 * each entry carries the `SKILL.md` frontmatter and the URI, SHA-256 digest
 * and size of every file. Such a skill reaches a chat only after an admin
 * approved it on the installation:
 *
 * - **Approval binds to the entry.** It stores the entry as it was approved
 *   (`instance.skills.approved[name]`). Every file is read and verified
 *   against that stored entry, not the server's current one, so a skill the
 *   server changed (another file, other bytes, another frontmatter) no longer
 *   loads and shows as changed until an admin approves it again.
 * - **It is a skill of its own**, named `<installation>:<name>`, so it never
 *   stands in for an iHub skill of the same name. It is offered where the app
 *   turned skills on and binds the installation, to users the installation is
 *   granted to, and activated and read with `activate_skill` and
 *   `read_skill_resource` like any other skill.
 * - **It grants nothing.** `allowed-tools` in its frontmatter is ignored; the
 *   skill can only use the tools the chat offers anyway.
 *
 * Files are read through the connection the user has to the server (their own
 * for a per-user server), and kept in memory by digest once verified: a digest
 * names exactly one content, so the cache can never serve a file the approval
 * does not cover. Nothing is written to the skill folders.
 *
 * @module services/mcp/mcpSkills
 */
import { createHash } from 'node:crypto';
import { SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';
import { ServiceError } from '../../utils/ServiceError.js';
import { isAuthRequiredError } from './McpUserOAuthProvider.js';
import { SKILL_NAME_PATTERN } from '../../validators/integrationsConfigSchema.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpSkills';
const SKILL_FILE = 'SKILL.md';

/** Separates the installation from the skill name in a server skill's id. */
export const SERVER_SKILL_SEPARATOR = ':';

/** How old a server's skill listing may be when a chat activates one of its skills. */
export const LISTING_MAX_AGE_MS = 60 * 1000;

/** Most verified file contents kept in memory, and their total size. */
const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Verified file texts by connection and digest, oldest first. Keyed by the
 * connection that read them: a per-user server may refuse a file to one user
 * that it serves another, so one user's read never answers another's.
 */
const fileCache = new Map();
let cacheBytes = 0;

/** A key per connection object (the shared one, or a user's own). */
const connectionKeys = new WeakMap();
let nextConnectionKey = 0;
function connectionKeyOf(conn) {
  if (!connectionKeys.has(conn)) connectionKeys.set(conn, String(++nextConnectionKey));
  return connectionKeys.get(conn);
}

/**
 * The services this module works with; tests pass their own.
 * @returns {Promise<Object>}
 */
async function defaultDeps() {
  const [{ default: manager }, { default: installations }, tools] = await Promise.all([
    import('./McpClientManager.js'),
    import('../integrations/InstalledIntegrationService.js'),
    import('../integrations/integrationTools.js')
  ]);
  return {
    manager,
    installations,
    boundInstanceIds: tools.boundInstanceIds,
    userMayUse: tools.userMayUse
  };
}

/** Services a test put in place of the real ones (`setServerSkillDepsForTests`). */
let testDeps = null;

async function depsOf(deps) {
  return { ...(testDeps || (await defaultDeps())), ...deps };
}

/** Test seam: the services every call uses unless it passes its own; null restores. */
export function setServerSkillDepsForTests(deps) {
  testDeps = deps;
}

/**
 * The id a server skill goes by in a chat: `<installation>:<name>`.
 *
 * @param {string} instanceId
 * @param {string} name
 * @returns {string}
 */
export function serverSkillId(instanceId, name) {
  return `${instanceId}${SERVER_SKILL_SEPARATOR}${name}`;
}

/**
 * The installation and skill name of a server skill id, or null.
 *
 * @param {unknown} id
 * @returns {{instanceId: string, name: string}|null}
 */
export function parseServerSkillId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(SERVER_SKILL_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !SKILL_NAME_PATTERN.test(parts[1])) return null;
  return { instanceId: parts[0], name: parts[1] };
}

/** Whether `id` names a server skill (`<installation>:<name>`). */
export function isServerSkillId(id) {
  return parseServerSkillId(id) !== null;
}

/** Sort an object's keys, recursively, so equal values hash equally. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map(key => [key, canonical(value[key])])
    );
  }
  return value;
}

/**
 * One digest over what an approval binds to: the `SKILL.md` URI, the
 * frontmatter and every file's URI, digest and size.
 *
 * @param {{uri: string, frontmatter: Object, resources: Array<Object>}} skill
 * @returns {string} `sha256:<hex>`
 */
export function entryDigest(skill) {
  const resources = (Array.isArray(skill.resources) ? skill.resources : [])
    .map(({ uri, digest, size }) => ({ uri, digest, size }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  const text = JSON.stringify(
    canonical({ uri: skill.uri, frontmatter: skill.frontmatter, resources })
  );
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** The URI prefix of a skill's files: its `SKILL.md` URI without the file name. */
function rootOf(skill) {
  return skill.uri.endsWith(SKILL_FILE) ? skill.uri.slice(0, -SKILL_FILE.length) : skill.uri;
}

/**
 * The path of a skill file relative to the skill's root
 * (`references/FORMS.md`), the way `read_skill_resource` names it.
 *
 * @param {Object} skill
 * @param {string} uri
 * @returns {string}
 */
export function skillFilePath(skill, uri) {
  const root = rootOf(skill);
  return uri.startsWith(root) ? uri.slice(root.length) : uri;
}

/** The files of an approved skill besides `SKILL.md`, as relative paths. */
function bundledPaths(approval) {
  return approval.resources
    .map(resource => skillFilePath(approval, resource.uri))
    .filter(path => path !== SKILL_FILE);
}

/**
 * Why a listed skill cannot be approved, or null.
 *
 * @param {Object} skill - A `skills/list` entry
 * @param {Map<string, number>} nameCounts - How often each name is listed
 * @returns {string|null}
 */
function notApprovableReason(skill, nameCounts) {
  const name = skill.frontmatter?.name;
  if (!SKILL_NAME_PATTERN.test(name || '')) return 'invalid_name';
  if (nameCounts.get(name) > 1) return 'duplicate_name';
  // A "dynamic" skill has no file list to approve or to verify against.
  if (!Array.isArray(skill.resources)) return 'dynamic';
  return null;
}

/** The admin's view of one skill: what it is and where its approval stands. */
function skillItem(skill, approval, reason) {
  const listed = Boolean(skill);
  const source = skill || approval;
  const resources = Array.isArray(source.resources) ? source.resources : [];
  let status = 'available';
  if (reason) status = 'not_approvable';
  else if (approval && !listed) status = 'missing';
  else if (approval) status = entryDigest(approval) === entryDigest(skill) ? 'approved' : 'changed';
  return {
    name: source.frontmatter?.name,
    description: source.frontmatter?.description || '',
    uri: source.uri,
    // What an approval of this listing names (`approveInstallationSkill`).
    ...(listed ? { digest: entryDigest(skill) } : {}),
    status,
    ...(reason ? { reason } : {}),
    ...(Array.isArray(source.resources)
      ? {
          files: resources.map(resource => ({
            path: skillFilePath(source, resource.uri),
            size: resource.size
          })),
          size: resources.reduce((total, resource) => total + (resource.size || 0), 0)
        }
      : {}),
    ...(approval ? { approvedAt: approval.approvedAt } : {}),
    ...(approval?.approvedBy ? { approvedBy: approval.approvedBy } : {})
  };
}

/** The installation an admin works on, refused unless it is an MCP server. */
function mcpInstallation(instanceId, { manager, installations }) {
  const instance = installations.get(instanceId);
  if (!instance) {
    throw new ServiceError('INTEGRATION_NOT_FOUND', `Integration ${instanceId} not found`, {
      details: { instanceId }
    });
  }
  if (!manager.hasServer(instanceId)) {
    throw new ServiceError('SKILLS_NOT_SUPPORTED', `Integration ${instanceId} is no MCP server`, {
      details: { instanceId }
    });
  }
  return instance;
}

/** The server's listing through the admin's connection, refused when there is none. */
async function liveListing(instanceId, user, { manager }) {
  let listing;
  try {
    listing = await manager.withUserConnection(instanceId, user, conn => conn.listSkills());
  } catch (error) {
    // A per-user server the admin has not connected to: they sign in first.
    if (isAuthRequiredError(error)) {
      throw new ServiceError(
        'INTEGRATION_AUTH_REQUIRED',
        `Connect to ${instanceId} to see its skills`,
        { details: { instanceId } }
      );
    }
    throw new ServiceError('UPSTREAM_ERROR', `The skills of ${instanceId} could not be listed`, {
      details: { instanceId, reason: error.message }
    });
  }
  if (!listing) {
    throw new ServiceError(
      'SKILLS_NOT_SUPPORTED',
      `The MCP server ${instanceId} does not offer skills`,
      { details: { instanceId } }
    );
  }
  for (const entry of listing.invalid || []) {
    logger.warn('MCP server listed a skill it does not describe correctly; left out', {
      component: COMPONENT,
      serverId: instanceId,
      uri: entry.uri || null,
      reason: entry.reason
    });
  }
  return listing.skills;
}

/**
 * The skills an MCP server offers, with the approval of each, for the admin.
 * An approved skill the server no longer lists is included as `missing`.
 *
 * @param {string} instanceId
 * @param {Object} user - The admin (their own connection, for a per-user server)
 * @param {Object} [deps]
 * @returns {Promise<{items: Array<Object>}>}
 */
export async function listInstallationSkills(instanceId, user, deps = {}) {
  const d = await depsOf(deps);
  const instance = mcpInstallation(instanceId, d);
  const skills = await liveListing(instanceId, user, d);
  const approved = instance.skills?.approved || {};
  const nameCounts = new Map();
  for (const skill of skills) {
    const name = skill.frontmatter?.name;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const items = skills.map(skill => {
    const reason = notApprovableReason(skill, nameCounts);
    // A stored approval stays visible (and withdrawable) even when the skill
    // can no longer be approved.
    return skillItem(skill, approved[skill.frontmatter?.name], reason);
  });
  const listedNames = new Set(skills.map(skill => skill.frontmatter?.name));
  for (const [name, approval] of Object.entries(approved)) {
    if (!listedNames.has(name)) items.push(skillItem(null, approval, null));
  }
  return { items };
}

/**
 * Approve the skill `name` as the admin reviewed it: `options.digest` is the
 * item's `digest` from their listing, and a skill the server changed since is
 * refused (`SKILL_LISTING_CHANGED`) rather than approved unseen. Every file is
 * then read past the cache and verified: a skill the server cannot serve is
 * not approved.
 *
 * @param {string} instanceId
 * @param {string} name
 * @param {Object} user - The admin
 * @param {Object} [deps]
 * @param {Object} [options]
 * @param {string} [options.digest] - The reviewed entry's digest
 * @returns {Promise<Object>} the skill's item, `approved`
 */
export async function approveInstallationSkill(instanceId, name, user, deps = {}, options = {}) {
  const d = await depsOf(deps);
  mcpInstallation(instanceId, d);
  const skills = await liveListing(instanceId, user, d);
  const matches = skills.filter(skill => skill.frontmatter?.name === name);
  if (matches.length === 0) {
    throw new ServiceError('SERVER_SKILL_NOT_FOUND', `${instanceId} offers no skill "${name}"`, {
      details: { instanceId, name }
    });
  }
  // Only what the admin reviewed: a skill the server changed since their
  // listing is not approved in its place.
  if (matches.length === 1 && options.digest !== entryDigest(matches[0])) {
    throw new ServiceError(
      'SKILL_LISTING_CHANGED',
      `The skill "${name}" changed since it was listed; review it again`,
      { details: { instanceId, name } }
    );
  }
  const nameCounts = new Map([[name, matches.length]]);
  const reason = notApprovableReason(matches[0], nameCounts);
  if (reason) {
    throw new ServiceError('SKILL_NOT_APPROVABLE', `The skill "${name}" cannot be approved`, {
      details: { instanceId, name, reason }
    });
  }
  const skill = matches[0];
  const approval = {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
    approvedAt: new Date().toISOString(),
    ...(user?.id ? { approvedBy: String(user.id).slice(0, 200) } : {})
  };
  // What is approved must also be what the server serves.
  try {
    // One file after the other: an approval should not flood the server.
    await d.manager.withUserConnection(instanceId, user, conn =>
      approval.resources.reduce(
        (done, resource) =>
          // Past the cache: the server's bytes are checked against this entry.
          done.then(() =>
            readVerified(conn, instanceId, approval, skillFilePath(approval, resource.uri), {
              useCache: false
            })
          ),
        Promise.resolve()
      )
    );
  } catch (error) {
    throw new ServiceError('SKILL_UNREADABLE', `The files of "${name}" could not be verified`, {
      details: { instanceId, name, reason: error.message }
    });
  }
  const instance = await d.installations.setSkillApproval(instanceId, name, approval);
  return skillItem(skill, instance.skills?.approved?.[name] || approval, null);
}

/** Most characters of a file the admin reads before approving. */
const MAX_REVIEW_CHARS = 512 * 1024;

/**
 * One file of a skill as the server offers it now, for the admin to read
 * before approving: verified against the current listing, never cached. A file
 * the server sends as bytes only comes back without text.
 *
 * @param {string} instanceId
 * @param {string} name - The skill
 * @param {string} path - Path relative to the skill root (`SKILL.md`, `references/x.md`)
 * @param {Object} user - The admin
 * @param {Object} [deps]
 * @returns {Promise<{path: string, size: number, text?: string, truncated?: boolean}>}
 */
export async function readInstallationSkillFile(instanceId, name, path, user, deps = {}) {
  const d = await depsOf(deps);
  mcpInstallation(instanceId, d);
  const skills = await liveListing(instanceId, user, d);
  const matches = skills.filter(skill => skill.frontmatter?.name === name);
  const skill = matches.length === 1 && Array.isArray(matches[0].resources) ? matches[0] : null;
  const resource = skill?.resources.find(r => skillFilePath(skill, r.uri) === path);
  if (!resource) {
    throw new ServiceError('SERVER_SKILL_NOT_FOUND', `${instanceId} offers no file "${path}"`, {
      details: { instanceId, name, path }
    });
  }
  let file;
  try {
    file = await d.manager.withUserConnection(instanceId, user, conn =>
      conn.readSkillFile(skill, path)
    );
  } catch (error) {
    throw new ServiceError('SKILL_UNREADABLE', `"${path}" could not be read`, {
      details: { instanceId, name, path, reason: error.message }
    });
  }
  const text = typeof file.text === 'string' ? file.text : null;
  return {
    path,
    size: resource.size,
    ...(text === null ? {} : { text: text.slice(0, MAX_REVIEW_CHARS) }),
    ...(text !== null && text.length > MAX_REVIEW_CHARS ? { truncated: true } : {})
  };
}

/**
 * Withdraw the approval of the skill `name`.
 *
 * @param {string} instanceId
 * @param {string} name
 * @param {Object} [deps]
 */
export async function revokeInstallationSkill(instanceId, name, deps = {}) {
  const d = await depsOf(deps);
  const instance = mcpInstallation(instanceId, d);
  if (!instance.skills?.approved?.[name]) {
    throw new ServiceError('SERVER_SKILL_NOT_FOUND', `"${name}" is not approved on ${instanceId}`, {
      details: { instanceId, name }
    });
  }
  await d.installations.setSkillApproval(instanceId, name, null);
}

/** Keep a verified file, dropping the oldest past the cache's bounds. */
function remember(key, text) {
  const size = Buffer.byteLength(text, 'utf8');
  if (size > CACHE_MAX_BYTES) return;
  fileCache.delete(key);
  fileCache.set(key, text);
  cacheBytes += size;
  for (const [oldest, value] of fileCache) {
    if (fileCache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
    fileCache.delete(oldest);
    cacheBytes -= Buffer.byteLength(value, 'utf8');
  }
}

/**
 * Read one file of an approved skill, verified against the approval, from
 * the cache when it holds that digest. `SKILL.md` comes back as its body
 * (without the frontmatter); a file the server sent as bytes only, as null.
 */
async function readVerified(conn, instanceId, approval, path, { useCache = true } = {}) {
  const resource = approval.resources.find(r => skillFilePath(approval, r.uri) === path);
  if (!resource) return null;
  const kind = path === SKILL_FILE ? 'body' : 'text';
  // Per file too: two files with the same bytes share a digest, and a server
  // may still serve one and refuse the other.
  const key = `${instanceId}\n${connectionKeyOf(conn)}\n${resource.uri}\n${resource.digest}\n${kind}`;
  if (useCache && fileCache.has(key)) return fileCache.get(key);
  const file = await conn.readSkillFile(approval, path);
  const text = path === SKILL_FILE ? (file.body ?? '') : (file.text ?? null);
  if (typeof text === 'string') remember(key, text);
  return text;
}

/** Test seam. */
export function clearServerSkillCache() {
  fileCache.clear();
  cacheBytes = 0;
}

/**
 * The approved server skills `user` may use in `app`: of the installations
 * the app binds, enabled and granted to the user. An agent node
 * (`_skillIds`) names its skills itself and gets none.
 *
 * @param {Object} options
 * @param {Object} [options.app]
 * @param {Object} options.user
 * @param {Object} [options.deps]
 * @returns {Promise<Array<{id: string, instanceId: string, name: string, serverName: string,
 *   description: string, modelInvocable: boolean, approval: Object}>>}
 */
export async function usableServerSkills({ app, user, deps = {} }) {
  if (!app || app._skillIds) return [];
  const d = await depsOf(deps);
  const skills = [];
  for (const instanceId of d.boundInstanceIds(app)) {
    const instance = d.installations.get(instanceId);
    const approved = instance?.skills?.approved;
    if (!approved || instance.enabled === false || !d.manager.hasServer(instanceId)) continue;
    if (!d.userMayUse(instance, user)) continue;
    for (const [name, approval] of Object.entries(approved)) {
      skills.push({
        id: serverSkillId(instanceId, name),
        instanceId,
        name,
        serverName: instance.label || instanceId,
        description: approval.frontmatter.description || '',
        // Started by users only, as `disable-model-invocation` asks.
        modelInvocable: approval.frontmatter['disable-model-invocation'] !== true,
        approval
      });
    }
  }
  return skills;
}

/**
 * Load a server skill `user` may use in `app`: its instructions, its files
 * and the reader for them, each verified against the approval. Null when it
 * may not be used, or the server no longer serves what was approved.
 *
 * @param {string} id - `<installation>:<name>`
 * @param {Object} options
 * @param {Object} options.app
 * @param {Object} options.user
 * @param {Object} [options.deps]
 * @returns {Promise<Object|null>} the shape `skillAccess.loadUsableSkill` returns
 */
export async function loadServerSkill(id, { app, user, deps = {} }) {
  const skill = (await usableServerSkills({ app, user, deps })).find(entry => entry.id === id);
  if (!skill) return null;
  const d = await depsOf(deps);
  // Still what was approved? A server that changed the skill — even a file a
  // cached copy would cover — gets it refused until an admin approves again.
  let current;
  try {
    const listing = await d.manager.withUserConnection(skill.instanceId, user, conn =>
      conn.listSkills({ maxAgeMs: LISTING_MAX_AGE_MS })
    );
    current = listing?.skills.find(entry => entry.frontmatter?.name === skill.name);
  } catch (error) {
    logUnloadable(skill, 'skills/list', error);
    return null;
  }
  if (!current || entryDigest(current) !== entryDigest(skill.approval)) {
    logger.warn('MCP server skill changed since it was approved; not loaded', {
      component: COMPONENT,
      serverId: skill.instanceId,
      skill: skill.name,
      reason: current ? 'changed' : 'missing'
    });
    return null;
  }
  const read = path =>
    d.manager.withUserConnection(skill.instanceId, user, conn =>
      readVerified(conn, skill.instanceId, skill.approval, path)
    );
  let body;
  try {
    body = await read(SKILL_FILE);
  } catch (error) {
    logUnloadable(skill, SKILL_FILE, error);
    return null;
  }
  return {
    name: skill.id,
    displayName: skill.name,
    description: skill.description,
    body: body ?? '',
    resources: bundledPaths(skill.approval),
    modelInvocable: skill.modelInvocable,
    readFile: async path => {
      try {
        return await read(path);
      } catch (error) {
        logUnloadable(skill, path, error);
        return null;
      }
    }
  };
}

function logUnloadable(skill, path, error) {
  const changed = error instanceof SkillVerificationError;
  logger.warn(
    changed
      ? 'MCP server skill changed since it was approved; not loaded'
      : 'MCP server skill could not be read',
    {
      component: COMPONENT,
      serverId: skill.instanceId,
      skill: skill.name,
      path,
      ...(changed ? { reason: error.reason } : { error: error.message })
    }
  );
}
