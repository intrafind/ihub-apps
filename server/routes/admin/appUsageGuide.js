// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { generateUsageGuide } from '../../services/appUsageGuide.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { LANGUAGE_CODE_PATTERN } from '../../../shared/validationPatterns.js';

/**
 * Admin route that writes an app's usage guide with a model (issue #2838).
 * Kept apart from the app CRUD routes so those do not load the model client.
 */
export default function registerAdminAppUsageGuideRoute(app) {
  /**
   * @swagger
   * /api/admin/apps/_usage-guide:
   *   post:
   *     summary: Write an app's usage guide with a model
   *     description: |
   *       Has the platform's default chat model write a "how to use this app"
   *       guide from the app configuration in the body (which may be an unsaved
   *       draft). Nothing is stored: the admin reviews the text and saves it to
   *       the app's usage guide source (issue #2838).
   *     tags:
   *       - Admin - Apps
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [app]
   *             properties:
   *               app:
   *                 type: object
   *                 description: App configuration the guide describes
   *               language:
   *                 type: string
   *                 description: Language code the guide is written in (default en)
   *     responses:
   *       200:
   *         description: The generated guide as markdown
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 content:
   *                   type: string
   *       400:
   *         description: Missing app or invalid language
   *       503:
   *         description: No chat model available
   */
  app.post(buildServerPath('/api/admin/apps/_usage-guide'), contentAdminAuth, async (req, res) => {
    const { app: appConfig, language = 'en' } = req.body || {};
    if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
      throw new ServiceError('BAD_REQUEST', 'app must be an app configuration object');
    }
    if (typeof language !== 'string' || !LANGUAGE_CODE_PATTERN.test(language)) {
      throw new ServiceError('BAD_REQUEST', 'Invalid language code');
    }
    try {
      const content = await generateUsageGuide({ app: appConfig, language, user: req.user });
      return res.json({ content });
    } catch (error) {
      // No chat model available: the service reports it as a 503. Anything else, including
      // an LLM failure, reaches the global error handler.
      if (error.status === 503) {
        throw new ServiceError('SERVICE_UNAVAILABLE', error.message, { cause: error });
      }
      throw error;
    }
  });
}
