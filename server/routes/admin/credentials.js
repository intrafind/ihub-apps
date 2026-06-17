import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest, sendNotFound } from '../../utils/responseHelpers.js';
import { logAdminAction } from '../../services/AuditLogService.js';
import { validateCredential, SECRET_FIELDS_BY_TYPE } from '../../validators/credentialSchema.js';

/**
 * Admin CRUD routes for the central credential store
 * (`contents/config/credentials.json`).
 *
 * Profiles are named, typed auth credentials referenced elsewhere via
 * `credentialRef`. Secret-bearing fields (per {@link SECRET_FIELDS_BY_TYPE})
 * are encrypted at rest with {@link tokenStorageService} and never returned to
 * the client in plaintext — reads redact them to '***REDACTED***' while
 * preserving `${ENV}` placeholders.
 *
 * @module routes/admin/credentials
 */

const REDACTED = '***REDACTED***';
const COMPONENT = 'AdminCredentials';

/**
 * Absolute path to the credential store file.
 * @returns {string}
 */
function getCredentialsFilePath() {
  return join(getRootDir(), 'contents', 'config', 'credentials.json');
}

/**
 * Check whether a value is an environment variable placeholder (e.g. `${VAR}`).
 * @param {string} value
 * @returns {boolean}
 */
function isEnvVarPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /^\$\{[^}]+\}$/.test(value);
}

/**
 * Encrypt a secret value unless it is empty, an env-var placeholder, or already
 * encrypted. Mirrors the guard used in `routes/admin/configs.js`.
 * @param {string} value
 * @returns {string} Encrypted value or the original when skipped
 */
function encryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (isEnvVarPlaceholder(value)) return value;
  if (tokenStorageService.isEncrypted(value)) return value;
  return tokenStorageService.encryptString(value);
}

/**
 * Produce a redacted copy of a credential profile for API responses.
 * Secret fields become '***REDACTED***' while `${ENV}` placeholders are kept so
 * admins can see when a secret is sourced from the environment.
 * @param {object} profile - Decrypted (or on-disk) credential profile
 * @returns {object} Redacted shallow copy
 */
function redactProfile(profile) {
  const out = { ...profile };
  const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
  for (const field of secretFields) {
    if (out[field] === undefined || out[field] === null || out[field] === '') continue;
    out[field] = isEnvVarPlaceholder(out[field]) ? out[field] : REDACTED;
  }
  return out;
}

/**
 * Read the raw (on-disk, possibly encrypted) credential store.
 * Missing/empty store is treated as `{ credentials: {} }`.
 * @returns {Promise<{ credentials: Record<string, object> }>}
 */
