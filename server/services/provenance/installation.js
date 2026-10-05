/**
 * Identity of this installation — the "where" in every record iHub keeps for
 * the EU AI Act (disclosure opt-outs, exemptions, acknowledgements,
 * dismissals) and in every manifest it signs.
 *
 * The installation id is a random UUID in `contents/.installation-id`,
 * created on first use. Workers of one installation share the contents
 * directory and so share the id. A backup export leaves the file out and an
 * import keeps the live one, so an id never travels to another installation:
 * records carrying a foreign id are ignored (see `isRecordForThisInstallation`).
 *
 * @module services/provenance/installation
 */
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import configCache from '../../configCache.js';
import { getRootDir } from '../../pathUtils.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import logger from '../../utils/logger.js';

export const INSTALLATION_ID_FILE = '.installation-id';
const ID_RE = /^[0-9a-f-]{36}$/;

let cachedId = null;

function idFilePath() {
  return path.join(getRootDir(), config.CONTENTS_DIR, INSTALLATION_ID_FILE);
}

function readIdSync() {
  try {
    const value = readFileSync(idFilePath(), 'utf8').trim();
    return ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Create the id file if it does not exist yet. Exclusive create, so two
 * workers starting together agree on one id.
 * @returns {Promise<string>}
 */
export async function ensureInstallationId() {
  const existing = readIdSync();
  if (existing) {
    cachedId = existing;
    return existing;
  }
  // An id already handed out in memory (see getInstallationId) is the one to
  // persist, so records stamped with it stay this installation's.
  const fresh = cachedId || randomUUID();
  const file = idFilePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${fresh}\n`, { flag: 'wx', mode: 0o644 });
    cachedId = fresh;
    logger.info('Created installation id', { component: 'Provenance', installationId: fresh });
    return fresh;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      logger.warn('Could not persist installation id; using an in-memory id', {
        component: 'Provenance',
        error: error.message
      });
      cachedId = cachedId || fresh;
      return cachedId;
    }
    const winner = readIdSync();
    cachedId = winner || fresh;
    return cachedId;
  }
}

/**
 * The installation id. Reads the file on first call; `ensureInstallationId()`
 * runs at startup, so this is normally cached.
 * @returns {string}
 */
export function getInstallationId() {
  if (cachedId) return cachedId;
  cachedId = readIdSync();
  if (!cachedId) {
    // Not created yet (early call, read-only contents): an in-memory id keeps
    // records self-consistent for this process; startup persists one.
    cachedId = randomUUID();
    ensureInstallationId().catch(() => {});
  }
  return cachedId;
}

/** Test hook: forget the cached id. */
export function _resetInstallationIdCache() {
  cachedId = null;
}

/**
 * Public base URL of this installation: the configured
 * `aiTransparency.installationUrl`, else the MCP public URL, else the
 * request's forwarded origin.
 * @param {import('express').Request} [req]
 * @returns {string}
 */
export function getInstallationUrl(req) {
  const platform = configCache.getPlatform() || {};
  const configured = platform.aiTransparency?.installationUrl || platform.mcpServer?.publicUrl;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim().replace(/\/+$/, '');
  }
  if (req) {
    try {
      return buildPublicBaseUrl(req).replace(/\/+$/, '');
    } catch {
      /* fall through */
    }
  }
  return '';
}

/**
 * `{ installationId, installationUrl, ihubVersion }` for records and manifests.
 * @param {import('express').Request} [req]
 */
export function getInstallationInfo(req) {
  return {
    installationId: getInstallationId(),
    installationUrl: getInstallationUrl(req),
    ihubVersion: getAppVersion()
  };
}

/**
 * The acting admin as recorded in an installation record.
 * @param {import('express').Request} req
 * @returns {{id: string, name: string}}
 */
export function actorOf(req) {
  const user = req?.user || {};
  const id = String(user.id || user.username || 'unknown');
  const name = String(user.name || user.username || user.email || id);
  return { id, name };
}

/**
 * Whether a stored record was made for this installation. A record copied in
 * from elsewhere (a hand-edited file, a restored foreign backup) does not
 * count: the admin of this installation has to decide again.
 * @param {Object} record
 * @returns {boolean}
 */
export function isRecordForThisInstallation(record) {
  if (!record || typeof record !== 'object') return false;
  return typeof record.installationId === 'string' && record.installationId === getInstallationId();
}
