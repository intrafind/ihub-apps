// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { generateUsageGuide } from '../../services/appUsageGuide.js';
import { isLLMError } from '../../services/loop/LLMClient.js';
import { sendLLMError } from '../../services/loop/llmHttpErrors.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendInternalError
} from '../../utils/responseHelpers.js';
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
    try {
      const { app: appConfig, language = 'en' } = req.body || {};
      if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
        return sendBadRequest(res, 'app must be an app configuration object');
      }
      if (typeof language !== 'string' || !LANGUAGE_CODE_PATTERN.test(language)) {
        return sendBadRequest(res, 'Invalid language code');
      }
      const content = await generateUsageGuide({ app: appConfig, language, user: req.user });
      return res.json({ content });
    } catch (error) {
      if (isLLMError(error)) {
        return sendLLMError(res, error, { context: 'write usage guide' });
      }
      if (error.status === 503) {
        return sendErrorResponse(res, 503, error.message);
      }
      return sendInternalError(res, error, 'write usage guide');
    }
  });
}
