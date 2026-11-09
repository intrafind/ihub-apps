// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder iAssistants and search profiles the signed-in admin can see, for
 * the iAssistant and iFinder panels of the app editor.
 *
 * iFinder lists iAssistants per user — only those whose search profile the
 * user has — and iHub can only ask as a user. So this is the admin's own view:
 * an iAssistant the admin cannot see may still exist, and can still be typed
 * in by id.
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import iFinderAssistants from '../../services/integrations/iFinderAssistants.js';
import iFinderSearchProfiles from '../../services/integrations/iFinderSearchProfiles.js';
import { isAllowed } from '../../services/integrations/scopes/iFinderScopes.js';
import {
  getIFinderConfig,
  isIFinderConfigured
} from '../../services/integrations/ifinderConfig.js';

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
        throw new ServiceError('CONFLICT', 'The iFinder integration is not configured');
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
        throw new ServiceError('UPSTREAM_ERROR', 'iFinder could not be asked for its iAssistants', {
          cause: error
        });
      }
    }
  );

  /**
   * @swagger
   * /admin/integrations/ifinder/search-profiles:
   *   get:
   *     summary: List the iFinder search profiles the admin can see
   *     description: |
   *       Reads the search profiles of the signed-in admin from iFinder, narrowed
   *       to the installation's "Offered search profiles" allow-list. Other users
   *       may have more or fewer profiles.
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: The search profiles and the installation's profile settings
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 profiles:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                       isDefault: { type: boolean }
   *                 defaultSearchProfile: { type: string }
   *                 allowUserSearchProfileChange: { type: boolean }
   *       401:
   *         description: Admin authentication required
   *       409:
   *         description: The iFinder integration is not configured
   *       502:
   *         description: iFinder could not be asked
   */
  app.get(
    buildServerPath('/api/admin/integrations/ifinder/search-profiles'),
    adminAuth,
    async (req, res) => {
      if (!isIFinderConfigured()) {
        throw new ServiceError('CONFLICT', 'The iFinder integration is not configured');
      }

      const cfg = getIFinderConfig();
      try {
        const profiles = await iFinderSearchProfiles.getUserSearchProfiles({
          user: req.user,
          baseUrl: cfg.baseUrl,
          application: cfg.searchProfileApplication,
          timeout: cfg.timeout
        });
        res.json({
          profiles: profiles
            .filter(profile => isAllowed(cfg, profile.id))
            .map(({ id, name, isDefault }) => ({ id, name, isDefault: Boolean(isDefault) })),
          defaultSearchProfile: cfg.defaultSearchProfile,
          allowUserSearchProfileChange: cfg.allowUserSearchProfileChange !== false
        });
      } catch (error) {
        logger.warn('Could not list the iFinder search profiles', {
          component: 'AdminIFinderAssistants',
          error: error.message
        });
        throw new ServiceError(
          'UPSTREAM_ERROR',
          'iFinder could not be asked for its search profiles',
          {
            cause: error
          }
        );
      }
    }
  );
}
