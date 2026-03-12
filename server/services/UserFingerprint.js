import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const contentsDir = config.CONTENTS_DIR;
const pepperFile = path.join(getRootDir(), contentsDir, '.usage-pepper');

let pepper = null;

async function loadOrCreatePepper() {
  if (pepper) return pepper;
  try {
    pepper = await fs.readFile(pepperFile, 'utf8');
  } catch {
    pepper = crypto.randomBytes(32).toString('hex');
    await fs.mkdir(path.dirname(pepperFile), { recursive: true });
    await fs.writeFile(pepperFile, pepper, 'utf8');
    logger.info('Created new usage tracking pepper', { component: 'UserFingerprint' });
  }
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