async function readStore() {
  try {
    const raw = await fs.readFile(getCredentialsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.credentials) {
      return { credentials: {} };
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { credentials: {} };
    throw error;
  }
}

/**
 * Atomically persist the credential store and refresh the in-memory cache.
 * @param {{ credentials: Record<string, object> }} store
 * @returns {Promise<void>}
 */
async function writeStore(store) {
  await atomicWriteJSON(getCredentialsFilePath(), store);
  await configCache.refreshCredentialsCache();
}

/**
 * Resolve the admin identity for audit logging.
 * @param {import('express').Request} req
 * @returns {string}
 */
function adminIdentity(req) {
  return req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown';
}

export default function registerAdminCredentialsRoutes(app) {
  // List all credential profiles (secrets redacted).
  app.get(buildServerPath('/api/admin/credentials'), adminAuth, async (req, res) => {
    try {
      const store = await readStore();
      const credentials = Object.entries(store.credentials || {}).map(([id, profile]) =>
        redactProfile({ ...profile, id })
      );
      res.json({ credentials });
    } catch (error) {
      return sendInternalError(res, error, 'list credentials');
    }
  });

  // Get a single credential profile (secrets redacted).
  app.get(buildServerPath('/api/admin/credentials/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'credential', res)) return;
      const store = await readStore();
      const profile = store.credentials?.[id];
      if (!profile) return sendNotFound(res, 'Credential');
      res.json(redactProfile({ ...profile, id }));
    } catch (error) {
      return sendInternalError(res, error, 'get credential');
    }
  });

  // Create a new credential profile.
  app.post(buildServerPath('/api/admin/credentials'), adminAuth, async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return sendBadRequest(res, 'Invalid credential data');
      }

      const validation = validateCredential(body);
      if (!validation.success) {
        return sendBadRequest(res, 'Invalid credential configuration', validation.errors);
      }
      const profile = validation.data;

      const store = await readStore();
      if (store.credentials?.[profile.id]) {
        return res.status(409).json({ error: 'Credential id already exists' });
      }

      // Encrypt secret fields before writing.
      const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
      for (const field of secretFields) {
        if (profile[field]) profile[field] = encryptIfNeeded(profile[field]);
      }

      store.credentials = { ...(store.credentials || {}), [profile.id]: profile };
      await writeStore(store);

      await logAdminAction({
        req,
        action: 'create',
        resource: 'credential',
        resourceId: profile.id,
        summary: `Created credential profile "${profile.id}" (${profile.type})`
      });

      logger.info('Credential profile created', {
        component: COMPONENT,
        id: profile.id,
        type: profile.type,
        admin: adminIdentity(req)
      });

      res.status(201).json(redactProfile(profile));
    } catch (error) {
      return sendInternalError(res, error, 'create credential');
    }
  });

  // Update an existing credential profile.
  app.put(buildServerPath('/api/admin/credentials/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'credential', res)) return;

      const store = await readStore();
      const existing = store.credentials?.[id];
      if (!existing) return sendNotFound(res, 'Credential');

      // Force the path id onto the body so it cannot be changed via the payload.
      const incoming = { ...req.body, id };

      // Restore redacted secrets from the existing (encrypted) profile before
      // validation, so the redaction marker never reaches disk and unchanged
      // secrets are preserved without re-typing.
      const incomingSecretFields = SECRET_FIELDS_BY_TYPE[incoming.type] || [];
      for (const field of incomingSecretFields) {
        if (incoming[field] === REDACTED) {
          // Only restore when the type is unchanged (the field maps cleanly).
          incoming[field] = existing.type === incoming.type ? existing[field] : undefined;
        }
      }

      const validation = validateCredential(incoming);
      if (!validation.success) {
        return sendBadRequest(res, 'Invalid credential configuration', validation.errors);
      }
      const profile = validation.data;

      // Re-encrypt any changed (plaintext) secret fields. Values restored from
      // disk are already ENC[...] and skipped by the guard.
      const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
      for (const field of secretFields) {
        if (profile[field]) profile[field] = encryptIfNeeded(profile[field]);
      }

      store.credentials[id] = profile;
      await writeStore(store);

      await logAdminAction({
        req,
        action: 'update',
        resource: 'credential',
        resourceId: id,
        summary: `Updated credential profile "${id}" (${profile.type})`
      });

      logger.info('Credential profile updated', {
        component: COMPONENT,
        id,
        type: profile.type,
        admin: adminIdentity(req)
      });

      res.json(redactProfile(profile));
    } catch (error) {
      return sendInternalError(res, error, 'update credential');
    }
  });

  // Delete a credential profile.
  app.delete(buildServerPath('/api/admin/credentials/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'credential', res)) return;

      const store = await readStore();
      if (!store.credentials?.[id]) return sendNotFound(res, 'Credential');

      delete store.credentials[id];
      await writeStore(store);

      await logAdminAction({
        req,
        action: 'delete',
        resource: 'credential',
        resourceId: id,
        summary: `Deleted credential profile "${id}"`
      });

      logger.info('Credential profile deleted', {
        component: COMPONENT,
        id,
        admin: adminIdentity(req)
      });

      res.status(204).end();
    } catch (error) {
      return sendInternalError(res, error, 'delete credential');
    }
  });
}
