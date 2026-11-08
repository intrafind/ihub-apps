// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Personal API Key Routes
// Lets a signed-in user mint, rotate and revoke API credentials for themselves
// from Settings > Integrations, within the policy an administrator configured.

import express from 'express';
import { ServiceError } from '../../utils/ServiceError.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import { logAudit } from '../../services/AuditLogService.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import {
  buildPersonalKeyEndpoints,
  canUserManagePersonalKeys,
  createPersonalKey,
  getPersonalKey,
  getPersonalKeyConfig,
  isPersonalKeysEnabled,
  listPersonalKeys,
  revokePersonalKey,
  rotatePersonalKey
} from '../../utils/personalApiKeyManager.js';
import { sendCreated, segment } from '../../utils/created.js';

const router = express.Router();

// Gate all personal key routes behind the integrations feature flag
router.use(requireFeature('integrations'));

/**
 * Resolve the caller and the platform config, refusing anyone who may not
 * manage personal keys.
 *
 * `authRequired` still lets anonymous callers through when anonymous access is
 * enabled platform-wide, and it does not guarantee a truthy `req.user.id` — a
 * key minted under a blank or shared identity would be usable by anyone, so
 * both cases are rejected here.
 */
function requireKeyManager(req) {
  const platform = configCache.getPlatform() || {};

  if (!isPersonalKeysEnabled(platform)) {
    throw new ServiceError('NOT_FOUND', 'Personal API keys are not enabled');
  }

  if (!req.user?.id || req.user.id === 'anonymous') {
    throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  }

  if (!canUserManagePersonalKeys(req.user, platform)) {
    throw new ServiceError('FORBIDDEN', 'You are not allowed to create API keys');
  }

  return { platform, user: req.user };
}

/**
 * @swagger
 * /api/integrations/api-keys:
 *   get:
 *     summary: List the caller's personal API keys
 *     description: |
 *       Returns the keys the signed-in user owns, the endpoints those keys can be
 *       used against, and the limits the administrator configured. Secrets are
 *       never returned - they are shown once, when a key is created or rotated.
 *     tags:
 *       - Integrations - API Keys
 *     responses:
 *       200:
 *         description: Personal API key overview
 *       403:
 *         description: The user may not manage personal API keys
 *       404:
 *         description: Personal API keys are not enabled
 */
router.get('/', authRequired, (req, res) => {
  const context = requireKeyManager(req);

  const { platform, user } = context;
  const config = getPersonalKeyConfig(platform);

  res.json({
    enabled: true,
    limits: {
      maxKeysPerUser: config.maxKeysPerUser,
      defaultExpirationDays: config.defaultExpirationDays,
      maxExpirationDays: config.maxExpirationDays,
      allowClientCredentials: config.allowClientCredentials
    },
    scopes: config.scopes,
    endpoints: buildPersonalKeyEndpoints(req, platform),
    keys: listPersonalKeys(user, platform)
  });
});

/**
 * @swagger
 * /api/integrations/api-keys/{keyId}:
 *   get:
 *     summary: Read one of the caller's personal API keys
 *     description: |
 *       Answers the key's metadata (never its secret). This is the `Location` a
 *       create answers with.
 *     tags:
 *       - Integrations - API Keys
 *     parameters:
 *       - name: keyId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The key
 *       403:
 *         description: The user may not manage personal API keys
 *       404:
 *         description: No such key for this user
 */
router.get('/:keyId', authRequired, (req, res) => {
  const { platform, user } = requireKeyManager(req);

  assertValidId(req.params.keyId, 'API key');

  res.json(getPersonalKey({ user, platform, keyId: req.params.keyId }));
});

/**
 * @swagger
 * /api/integrations/api-keys:
 *   post:
 *     summary: Create a personal API key
 *     description: |
 *       Mints a key that authenticates as the caller. The API key and, when the
 *       administrator allows the client-credentials grant, the client secret are
 *       returned once and never again.
 *     tags:
 *       - Integrations - API Keys
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Label shown in the key list
 *               expirationDays:
 *                 type: number
 *                 description: Lifetime in days, capped by the platform maximum
 *     responses:
 *       201:
 *         description: Key created, including its one-time secrets
 *       409:
 *         description: The user already has the maximum number of keys
 */
router.post('/', authRequired, async (req, res) => {
  const context = requireKeyManager(req);

  const { platform, user } = context;

  const { name, expirationDays } = req.body || {};
  const result = await createPersonalKey({ user, platform, name, expirationDays });

  logAudit({
    req,
    action: 'create',
    resource: 'personalApiKey',
    resourceId: result.key.id,
    summary: `Created personal API key "${result.key.name}"`
  });

  sendCreated(res, `/api/integrations/api-keys/${segment(result.key.id)}`, {
    ...result,
    endpoints: buildPersonalKeyEndpoints(req, platform)
  });
});

/**
 * @swagger
 * /api/integrations/api-keys/{keyId}/_rotate:
 *   post:
 *     summary: Rotate a personal API key
 *     description: |
 *       Issues fresh credentials and invalidates everything issued for this key
 *       earlier. Also refreshes the group membership the key acts with.
 *     tags:
 *       - Integrations - API Keys
 *     parameters:
 *       - name: keyId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Key rotated, including its one-time secrets
 *       404:
 *         description: No such key for this user
 */
router.post('/:keyId/_rotate', authRequired, async (req, res) => {
  const context = requireKeyManager(req);

  // Checked after the feature gate so a disabled feature still answers 404 for
  // every request, but before the identifier reaches the client store.
  assertValidId(req.params.keyId, 'API key');

  const { platform, user } = context;

  const result = await rotatePersonalKey({
    user,
    platform,
    keyId: req.params.keyId,
    expirationDays: req.body?.expirationDays
  });

  logAudit({
    req,
    action: 'update',
    resource: 'personalApiKey',
    resourceId: req.params.keyId,
    summary: `Rotated personal API key "${result.key.name}"`
  });

  res.json({
    ...result,
    endpoints: buildPersonalKeyEndpoints(req, platform)
  });
});

/**
 * @swagger
 * /api/integrations/api-keys/{keyId}:
 *   delete:
 *     summary: Revoke a personal API key
 *     description: Deletes the key. Every credential issued for it stops working at once.
 *     tags:
 *       - Integrations - API Keys
 *     parameters:
 *       - name: keyId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Key revoked
 *       404:
 *         description: No such key for this user
 */
router.delete('/:keyId', authRequired, async (req, res) => {
  const context = requireKeyManager(req);

  assertValidId(req.params.keyId, 'API key');

  const { platform, user } = context;

  await revokePersonalKey({ user, platform, keyId: req.params.keyId });

  logAudit({
    req,
    action: 'delete',
    resource: 'personalApiKey',
    resourceId: req.params.keyId,
    summary: `Revoked personal API key ${req.params.keyId}`
  });

  res.status(204).end();
});

export default router;
