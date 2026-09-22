// Connected apps routes
// Lets a signed-in user see which OAuth clients they have given access to,
// and disconnect any of them, from Settings > Integrations.

import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import { logAudit } from '../../services/AuditLogService.js';
import {
  listConnectionsForUser,
  revokeConnection
} from '../../services/oauth/ConnectionService.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

const router = express.Router();

// Same feature gate as the rest of the integrations page.
router.use(requireFeature('integrations'));

/**
 * Auth modes that act *on behalf of* someone rather than being that person at
 * a keyboard. The same list personalApiKeys.js refuses, for the same reason: a
 * delegated token must not be able to revoke the very grant that produced it,
 * nor enumerate what else its user has connected.
 */
const DELEGATED_AUTH_MODES = [
  'oauth_client_credentials',
  'oauth_static_api_key',
  'oauth_authorization_code',
  'oauth_personal_key'
];

/**
 * Resolve the caller, refusing anyone who may not manage their own
 * connections.
 *
 * `authRequired` still lets anonymous callers through when anonymous access is
 * enabled platform-wide, and "anonymous" is not a person whose connections
 * mean anything.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Object|null} The acting user, or null when a response was sent
 */
function requireConnectionOwner(req, res) {
  const platform = configCache.getPlatform() || {};

  if (platform.oauth?.enabled?.authz !== true) {
    res.status(404).json({ error: 'The OAuth authorization server is not enabled' });
    return null;
  }

  if (!req.user?.id || req.user.id === 'anonymous') {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  if (req.user.isOAuthClient || req.user.isAgent === true) {
    res.status(403).json({ error: 'Only an interactive session can manage connections' });
    return null;
  }

  if (DELEGATED_AUTH_MODES.includes(req.user.authMode)) {
    res.status(403).json({ error: 'Only an interactive session can manage connections' });
    return null;
  }

  return req.user;
}

/**
 * @swagger
 * /api/integrations/connections:
 *   get:
 *     summary: List the applications the caller has connected to their account
 *     description: |
 *       One entry per OAuth client the signed-in user has granted access,
 *       with the scopes they approved, when they approved them, and when the
 *       connection was last refreshed.
 *     tags:
 *       - Integrations - Connections
 *     responses:
 *       200:
 *         description: The user's connections
 *       401:
 *         description: Not signed in
 *       403:
 *         description: Not an interactive session
 *       404:
 *         description: The OAuth authorization server is not enabled
 */
router.get('/', authRequired, (req, res) => {
  const user = requireConnectionOwner(req, res);
  if (!user) return;

  try {
    const platform = configCache.getPlatform() || {};
    res.json({
      enabled: true,
      // The UI tells the user how long an access token issued before the
      // disconnect can still work, so it needs the number.
      tokenExpirationMinutes: platform.oauth?.defaultTokenExpirationMinutes || 60,
      connections: listConnectionsForUser(user.id)
    });
  } catch (error) {
    logger.error('Failed to list connections', { component: 'Connections', error });
    res.status(500).json({ error: 'Failed to list connected applications' });
  }
});

/**
 * @swagger
 * /api/integrations/connections/{clientId}:
 *   delete:
 *     summary: Disconnect an application from the caller's account
 *     description: |
 *       Deletes the caller's consent for this client and revokes every refresh
 *       token issued for the pair, so the application has to send the user
 *       through sign-in and consent again. Access tokens already issued are
 *       stateless and remain valid until they expire.
 *     tags:
 *       - Integrations - Connections
 *     parameters:
 *       - name: clientId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Disconnected
 *       404:
 *         description: No such connection for this user
 */
router.delete('/:clientId', authRequired, async (req, res) => {
  const user = requireConnectionOwner(req, res);
  if (!user) return;

  // A CIMD client id is a URL, so it arrives percent-encoded. It is a store
  // key and never a path segment on disk, so there is nothing to validate it
  // against beyond ownership — which is checked below.
  const clientId = decodeURIComponent(req.params.clientId || '');
  if (!clientId) {
    return res.status(400).json({ error: 'clientId is required' });
  }

  try {
    // Ownership check before the revoke, and a 404 rather than a 403 for
    // someone else's connection: whether another user has connected a given
    // client is not this caller's business either.
    const owned = listConnectionsForUser(user.id).some(c => c.clientId === clientId);
    if (!owned) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    const result = await revokeConnection(clientId, user.id);

    logAudit({
      req,
      action: 'delete',
      resource: 'oauthConnection',
      resourceId: `${clientId}:${user.id}`,
      summary: `Disconnected ${clientId} (${result.refreshTokensRevoked} refresh token(s) revoked)`,
      source: 'web'
    });

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Failed to revoke connection', { component: 'Connections', error });
    res.status(500).json({ error: 'Failed to disconnect the application' });
  }
});

export default router;
