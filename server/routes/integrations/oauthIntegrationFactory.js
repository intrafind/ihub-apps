// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The vendor-registered OAuth callback paths of Jira and the storage
 * providers (Office 365, Google Drive, Nextcloud).
 *
 * Admins registered these URLs in the vendors' OAuth apps before there was
 * one integration callback, so they stay as **aliases** of
 * `GET /api/integrations/oauth/callback` (see `oauthCallback.js`):
 *
 *   GET /api/integrations/jira/callback
 *   GET /api/integrations/<office365|googledrive|nextcloud>/<installation id>/callback
 *
 * Starting a sign-in, the status and disconnecting are the one connect flow
 * of every integration (`userIntegrations.js`: `GET /api/integrations`,
 * `POST /api/integrations/:id/connect|reconnect|disconnect`); the per-provider
 * `/auth`, `/status` and `/disconnect` routes were removed (#2917).
 *
 * @module routes/integrations/oauthIntegrationFactory
 */
import { authOptional } from '../../middleware/authRequired.js';
import { integrationOAuthCallbackHandler } from './oauthCallback.js';

/**
 * Register a provider's callback alias on its router.
 *
 * @param {import('express').Router} router - The provider's router (mounted at `/api/integrations/<providerKey>`)
 * @param {object} config
 * @param {string} config.providerKey - Route slug, e.g. 'office365'
 * @param {boolean} config.requiresProviderId - True for the storage providers: the
 *   callback path names the installation (`/<installation id>/callback`); false for Jira
 * @param {string} [config.installationId] - The installation of a single-installation provider (jira)
 * @param {'jira'|'cloud-storage'} config.stack - Which connection stack the alias belongs to
 * @returns {import('express').Router} the router passed in
 *
 * @example
 * registerIntegrationCallbackAlias(router, {
 *   providerKey: 'office365', requiresProviderId: true, stack: 'cloud-storage'
 * });
 */
export function registerIntegrationCallbackAlias(
  router,
  { providerKey, requiresProviderId, installationId: fixedInstallationId, stack }
) {
  router.get(
    requiresProviderId ? '/:providerId/callback' : '/callback',
    authOptional,
    integrationOAuthCallbackHandler(req => ({
      stack,
      resultKey: providerKey,
      installationId: requiresProviderId ? req.params.providerId : fixedInstallationId
    }))
  );
  return router;
}
