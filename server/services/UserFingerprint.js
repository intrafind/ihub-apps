// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../utils/logger.js';
import { getContentsPath } from '../utils/contentsPath.js';

const pepperFile = getContentsPath('.usage-pepper');

let pepper = null;

const PEPPER_PATTERN = /^[0-9a-f]{64}$/;

async function readPepper() {
  try {
    const value = (await fs.readFile(pepperFile, 'utf8')).trim();
    return PEPPER_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The pepper every worker shares. Created with an exclusive publish (a complete
 * temp file linked into place, which fails if another worker got there first),
 * and the winner's value is re-read: workers that each wrote their own pepper
 * produced different fingerprints for the same user, and a half-written file
 * read as an empty pepper.
 */
async function loadOrCreatePepper() {
  if (pepper) return pepper;
  const existing = await readPepper();
  if (existing) {
    pepper = existing;
    return pepper;
  }

  await fs.mkdir(path.dirname(pepperFile), { recursive: true });
  const candidate = crypto.randomBytes(32).toString('hex');
  const tmpPath = `${pepperFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmpPath, candidate, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await fs.link(tmpPath, pepperFile);
      logger.info('Created new usage tracking pepper', { component: 'UserFingerprint' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another worker published first. If what it left is unusable (a file an
      // older version wrote empty), replace it with this complete one.
      if (!(await readPepper())) await fs.rename(tmpPath, pepperFile);
    }
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
  pepper = (await readPepper()) || candidate;
  return pepper;
}

/**
 * Create a one-way fingerprint from a user identifier.
 * Returns a deterministic, irreversible hash prefixed with "usr_".
 * Same userId always produces the same fingerprint.
 */
export async function fingerprint(userId) {
  if (!userId) return null;
  const p = await loadOrCreatePepper();
  const hash = crypto
    .createHash('sha256')
    .update(userId + p)
    .digest('hex');
  return `usr_${hash.substring(0, 16)}`;
}

/**
 * Hash a conversation/chat ID for anonymous tracking.
 */
export async function fingerprintConversation(chatId) {
  if (!chatId) return null;
  const p = await loadOrCreatePepper();
  const hash = crypto
    .createHash('sha256')
    .update(chatId + p)
    .digest('hex');
  return `conv_${hash.substring(0, 16)}`;
}

/**
 * Resolve user identity based on tracking mode.
 * - "anonymous": one-way SHA-256 fingerprint
 * - "pseudonymous": session ID as-is (current behavior)
 * - "identified": real userId as-is
 */
export async function resolveUserId(userId, mode = 'pseudonymous') {
  switch (mode) {
    case 'anonymous':
      return fingerprint(userId);
    case 'identified':
      return userId;
    case 'pseudonymous':
    default:
      return userId;
  }
}
