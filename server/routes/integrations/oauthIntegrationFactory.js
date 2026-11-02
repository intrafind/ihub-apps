// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Shared OAuth2 integration route factory.
//
// office365.js, googledrive.js, nextcloud.js and jira.js each expose the same
// auth -> callback -> status -> disconnect routes. This factory registers them
// on the router passed in; each provider file supplies the few adapter
// functions below and keeps its own provider-specific routes
// (sources/drives/items/download/etc.) on the same router.
//
// The sign-in itself is not here: `/auth` asks the connection service
// (services/integrations/auth/IntegrationConnectionService.js) for the
// authorization URL — PKCE, a server-side state bound to the user and the
// installation, the validated return URL — and the callback route is an alias
// of the one integration callback (`/api/integrations/oauth/callback`, see
// routes/integrations/oauthCallback.js), kept because admins registered it in
// the vendors' OAuth apps.

import { authOptional, authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest
} from '../../utils/responseHelpers.js';
import { isUnavailableError } from '../../services/integrations/oauthRefreshError.js';
import {
  getIntegrationConnectionService,
  resultParams,
  returnPathWith,
  DEFAULT_RETURN_PATH
} from '../../services/integrations/auth/IntegrationConnectionService.js';
import { OAuthFlowError } from '../../services/integrations/auth/OAuthUserClient.js';
import { isValidReturnUrl } from '../../utils/oauthReturnUrl.js';
import { buildServerPath } from '../../utils/basePath.js';
import { integrationOAuthCallbackHandler } from './oauthCallback.js';

/**
 * authRequired lets the anonymous principal through when anonymous access is
 * allowed and does not guarantee `req.user.id` is set, so routes that need a
 * signed-in user check for both.
 */
function isAnonymous(user) {
  return !user?.id || user.id === 'anonymous';
}

/**
 * Register the shared OAuth routes (`/auth`, `/callback`, `/status`,
 * `/disconnect`) on `router`.
 *
 * The adapter callbacks must call the provider service at invocation time
 * (`ctx => Service.method(...)`) rather than capturing `Service.method` up
 * front, so the service stays replaceable (tests stub its methods).
 *
 * @param {import('express').Router} router - router to register the shared OAuth routes on
 * @param {object} config
 * @param {string} config.providerKey - route/result-param slug, e.g. 'office365'
 * @param {string} config.displayName - human-readable name used in logs/messages, e.g. 'Office 365'
 * @param {boolean} config.requiresProviderId - true for the storage providers (office365/googledrive/nextcloud), whose
 *   `providerId` is the id of one installation (there may be several per provider); false for single-installation ones (jira)
 * @param {string} [config.installationId] - The installation of a single-installation provider (jira)
 * @param {'jira'|'cloud-storage'} config.stack - Which connection stack the callback alias belongs to
 * @param {(userId, providerId) => Promise<boolean>} config.isUserAuthenticated
 * @param {(userId, providerId) => Promise<object>} config.getUserInfo
 * @param {(userId, providerId) => Promise<object>} config.getTokenExpirationInfo
 * @param {(userId, providerId, req) => Promise<boolean>} config.deleteUserTokens
 * @param {(userInfo: object) => object} config.formatUserInfo - shapes the `/status` userInfo payload
 * @param {boolean} [config.tolerateUserInfoFailure] - if true, a failed getUserInfo on `/status` is logged and reported as `userInfo: null` instead of failing the request (Nextcloud)
 * @param {import('express').RequestHandler} [config.authLimiter] - rate limiter applied to `/auth`
 * @param {import('express').RequestHandler} [config.statusLimiter] - optional extra rate limiter applied to `/status`
 * @returns {import('express').Router} the router passed in
 */
