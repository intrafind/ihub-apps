import { listConnections, revokeConnection } from '../../services/oauth/ConnectionService.js';
import { listCimdClientRows } from '../../services/oauth/CimdGovernanceService.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { logAudit } from '../../services/AuditLogService.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * Admin routes for OAuth connections — the grants behind the clients.
 *
 * The clients page answers "what software may connect"; this answers "who
 * actually did". They are different questions, and only this one survives
 * CIMD, where the client that most users connect through has no stored record
 * to list at all.
 *
 * All routes require admin authentication.
 */
export default function registerAdminOAuthConnectionRoutes(app) {
  /**
   * @swagger
   * /api/admin/oauth/connections:
   *   get:
   *     summary: List OAuth connections (user × client × scopes)
   *     description: |
   *       Every grant a user has given an OAuth client, derived from the
   *       consent store. Filterable by client, user and client hostname.
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: query
   *         schema: { type: string }
   *       - name: userId
   *         in: query
   *         schema: { type: string }
   *       - name: host
   *         in: query
   *         schema: { type: string }
   *       - name: page
   *         in: query
   *         schema: { type: integer, default: 1 }
   *       - name: pageSize
   *         in: query
   *         schema: { type: integer, default: 50 }
   *     responses:
   *       200:
   *         description: Matching connections
   *       400:
   *         description: OAuth clients are not enabled
   */
  app.get(buildServerPath('/api/admin/oauth/connections'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled?.clients) {
        return res.status(400).json({
          success: false,
          error: 'OAuth clients are not enabled on this server'
        });
      }

      const { clientId, userId, host, page, pageSize } = req.query;
      const result = listConnections({ clientId, userId, host, page, pageSize });

      res.json({
        success: true,
        ...result,
        // The clients behind these connections that identify themselves with a
        // metadata document, with their governance state, so this page can
        // revoke all of a client's connections at once.
        cimdClients: listCimdClientRows(platform)
      });
    } catch (error) {
      logger.error('[OAuth Admin] List connections error', { component: 'OAuthAdmin', error });
      res.status(500).json({ success: false, error: 'Failed to list OAuth connections' });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/connections/{clientId}/{userId}:
   *   delete:
   *     summary: Revoke one user's connection to one OAuth client
   *     description: |
   *       Deletes the consent record and every refresh token for the pair, so
   *       the client must send the user through sign-in and consent again.
   *       Access tokens already issued are stateless and expire within the
   *       client's token lifetime.
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *       - name: userId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Connection revoked
   *       404:
   *         description: No such connection
   */
  app.delete(
    buildServerPath('/api/admin/oauth/connections/:clientId/:userId'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform() || {};
        const oauthConfig = platform.oauth || {};

        if (!oauthConfig.enabled?.clients) {
          return res.status(400).json({
            success: false,
            error: 'OAuth clients are not enabled on this server'
          });
        }

        // Both come from the URL path, but neither is used to build one: they
        // are store keys, not file names. A CIMD client id is a URL, so the
        // usual path-segment validator would reject every one of them.
        const clientId = decodeURIComponent(req.params.clientId || '');
        const userId = decodeURIComponent(req.params.userId || '');

        if (!clientId || !userId) {
          return res
            .status(400)
            .json({ success: false, error: 'clientId and userId are required' });
        }

        const result = await revokeConnection(clientId, userId);
        if (!result.revoked) {
          return res.status(404).json({ success: false, error: 'Connection not found' });
        }

        logAudit({
          req,
          action: 'delete',
          resource: 'oauthConnection',
          resourceId: `${clientId}:${userId}`,
          summary: `Revoked the connection between ${userId} and ${clientId} (${result.refreshTokensRevoked} refresh token(s))`
        });

        res.json({ success: true, ...result });
      } catch (error) {
        logger.error('[OAuth Admin] Revoke connection error', { component: 'OAuthAdmin', error });
        res.status(500).json({ success: false, error: 'Failed to revoke the connection' });
      }
    }
  );
}
