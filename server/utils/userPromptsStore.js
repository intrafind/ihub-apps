/**
 * User Prompts Store
 *
 * Per-user prompt files under contents/data/user-prompts/<userId>/<promptId>.json,
 * separate from the admin-curated contents/prompts/ library (which is scanned
 * wholesale by promptsLoader.js and gated behind contentAdminAuth). One file
 * per prompt, one directory per owning user.
 *
 * userId comes straight from req.user.id (local username, OIDC subject, LDAP
 * username, or a proxy-auth header value) so it's treated as untrusted input:
 * validated against the same safe-filename allowlist TokenStorageService.js
 * uses for its per-user token files, then re-checked to stay inside its
 * parent directory before any fs call.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getRootDir } from '../pathUtils.js';
import { atomicWriteJSON, atomicCreateJSON } from './atomicWrite.js';
import { isValidId } from './pathSecurity.js';

const USER_PROMPTS_DIR = 'data/user-prompts';
const USER_ID_PATTERN = /^[A-Za-z0-9._@+-]+$/;

function baseDir() {
  return path.join(getRootDir(), 'contents', USER_PROMPTS_DIR);
}

function isSafeUserId(userId) {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId.length <= 256 &&
    USER_ID_PATTERN.test(userId) &&
    !/^\.+$/.test(userId) // reject "." / ".." even though the charset allows dots
  );
}

/**
 * Joins `segment` onto `base` and asserts the result still resolves inside
 * `base`. Safe to call before `base`/the target exist on disk (unlike
 * pathSecurity.js's resolveAndValidatePath, which requires an existing
 * ancestor to realpath against).
 */
function resolveWithinBase(base, segment) {
  const resolvedBase = path.resolve(base);
  const candidate = path.resolve(resolvedBase, segment);
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (candidate !== resolvedBase && !candidate.startsWith(baseWithSep)) {
    throw new Error('Resolved user-prompt path escapes its base directory');
  }
  return candidate;
}

function userDir(userId) {
  if (!isSafeUserId(userId)) {
    throw new Error('Invalid user id');
  }
  return resolveWithinBase(baseDir(), userId);
}

function promptFilePath(userId, promptId) {
  if (!isValidId(promptId)) {
    throw new Error('Invalid prompt id');
  }
  return resolveWithinBase(userDir(userId), `${promptId}.json`);
}

async function readPromptFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} userId
 * @returns {Promise<Array>} All prompts owned by userId (private + shared).
 */
export async function listOwnUserPrompts(userId) {
  const dir = userDir(userId);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const prompts = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const record = await readPromptFile(path.join(dir, entry));
    if (record) prompts.push(record);
  }
  return prompts;
}

/**
 * Scans every other user's directory for prompts marked visibility: 'shared'.
 * @param {string} excludeUserId - Owner to skip (their own prompts are listed via listOwnUserPrompts)
 * @returns {Promise<Array>}
 */
export async function listSharedUserPrompts(excludeUserId) {
  let userDirEntries;
  try {
    userDirEntries = await fs.readdir(baseDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const prompts = [];
  for (const entry of userDirEntries) {
    if (!entry.isDirectory() || entry.name === excludeUserId) continue;
    if (!isSafeUserId(entry.name)) continue;
    const dir = path.join(baseDir(), entry.name);
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const record = await readPromptFile(path.join(dir, file));
      if (record && record.visibility === 'shared') {
        prompts.push(record);
      }
    }
  }
  return prompts;
}

/**
 * @param {string} userId - Owner directory to look in (only ever the caller's own)
 * @param {string} promptId
 * @returns {Promise<Object|null>}
 */
export async function getUserPrompt(userId, promptId) {
  return readPromptFile(promptFilePath(userId, promptId));
}

/**
 * @param {string} userId
 * @param {{name:string, description?:string, prompt:string, category?:string, visibility?:string}} data
 * @returns {Promise<Object>} The created record
 */
export async function createUserPrompt(userId, data) {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    ownerId: userId,
    name: data.name,
    description: data.description || '',
    prompt: data.prompt,
    category: data.category,
    visibility: data.visibility || 'private',
    enabled: true,
    createdBy: userId,
    createdAt: now,
    lastModifiedBy: userId,
    lastModifiedAt: now
  };
  await atomicCreateJSON(resolveWithinBase(dir, `${id}.json`), record);
  return record;
}

/**
 * @param {string} userId
 * @param {string} promptId
 * @param {{name:string, description?:string, prompt:string, category?:string, visibility?:string}} data
 * @returns {Promise<Object|null>} The updated record, or null if it doesn't exist
 */
export async function updateUserPrompt(userId, promptId, data) {
  const filePath = promptFilePath(userId, promptId);
  const existing = await readPromptFile(filePath);
  if (!existing) return null;
  const updated = {
    ...existing,
    name: data.name,
    description: data.description || '',
    prompt: data.prompt,
    category: data.category,
    visibility: data.visibility || existing.visibility || 'private',
    lastModifiedBy: userId,
    lastModifiedAt: new Date().toISOString()
  };
  await atomicWriteJSON(filePath, updated);
  return updated;
}

/**
 * @param {string} userId
 * @param {string} promptId
 * @returns {Promise<boolean>} True if a file was deleted, false if it didn't exist
 */
export async function deleteUserPrompt(userId, promptId) {
  const filePath = promptFilePath(userId, promptId);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
