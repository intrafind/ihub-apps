// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-use acknowledgement, admin side (#3326).
 *
 * - `POST   /api/admin/eu-ai-act/acknowledgements/_request-again`: raise the required version
 * - `DELETE /api/admin/eu-ai-act/users/:userId/acknowledgements`: remove one user's entries
 * - `DELETE /api/admin/eu-ai-act/acknowledgements`: remove everyone's entries
 * - `GET    /api/admin/eu-ai-act/acknowledgements/_export?status=`: CSV
 *
 * The list itself is `GET /api/admin/auth/users`, which already carries
 * `aiAcknowledgements`. Every action is audited.
 */
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { buildCsv } from '../../utils/csv.js';
import { clearAiAcknowledgements } from '../../utils/userManager.js';
import { logAudit } from '../../services/AuditLogService.js';
import {
  CSV_HEADERS,
  buildCsvRows,
  usersFilePath
} from '../../services/aiAcknowledgement/aiAcknowledgementService.js';

const PLATFORM_FILE = 'config/platform.json';

/**
 * Change the server-owned part of `aiAcknowledgement` in platform.json under the
 * store's compare-and-set, so two clicks or a parallel settings save cannot lose
 * an update.
 */
async function updateAcknowledgementState(change) {
  let result;
  await configStore.updateJson(PLATFORM_FILE, platform => {
    const current = platform && typeof platform === 'object' ? platform : {};
    const block =
      current.aiAcknowledgement && typeof current.aiAcknowledgement === 'object'
        ? current.aiAcknowledgement
        : {};
    result = change(block);
    current.aiAcknowledgement = block;
    return current;
  });
  await configCache.refreshCacheEntry(PLATFORM_FILE);
  return result;
}

export default function registerAdminAiAcknowledgementRoutes(app) {
  /**
   * @swagger
   * /api/admin/eu-ai-act/acknowledgements/_request-again:
   *   post:
   *     summary: Ask everyone to acknowledge again
   *     description: Raises requiredVersion by one. Allowed while the feature is off.
   *     tags: [Admin, AI Acknowledgement]
   *     responses:
   *       200:
   *         description: The new requiredVersion and the previousRequiredVersion
   */
  app.post(
    buildServerPath('/api/admin/eu-ai-act/acknowledgements/_request-again'),
    adminAuth,
    async (req, res) => {
      const { from, to } = await updateAcknowledgementState(block => {
        const previous =
          Number.isInteger(block.requiredVersion) && block.requiredVersion >= 1
            ? block.requiredVersion
            : 1;
        block.requiredVersion = previous + 1;
        return { from: previous, to: previous + 1 };
      });
      logAudit({
        req,
        action: 'update',
        resource: 'aiAcknowledgement',
        resourceId: String(to),
        summary: `Required AI-use notice version raised from ${from} to ${to}`,
        details: { from, to }
      });
      res.json({ requiredVersion: to, previousRequiredVersion: from });
    }
  );

  /**
   * @swagger
   * /api/admin/eu-ai-act/users/{userId}/acknowledgements:
   *   delete:
   *     summary: Remove the AI-use acknowledgements of one user
   *     tags: [Admin, AI Acknowledgement]
   *     responses:
   *       204:
   *         description: Removed
   *       404:
   *         description: No such user
   */
  app.delete(
    buildServerPath('/api/admin/eu-ai-act/users/:userId/acknowledgements'),
    adminAuth,
    async (req, res) => {
      const { userId } = req.params;
      assertValidId(userId, 'user');
      const platform = configCache.getPlatform() || {};
      const removed = await clearAiAcknowledgements(userId, usersFilePath(platform));
      if (!removed.found) throw new ServiceError('NOT_FOUND', 'User not found');
      logAudit({
        req,
        action: 'delete',
        resource: 'aiAcknowledgement',
        resourceId: userId,
        summary: `Removed AI-use acknowledgements of user ${userId}`,
        details: { entries: removed.entries }
      });
      res.status(204).end();
    }
  );

  /**
   * @swagger
   * /api/admin/eu-ai-act/acknowledgements:
   *   delete:
   *     summary: Remove every AI-use acknowledgement
   *     description: >-
   *       Clears all user records and sets `resetAt`, so guest cookies issued
   *       before it stop counting too.
   *     tags: [Admin, AI Acknowledgement]
   *     responses:
   *       204:
   *         description: Removed
   */
  app.delete(
    buildServerPath('/api/admin/eu-ai-act/acknowledgements'),
    adminAuth,
    async (req, res) => {
      const platform = configCache.getPlatform() || {};
      const removed = await clearAiAcknowledgements(null, usersFilePath(platform));
      await updateAcknowledgementState(block => {
        block.resetAt = new Date().toISOString();
      });
      logAudit({
        req,
        action: 'delete',
        resource: 'aiAcknowledgement',
        resourceId: '*',
        summary: 'Removed all AI-use acknowledgements',
        details: { users: removed.users, entries: removed.entries }
      });
      res.status(204).end();
    }
  );

  /**
   * @swagger
   * /api/admin/eu-ai-act/acknowledgements/_export:
   *   get:
   *     summary: CSV of who acknowledged which version
   *     tags: [Admin, AI Acknowledgement]
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [acknowledged, pending]
   *     responses:
   *       200:
   *         description: The CSV file
   *         content:
   *           text/csv:
   *             schema:
   *               type: string
   *       400:
   *         description: Unknown status
   */
  app.get(
    buildServerPath('/api/admin/eu-ai-act/acknowledgements/_export'),
    adminAuth,
    async (req, res) => {
      const { status } = req.query;
      if (status !== undefined && status !== 'acknowledged' && status !== 'pending') {
        throw new ServiceError('BAD_REQUEST', 'status must be "acknowledged" or "pending"');
      }
      const rows = buildCsvRows(status);
      logAudit({
        req,
        action: 'export',
        resource: 'aiAcknowledgement',
        resourceId: '*',
        summary: 'Exported AI-use acknowledgements',
        details: { status: status || 'all', rows: rows.length }
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ai-acknowledgements.csv"');
      res.send(buildCsv([...CSV_HEADERS], rows));
    }
  );
}
