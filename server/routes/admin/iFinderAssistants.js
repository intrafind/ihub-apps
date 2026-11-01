// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder iAssistants the signed-in admin can see, for the iAssistant
 * picker in the app editor.
 *
 * iFinder lists iAssistants per user — only those whose search profile the
 * user has — and iHub can only ask as a user. So this is the admin's own view:
 * an iAssistant the admin cannot see may still exist, and can still be typed
 * in by id.
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import iFinderAssistants from '../../services/integrations/iFinderAssistants.js';
import { isIFinderConfigured } from '../../services/integrations/ifinderConfig.js';
import { sendErrorResponse } from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';

/** The Accept-Language value for a `lang` query parameter, or undefined. */
function languageOf(lang) {
  return typeof lang === 'string' && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(lang)
    ? lang
    : undefined;
}

export default function registerAdminIFinderAssistantsRoutes(app) {
  /**
   * @swagger
   * /admin/integrations/ifinder/assistants:
   *   get:
   *     summary: List the iFinder iAssistants the admin can see
   *     description: |
   *       Reads `GET /public-api/v0/assistants` from iFinder as the signed-in
   *       admin. iFinder only lists iAssistants whose search profile the user
   *       has, so other users may see more or fewer.
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: query
   *         name: lang
   *         schema:
   *           type: string
   *         description: Language of the names and descriptions (e.g. `de`)
   *     responses:
   *       200:
   *         description: The iAssistants
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 assistants:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                       description: { type: string, nullable: true }
   *                       conversationProfileId: { type: string, nullable: true }
   *                       searchProfileId: { type: string, nullable: true }
   *       401:
   *         description: Admin authentication required
   *       409:
   *         description: The iFinder integration is not configured
   *       502:
   *         description: iFinder could not be asked
   */
  app.get(
    buildServerPath('/api/admin/integrations/ifinder/assistants'),
    adminAuth,
    async (req, res) => {
      if (!isIFinderConfigured()) {
        return sendErrorResponse(res, 409, 'The iFinder integration is not configured');
      }

      try {
        const assistants = await iFinderAssistants.listAssistants({
          user: req.user,
          baseUrl: iAssistantService.getConfig().baseUrl,
          language: languageOf(req.query.lang)
        });
        res.json({ assistants });
      } catch (error) {
        logger.warn('Could not list the iFinder iAssistants', {
          component: 'AdminIFinderAssistants',
          error: error.message
        });
        return sendErrorResponse(res, 502, 'iFinder could not be asked for its iAssistants', {
          details: error.message
        });
      }
    }
  );
}
