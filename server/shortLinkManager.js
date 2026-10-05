import crypto from 'crypto';
import { createSharedJsonFile } from './utils/sharedJsonFile.js';
import { isAllowedShortLinkTarget } from './utils/shortLinkTarget.js';
import { getContentsPath } from './utils/contentsPath.js';

const dataFile = getContentsPath('data', 'shortlinks.json');

const now = () => new Date().toISOString();

function createDefault() {
  return { links: [], lastUpdated: now() };
}

// Shared by every cluster worker: each change is made to the file on disk
// under a lock, and reads see changes another worker made.
const store = createSharedJsonFile({
  filePath: dataFile,
  createDefault,
  component: 'ShortLinkManager'
});

/** Apply `mutate` to the links on disk and save, stamping lastUpdated. */
function updateLinks(mutate) {
  return store.update(data => {
    if (!Array.isArray(data.links)) data.links = [];
    const result = mutate(data);
    data.lastUpdated = now();
    return result;
  });
}

async function readLinks() {
  const data = await store.read();
  return Array.isArray(data?.links) ? data.links : [];
}

export function isLinkExpired(link) {
  if (!link || !link.expiresAt) return false;
  return new Date(link.expiresAt) <= new Date();
}

function generateCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charLength = chars.length; // 62
  // Rejection sampling eliminates modulo bias: only accept bytes in [0, maxUnbiased)
  // where maxUnbiased is the largest multiple of charLength fitting in a byte (248 = 4 * 62).
  // Each accepted byte maps to exactly one of the 62 characters with equal probability.
  const maxUnbiased = Math.floor(256 / charLength) * charLength;
  let code = '';
  while (code.length < length) {
    const bytes = crypto.randomBytes(length + 10);
    for (let i = 0; i < bytes.length && code.length < length; i++) {
      if (bytes[i] < maxUnbiased) {
        code += chars[bytes[i] % charLength];
      }
    }
  }
  return code;
}

/** A link's target could not be accepted (see utils/shortLinkTarget.js). */
export class ShortLinkTargetError extends Error {
  constructor(message = 'Short link target is not allowed') {
    super(message);
    this.name = 'ShortLinkTargetError';
    this.code = 'SHORT_LINK_TARGET_NOT_ALLOWED';
  }
}

/** The fields a link's owner (or an admin) may change after creation. */
const EDITABLE_FIELDS = ['appId', 'path', 'params', 'url', 'includeParams', 'expiresAt'];

/**
 * The target built from an app or path, plus the settings when included.
 *
 * @returns {string}
 */
function buildTarget({ appId, path, params, includeParams }) {
  const basePath = path || (appId ? `/apps/${appId}` : '/');
  const dummy = new URL('http://localhost');
  dummy.pathname = basePath;
  if (includeParams && params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        dummy.searchParams.set(k, String(v));
      }
    }
  }
  return dummy.pathname + (dummy.search ? `?${dummy.searchParams.toString()}` : '');
}

/**
 * Create a link owned by `ownerId`.
 *
 * @param {Object} data
 * @param {Object} [options]
 * @param {string[]} [options.allowedHosts] - Hosts an absolute `url` may name
 * @throws {ShortLinkTargetError} When the target is not allowed
 */
export async function createLink(
  {
    code,
    appId,
    ownerId,
    path = null,
    params = null,
    url = null,
    includeParams = false,
    expiresAt = null
  },
  { allowedHosts = [] } = {}
) {
  const finalUrl = url || buildTarget({ appId, path, params, includeParams });
  if (!isAllowedShortLinkTarget(finalUrl, allowedHosts)) {
    throw new ShortLinkTargetError();
  }

  return updateLinks(data => {
    let finalCode = code;
    if (finalCode) {
      if (data.links.some(l => l.code === finalCode)) {
        throw new Error('Code already exists');
      }
    } else {
      do {
        finalCode = generateCode();
      } while (data.links.some(l => l.code === finalCode));
    }

    const link = {
      code: finalCode,
      appId,
      ownerId,
      path,
      params,
      url: finalUrl,
      includeParams,
      createdAt: now(),
      usage: 0,
      expiresAt
    };
    data.links.push(link);
    return { ...link };
  });
}

async function findByCode(code) {
  return (await readLinks()).find(l => l.code === code);
}

export async function getLink(code) {
  return findByCode(code);
}

export async function isCodeAvailable(code) {
  return !(await findByCode(code));
}

export async function recordUsage(code) {
  if (!(await findByCode(code))) return undefined;
  return updateLinks(data => {
    const link = data.links.find(l => l.code === code);
    if (!link) return undefined;
    link.usage = (link.usage || 0) + 1;
    link.lastUsed = now();
    return { ...link };
  });
}

export async function deleteLink(code) {
  if (!(await findByCode(code))) return false;
  return updateLinks(data => {
    const idx = data.links.findIndex(l => l.code === code);
    if (idx === -1) return false;
    data.links.splice(idx, 1);
    return true;
  });
}

/**
 * Change a link's editable fields. Everything else in `data` — the code, the
 * owner, usage counters — is ignored. A link left without a `url` gets one
 * built from its app or path again.
 *
 * @param {string} code
 * @param {Object} data
 * @param {Object} [options]
 * @param {string[]} [options.allowedHosts] - Hosts an absolute `url` may name
 * @returns {Promise<Object|null>} The updated link, or null when there is none
 * @throws {ShortLinkTargetError} When the resulting target is not allowed
 */
export async function updateLink(code, data, { allowedHosts = [] } = {}) {
  if (!(await findByCode(code))) return null;
  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (data && Object.hasOwn(data, field)) changes[field] = data[field];
  }
  if (Object.hasOwn(changes, 'includeParams')) {
    changes.includeParams = changes.includeParams === true;
  }
  return updateLinks(stored => {
    const link = stored.links.find(l => l.code === code);
    if (!link) return null;
    const next = { ...link, ...changes };
    if (!next.url) next.url = buildTarget(next);
    if (!isAllowedShortLinkTarget(next.url, allowedHosts)) {
      throw new ShortLinkTargetError();
    }
    Object.assign(link, changes, { url: next.url });
    return { ...link };
  });
}

/**
 * Whether `user` may see, change or delete `link`: its owner, or an admin.
 * A link stored without an owner is managed by admins only.
 *
 * @param {Object} link
 * @param {Object} user - `req.user`
 * @param {boolean} isAdmin - Whether `user` is an admin
 * @returns {boolean}
 */
export function canManageLink(link, user, isAdmin) {
  if (isAdmin) return true;
  return Boolean(link?.ownerId && user?.id && link.ownerId === user.id);
}

export async function searchLinks({ appId, ownerId } = {}) {
  const links = await readLinks();
  return links.filter(l => (!appId || l.appId === appId) && (!ownerId || l.ownerId === ownerId));
}
