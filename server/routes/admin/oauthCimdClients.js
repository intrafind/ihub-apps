import {
  getCimdClientRow,
  listCimdClientRows,
  clientsFileFor
} from '../../services/oauth/CimdGovernanceService.js';
import { revokeConnectionsForClient } from '../../services/oauth/ConnectionService.js';
import {
  CIMD_POLICY_FIELDS,
  findCimdClientPolicy,
  upsertCimdClientPolicy
} from '../../utils/oauthClientManager.js';
import { isClientIdUrl } from '../../utils/clientIdMetadata.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { logAudit } from '../../services/AuditLogService.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * Admin routes for governing clients identified by a metadata document.
 *
 * Two things make these routes different from the stored-client ones.
 *
 * **The id is a URL.** `validateIdForPath()` rejects one on sight, and rightly
 * so — it exists to keep a path segment from becoming a file path. Here the
 * value is a *store key*, never a path, so it travels base64url-encoded in the
 * URL and is decoded back to the exact key, the same way `oauthConnections.js`
 * already treats a client id.
 *
 * **Only policy is writable.** Identity comes from the document the client
 * publishes, and `trusted` / `consentRequired` / `clientSecret` are locked by
 * definition — approving a client is not trusting it. `upsertCimdClientPolicy`
 * is what enforces that; these routes simply do not offer the fields.
 */

/**
 * Decode a base64url-encoded client id from a path segment.
 *
 * Returns null for anything that does not decode to an https URL, which is the
 * only shape a CIMD client id can have.
 *
 * @param {string} encoded - The path segment
 * @returns {string|null} The client id, or null
 */
function decodeClientId(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 4096) return null;
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return isClientIdUrl(decoded) ? decoded : null;
}

/**
 * Guard shared by every route here: the feature has to be on, and the id has to
 * decode.
 *
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @returns {{platform: Object, clientId: string}|null} Null when already answered
 */
/** Policy fields that must be arrays of strings when they are set. */
const LIST_FIELDS = Object.freeze([
  'allowedGroups',
  'allowedApps',
  'allowedModels',
  'allowedPrompts',
  'scopes'
]);

function requireCimdClient(req, res) {
  const platform = configCache.getPlatform() || {};
  if (!platform.oauth?.enabled?.clients) {
    res.status(400).json({ success: false, error: 'OAuth clients are not enabled on this server' });
    return null;
  }

  const clientId = decodeClientId(req.params.encodedClientId);
  if (!clientId) {
    res.status(400).json({ success: false, error: 'Invalid client identifier' });
    return null;
  }

  return { platform, clientId };
}

