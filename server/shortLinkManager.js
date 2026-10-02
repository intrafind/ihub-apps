import crypto from 'crypto';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { createDebouncedJsonStore } from './utils/debouncedJsonStore.js';
import { isAllowedShortLinkTarget } from './utils/shortLinkTarget.js';

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'shortlinks.json');

const now = () => new Date().toISOString();

function createDefault() {
  return { links: [], lastUpdated: now() };
}

const store = createDebouncedJsonStore({
  filePath: dataFile,
  createDefault,
  component: 'ShortLinkManager',
  onBeforeSave: data => {
    data.lastUpdated = now();
  }
});

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

  const links = await store.load();
  let finalCode = code;
  if (finalCode) {
    if (links.links.some(l => l.code === finalCode)) {
      throw new Error('Code already exists');
    }
  } else {
    do {
      finalCode = generateCode();
    } while (links.links.some(l => l.code === finalCode));
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
  links.links.push(link);
  store.markDirty();
  return link;
}

/**
 * Look up a link by code, reloading from disk once on a miss. Under
 * WORKERS > 1 the code may have been created by a different worker after
 * this process last loaded (or reloaded) the store — without this, that
 * worker's in-memory copy never learns about it and every request routed
 * here 404s forever, even though the link exists on disk. A genuine miss
 * (never existed, or was deleted) costs exactly one extra disk read.
 */
async function findByCode(code) {
  const links = await store.load();
  const local = links.links.find(l => l.code === code);
  if (local) return local;
  const fresh = await store.reload();
  return fresh.links.find(l => l.code === code);
}

export async function getLink(code) {
  return findByCode(code);
}

export async function isCodeAvailable(code) {
  return !(await findByCode(code));
}

export async function recordUsage(code) {
  const link = await findByCode(code);
  if (link) {
    link.usage = (link.usage || 0) + 1;
    link.lastUsed = now();
    store.markDirty();
  }
  return link;
}

export async function deleteLink(code) {
  const link = await findByCode(code);
  if (!link) return false;
  const links = await store.load();
  const idx = links.links.indexOf(link);
  if (idx !== -1) {
    links.links.splice(idx, 1);
    store.markDirty();
    return true;
  }
  return false;
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
  const link = await findByCode(code);
  if (!link) return null;
  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (data && Object.hasOwn(data, field)) changes[field] = data[field];
  }
  if (Object.hasOwn(changes, 'includeParams')) {
    changes.includeParams = changes.includeParams === true;
  }
  const next = { ...link, ...changes };
  if (!next.url) next.url = buildTarget(next);
  if (!isAllowedShortLinkTarget(next.url, allowedHosts)) {
    throw new ShortLinkTargetError();
  }
  Object.assign(link, changes, { url: next.url });
  store.markDirty();
  return link;
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
  const links = await store.load();
  return links.links.filter(
    l => (!appId || l.appId === appId) && (!ownerId || l.ownerId === ownerId)
  );
}

store.load();
