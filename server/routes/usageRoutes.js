// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A user's own usage and limits (`GET /api/usage/me`): the token budgets per
 * model and across all models with what is used and when each resets, the
 * usage of every model they may use this month, and their file storage.
 */
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { sendInternalError } from '../utils/responseHelpers.js';
import { enhanceUserWithPermissions, isAnonymousAccessAllowed } from '../utils/authorization.js';
import { getQuotaStatus } from '../services/quota/quotaService.js';
import { getChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { resolveChatOwner } from '../services/chat/chatOwner.js';
import runLog from '../services/loop/RunLog.js';

async function fileUsage(user) {
  try {
    const repository = getChatFileRepository();
    if (!repository.isAvailable()) return null;
    const owner = await resolveChatOwner(user, { mode: runLog.identityMode() });
    if (!owner) return null;
    return await repository.getOwnerUsage(owner.id);
  } catch {
    return null;
  }
}

export default function registerUsageRoutes(app) {
  /**
   * @swagger
   * /usage/me:
   *   get:
   *     summary: The caller's usage and limits
   *     description: |
   *       Token budgets (per model and across all models) with what is used in the
   *       current window and when it resets, this month's tokens per model and app,
   *       and the uploaded file storage against its limit. A limit of `null` is
   *       unlimited.
   *     tags:
   *       - Usage
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Usage and limits
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 buckets:
   *                   type: array
   *                   description: Every limited budget (scope `model` or `allModels`, window `day`/`week`/`month`)
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       scope: { type: string, enum: [model, allModels] }
   *                       modelId: { type: string, nullable: true }
   *                       modelName: { type: string, nullable: true }
   *                       window: { type: string, enum: [day, week, month] }
   *                       used: { type: integer }
   *                       limit: { type: integer }
   *                       remaining: { type: integer }
   *                       percent: { type: number }
   *                       exceeded: { type: boolean }
   *                       warning: { type: boolean }
   *                       resetAt: { type: string, format: date-time }
   *                       source: { type: string, description: "model, platform, user or group:<id>" }
   *                 models: { type: array, items: { type: object } }
   *                 totals: { type: object }
   *                 apps: { type: array, items: { type: object } }
   *                 files: { type: object }
   *                 resets: { type: object }
   *       401:
   *         description: Authentication required
   */
  app.get(buildServerPath('/api/usage/me'), authRequired, async (req, res) => {
    try {
      const platformConfig = configCache.getPlatform() || {};
      let user = req.user;
      if (user && !user.permissions) {
        user = enhanceUserWithPermissions(user, platformConfig.auth || {}, platformConfig);
      }
      if (!user && isAnonymousAccessAllowed(platformConfig)) {
        user = enhanceUserWithPermissions(null, platformConfig.auth || {}, platformConfig);
      }
      const language =
        (typeof req.query.lang === 'string' && req.query.lang) ||
        req.headers['accept-language']?.split(',')[0]?.split('-')[0] ||
        platformConfig.defaultLanguage ||
        'en';
      const status = await getQuotaStatus(user, { language });
      const files = await fileUsage(user);
      res.set('Cache-Control', 'no-store');
      res.json({
        ...status,
        files: {
          ...status.files,
          usedBytes: files?.usedBytes ?? null,
          fileCount: files?.fileCount ?? null
        }
      });
    } catch (error) {
      return sendInternalError(res, error, 'load usage');
    }
  });
}