export default function registerAdminOAuthCimdRoutes(app) {
  /**
   * @swagger
   * /api/admin/oauth/cimd-clients:
   *   get:
   *     summary: List clients identified by a metadata document
   *     description: |
   *       The join of the stored policy records and the connections that exist,
   *       so a client nobody has decided anything about yet is still listed.
   *       Pending clients sort first. Each row carries both the policy the
   *       record sets and the effective policy after layering over
   *       `platform.oauth.cimd`.
   *     tags: [Admin, OAuth]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: The CIMD clients
   *       400:
   *         description: OAuth clients are not enabled
   */
  app.get(buildServerPath('/api/admin/oauth/cimd-clients'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      if (!platform.oauth?.enabled?.clients) {
        return res
          .status(400)
          .json({ success: false, error: 'OAuth clients are not enabled on this server' });
      }

      res.json({
        success: true,
        clients: listCimdClientRows(platform),
        approvalMode: platform.oauth?.cimd?.approvalMode === 'auto' ? 'auto' : 'approval'
      });
    } catch (error) {
      logger.error('[OAuth Admin] List CIMD clients error', { component: 'OAuthAdmin', error });
      res.status(500).json({ success: false, error: 'Failed to list client-metadata clients' });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/clients/cimd/{encodedClientId}:
   *   get:
   *     summary: Get one client-metadata client
   *     tags: [Admin, OAuth]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: encodedClientId
   *         in: path
   *         required: true
   *         description: The client id (a URL), base64url-encoded
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: The client
   *       404:
   *         description: No such client
   */
  app.get(
    buildServerPath('/api/admin/oauth/clients/cimd/:encodedClientId'),
    adminAuth,
    async (req, res) => {
      try {
        const context = requireCimdClient(req, res);
        if (!context) return;

        const client = getCimdClientRow(context.clientId, context.platform);
        if (!client) {
          return res.status(404).json({ success: false, error: 'Client not found' });
        }
        res.json({ success: true, client });
      } catch (error) {
        logger.error('[OAuth Admin] Get CIMD client error', { component: 'OAuthAdmin', error });
        res.status(500).json({ success: false, error: 'Failed to load the client' });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/oauth/clients/cimd/{encodedClientId}:
   *   put:
   *     summary: Set the policy for a client-metadata client
   *     description: |
   *       Writes a policy-only record keyed by the client's document URL:
   *       `active` (block / unblock), `approvalState` (approve), and the
   *       resource policy the stored clients already have. Identity fields are
   *       never accepted, and `trusted` / `consentRequired` / `clientSecret`
   *       are refused by the writer — approving a client does not trust it.
   *
   *       Blocking revokes the client's connections in the same action: a block
   *       that leaves live refresh tokens behind is not a block.
   *     tags: [Admin, OAuth]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: encodedClientId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               active: { type: boolean }
   *               approvalState: { type: string, enum: [pending, approved, auto] }
   *               allowedGroups: { type: array, items: { type: string } }
   *               allowedApps: { type: array, items: { type: string } }
   *               allowedModels: { type: array, items: { type: string } }
   *               allowedPrompts: { type: array, items: { type: string } }
   *               scopes: { type: array, items: { type: string } }
   *               tokenExpirationMinutes: { type: number }
   *     responses:
   *       200:
   *         description: Policy saved
   *       400:
   *         description: Invalid request
   */
  app.put(
    buildServerPath('/api/admin/oauth/clients/cimd/:encodedClientId'),
    adminAuth,
    async (req, res) => {
      try {
        const context = requireCimdClient(req, res);
        if (!context) return;
        const { platform, clientId } = context;
        const oauthConfig = platform.oauth || {};

        const body = req.body || {};
        const patch = {};
        for (const field of CIMD_POLICY_FIELDS) {
          if (body[field] !== undefined) patch[field] = body[field];
        }

        if (Object.keys(patch).length === 0) {
          return res.status(400).json({ success: false, error: 'No policy fields to update' });
        }

        // `null` is the way a field is handed back to the global default, so it
        // passes every shape check below on purpose.
        for (const field of LIST_FIELDS) {
          const value = patch[field];
          if (value === null || value === undefined) continue;
          if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
            return res
              .status(400)
              .json({ success: false, error: `${field} must be an array of strings` });
          }
        }

        if (patch.active !== undefined && typeof patch.active !== 'boolean') {
          return res.status(400).json({ success: false, error: 'active must be a boolean' });
        }

        if (
          patch.approvalState !== undefined &&
          !['pending', 'approved', 'auto'].includes(patch.approvalState)
        ) {
          return res.status(400).json({ success: false, error: 'Invalid approval state' });
        }

        if (patch.tokenExpirationMinutes !== undefined && patch.tokenExpirationMinutes !== null) {
          const minutes = Number(patch.tokenExpirationMinutes);
          const maxExpiration = oauthConfig.maxTokenExpirationMinutes || 1440;
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > maxExpiration) {
            return res.status(400).json({
              success: false,
              error: `Token expiration must be between 1 and ${maxExpiration} minutes`
            });
          }
          patch.tokenExpirationMinutes = minutes;
        }

        const clientsFilePath = clientsFileFor(platform);
        const before = findCimdClientPolicy(clientId, clientsFilePath);
        const savedBy = req.user?.id || 'admin';
        const existingRow = getCimdClientRow(clientId, platform);
        const displayName = existingRow?.name || clientId;

        // Approving and blocking leave a trail on the record, not only in the
        // audit log: the Clients page has to answer "who let this in?" without
        // a log search.
        const metadata = { displayName };
        if (patch.approvalState === 'approved' && before?.approvalState !== 'approved') {
          metadata.approvedBy = savedBy;
          metadata.approvedAt = new Date().toISOString();
        }
        if (patch.active === false) {
          metadata.blockedBy = savedBy;
          metadata.blockedAt = new Date().toISOString();
        }
        if (!before?.metadata?.firstSeenAt) {
          metadata.firstSeenAt = existingRow?.firstSeenAt || new Date().toISOString();
        }

        const record = await upsertCimdClientPolicy(
          clientId,
          { ...patch, metadata },
          clientsFilePath,
          savedBy
        );

        // A block that leaves live refresh tokens behind is not a block. The
        // client's users must go back through sign-in and consent — which the
        // block itself then refuses until it is lifted.
        let revoked = null;
        if (patch.active === false && before?.active !== false) {
          revoked = await revokeConnectionsForClient(clientId);
          logAudit({
            req,
            action: 'delete',
            resource: 'oauthConnection',
            resourceId: clientId,
            summary: `Revoked all ${revoked.connectionsRevoked} connection(s) of ${displayName} because the client was blocked`
          });
        }

        if (patch.active !== undefined && before?.active !== patch.active) {
          logAudit({
            req,
            action: 'toggle',
            resource: 'oauthCimdClient',
            resourceId: clientId,
            summary: `${patch.active === false ? 'Blocked' : 'Unblocked'} the client-metadata client ${displayName}`
          });
        }

        if (patch.approvalState !== undefined && before?.approvalState !== patch.approvalState) {
          logAudit({
            req,
            action: 'update',
            resource: 'oauthCimdClient',
            resourceId: clientId,
            summary: `Set the approval state of ${displayName} to ${patch.approvalState}`
          });
        }

        const policyFields = Object.keys(patch).filter(
          field => field !== 'active' && field !== 'approvalState'
        );
        if (policyFields.length > 0) {
          logAudit({
            req,
            action: 'update',
            resource: 'oauthCimdClient',
            resourceId: clientId,
            summary: `Updated the policy of ${displayName} (${policyFields.join(', ')})`
          });
        }

        res.json({
          success: true,
          client: getCimdClientRow(clientId, platform) || record,
          revoked
        });
      } catch (error) {
        logger.error('[OAuth Admin] Update CIMD client policy error', {
          component: 'OAuthAdmin',
          error
        });
        res.status(500).json({ success: false, error: 'Failed to save the client policy' });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/oauth/clients/{encodedClientId}/connections:
   *   delete:
   *     summary: Revoke every connection of one OAuth client
   *     description: |
   *       Deletes every consent entry and every refresh token for the client,
   *       across all users, in one action. Works for any client id — a stored
   *       one or a metadata-document URL — which is why the id is base64url
   *       encoded in the path rather than validated as a path segment.
   *
   *       Access tokens already issued are stateless and expire within the
   *       client's token lifetime. Blocking the client is what closes that
   *       window.
   *     tags: [Admin, OAuth]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: encodedClientId
   *         in: path
   *         required: true
   *         description: The client id, base64url-encoded
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Connections revoked
   *       400:
   *         description: Invalid client identifier, or OAuth clients are not enabled
   */
  app.delete(
    buildServerPath('/api/admin/oauth/clients/:encodedClientId/connections'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform() || {};
        if (!platform.oauth?.enabled?.clients) {
          return res
            .status(400)
            .json({ success: false, error: 'OAuth clients are not enabled on this server' });
        }

        // A stored client id is a plain string and a CIMD one is a URL; both
        // arrive encoded so one endpoint can serve either.
        let clientId;
        try {
          clientId = Buffer.from(req.params.encodedClientId || '', 'base64url').toString('utf8');
        } catch {
          clientId = '';
        }
        if (!clientId) {
          return res.status(400).json({ success: false, error: 'Invalid client identifier' });
        }

        const result = await revokeConnectionsForClient(clientId);

        logAudit({
          req,
          action: 'delete',
          resource: 'oauthConnection',
          resourceId: clientId,
          summary: `Revoked all connections of ${clientId}: ${result.connectionsRevoked} connection(s), ${result.refreshTokensRevoked} refresh token(s)`
        });

        res.json({ success: true, ...result });
      } catch (error) {
        logger.error('[OAuth Admin] Bulk revoke error', { component: 'OAuthAdmin', error });
        res
          .status(500)
          .json({ success: false, error: "Failed to revoke the client's connections" });
      }
    }
  );
}