export function createOAuthIntegrationRouter(
  router,
  {
    providerKey,
    displayName,
    requiresProviderId,
    installationId: fixedInstallationId,
    stack,
    isUserAuthenticated,
    getUserInfo,
    getTokenExpirationInfo,
    deleteUserTokens,
    formatUserInfo,
    tolerateUserInfoFailure = false,
    authLimiter,
    statusLimiter
  }
) {
  /**
   * Initiate the OAuth2 flow.
   * GET /api/integrations/<providerKey>/auth?providerId=<installation id>&returnUrl=<same-origin URL>
   */
  router.get('/auth', authRequired, ...(authLimiter ? [authLimiter] : []), async (req, res) => {
    const providerId = requiresProviderId ? req.query.providerId : undefined;
    if (requiresProviderId && (typeof providerId !== 'string' || !providerId)) {
      return sendBadRequest(res, 'providerId query parameter is required');
    }
    // authRequired lets the anonymous principal through when anonymous
    // access is allowed, and does not guarantee req.user.id is truthy.
    // Refuse to start an OAuth flow without a signed-in user id — otherwise
    // tokens would land under a shared key and could be read by another caller.
    if (isAnonymous(req.user)) return sendAuthRequired(res);

    const returnUrl = isValidReturnUrl(req.query.returnUrl, req)
      ? String(req.query.returnUrl)
      : buildServerPath(DEFAULT_RETURN_PATH);
    const installationId = requiresProviderId ? providerId : fixedInstallationId;
    try {
      const { authorizationUrl } = await getIntegrationConnectionService().beginConnect({
        installationId,
        user: req.user,
        req,
        returnUrl
      });
      logger.info(`Initiating ${displayName} OAuth`, {
        component: displayName,
        userId: req.user.id,
        providerId
      });
      return res.redirect(authorizationUrl.href);
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        logger.warn(`${displayName} OAuth could not start`, {
          component: displayName,
          providerId,
          code: error.code,
          error: error.message
        });
        // To the settings page, not the caller's return URL: nothing taken
        // from the request goes into this redirect.
        return res.redirect(
          returnPathWith(
            buildServerPath(DEFAULT_RETURN_PATH),
            resultParams(
              { stack, resultKey: providerKey, installationId },
              { ok: false, code: error.code }
            )
          )
        );
      }
      return sendInternalError(res, error, `initiate ${displayName} OAuth`);
    }
  });

  /**
   * The OAuth2 callback: an alias of `/api/integrations/oauth/callback`.
   * GET /api/integrations/<providerKey>/:providerId/callback (storage providers: the installation id)
   * GET /api/integrations/<providerKey>/callback (single-provider)
   */
  router.get(
    requiresProviderId ? '/:providerId/callback' : '/callback',
    authOptional,
    integrationOAuthCallbackHandler(req => ({
      stack,
      resultKey: providerKey,
      installationId: requiresProviderId ? req.params.providerId : fixedInstallationId
    }))
  );

  /** The provider the `/status` request asks about, for multi-provider integrations. */
  function statusProviderId(query) {
    return requiresProviderId && typeof query.providerId === 'string'
      ? query.providerId
      : undefined;
  }

  /** The `/status` payload of a connected account. */
  function connectedStatus(userInfo, tokenInfo) {
    return {
      connected: true,
      userInfo: userInfo ? formatUserInfo(userInfo) : null,
      tokenInfo: {
        expiresAt: tokenInfo.expiresAt,
        minutesUntilExpiry: tokenInfo.minutesUntilExpiry,
        isExpiring: tokenInfo.isExpiring,
        isExpired: tokenInfo.isExpired
      },
      message: tokenInfo.isExpiring
        ? `${displayName} account connected (tokens expiring soon)`
        : `${displayName} account connected successfully`
    };
  }

  /**
   * The user's profile for the `/status` payload. A failing lookup is only
   * logged when the provider tolerates it (Nextcloud); otherwise it fails the request.
   */
  async function loadUserInfo(userId, providerId) {
    if (!tolerateUserInfoFailure) {
      return getUserInfo(userId, providerId);
    }
    try {
      return await getUserInfo(userId, providerId);
    } catch (userInfoError) {
      logger.warn(`${displayName} connected but user info lookup failed`, {
        component: displayName,
        userId,
        providerId,
        error: userInfoError.message
      });
      return null;
    }
  }

  /** Answer a `/status` request that threw. */
  function respondToStatusError(res, error) {
    // The token refresh failed for a reason that says nothing about the grant
    // (outage, rate limit, provider config). The account is still connected, so
    // say so and do not tell the user to reconnect.
    if (isUnavailableError(error)) {
      logger.warn(`${displayName} status unavailable`, {
        component: displayName,
        error: error.message
      });
      return res.json({
        connected: true,
        temporarilyUnavailable: true,
        message: error.message
      });
    }

    logger.error(`Error getting ${displayName} status`, {
      component: displayName,
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: `${displayName} authentication expired`
      });
    }

    return sendInternalError(res, error, `get ${displayName} status`);
  }

  /**
   * Get connection status for the current user.
   * GET /api/integrations/<providerKey>/status
   */
  router.get(
    '/status',
    authRequired,
    ...(statusLimiter ? [statusLimiter] : []),
    async (req, res) => {
      try {
        if (isAnonymous(req.user)) {
          return sendAuthRequired(res);
        }

        const providerId = statusProviderId(req.query);

        if (!(await isUserAuthenticated(req.user.id, providerId))) {
          return res.json({
            connected: false,
            message: `${displayName} account not connected`
          });
        }

        const userInfo = await loadUserInfo(req.user.id, providerId);
        const tokenInfo = await getTokenExpirationInfo(req.user.id, providerId);

        res.json(connectedStatus(userInfo, tokenInfo));
      } catch (error) {
        return respondToStatusError(res, error);
      }
    }
  );

  /**
   * Disconnect the integration for the current user: revoke upstream when the
   * provider supports it, delete the tokens (audit `connection.revoke`).
   * POST /api/integrations/<providerKey>/disconnect
   */
  router.post('/disconnect', authRequired, async (req, res) => {
    try {
      if (isAnonymous(req.user)) {
        return sendAuthRequired(res);
      }

      // Accept providerId from either query (legacy clients) or JSON body.
      const providerId = requiresProviderId
        ? (typeof req.query.providerId === 'string' && req.query.providerId) ||
          (typeof req.body?.providerId === 'string' && req.body.providerId) ||
          undefined
        : undefined;

      const success = await deleteUserTokens(req.user.id, providerId, req);

      if (success) {
        logger.info(`${displayName} disconnected`, {
          component: displayName,
          userId: req.user.id,
          providerId
        });
        res.json({
          success: true,
          message: `${displayName} account disconnected successfully`
        });
      } else {
        res.json({
          success: false,
          message: `No ${displayName} connection found to disconnect`
        });
      }
    } catch (error) {
      return sendInternalError(res, error, `disconnect ${displayName}`);
    }
  });

  return router;
}
