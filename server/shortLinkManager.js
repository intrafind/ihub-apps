import crypto from 'crypto';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { createDebouncedJsonStore } from './utils/debouncedJsonStore.js';

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

export async function createLink({
  code,
  appId,
  userId,
  path = null,
  params = null,
  url = null,
  includeParams = false,
  expiresAt = null
}) {
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

  let finalUrl = url;
  if (!finalUrl) {
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
    finalUrl = dummy.pathname + (dummy.search ? `?${dummy.searchParams.toString()}` : '');
  }

  const link = {
    code: finalCode,
    appId,
    userId,
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

export async function getLink(code) {
  const links = await store.load();
  return links.links.find(l => l.code === code);
}

export async function isCodeAvailable(code) {
  const links = await store.load();
  return !links.links.some(l => l.code === code);
}

export async function recordUsage(code) {
  const links = await store.load();
  const link = links.links.find(l => l.code === code);
  if (link) {
    link.usage = (link.usage || 0) + 1;
    link.lastUsed = now();
    store.markDirty();
  }
  return link;
}

export async function deleteLink(code) {
  const links = await store.load();
  const idx = links.links.findIndex(l => l.code === code);
  if (idx !== -1) {
    links.links.splice(idx, 1);
    store.markDirty();
    return true;
  }
  return false;
}

export async function updateLink(code, data) {
  const links = await store.load();
  const link = links.links.find(l => l.code === code);
  if (!link) return null;
  Object.assign(link, data, { code });
  store.markDirty();
  return link;
}

export async function searchLinks({ appId, userId } = {}) {
  const links = await store.load();
  return links.links.filter(l => (!appId || l.appId === appId) && (!userId || l.userId === userId));
}

store.load();
