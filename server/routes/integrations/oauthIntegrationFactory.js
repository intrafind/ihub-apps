// Shared OAuth2 integration route factory.
//
// office365.js, googledrive.js, nextcloud.js and jira.js each implement the
// same auth -> callback -> status -> disconnect OAuth2 (+PKCE) flow with
// only the provider service, PKCE usage, and multi- vs single-provider
// routing as real differences. This factory registers those four routes
// directly on the router passed in; each provider file supplies the small
// adapter functions below and keeps its own provider-specific routes
// (sources/drives/items/download/etc.) on the same router.
//
// The flow's state travels in a signed `state` ticket rather than a session
// (see utils/integrationOAuthState.js), so the callback works on any cluster
// worker.

import crypto from 'node:crypto';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest
} from '../../utils/responseHelpers.js';
import { isValidReturnUrl } from '../../utils/oauthReturnUrl.js';
import { isUnavailableError } from '../../services/integrations/oauthRefreshError.js';
import {
  DEFAULT_INTEGRATION_RETURN_URL,
  issueIntegrationOAuthState,
  verifyIntegrationOAuthState,
  withQueryParam
} from '../../utils/integrationOAuthState.js';

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
 * @param {string} config.providerKey - route/state/query-param slug, e.g. 'office365'
 * @param {string} config.displayName - human-readable name used in logs/messages, e.g. 'Office 365'
 * @param {boolean} config.requiresProviderId - true for multi-provider integrations (office365/googledrive/nextcloud), false for single-provider ones (jira)
 * @param {boolean} config.usesPkce - whether to generate/forward a PKCE code verifier
 * @param {(ctx: {providerId, state, codeVerifier, req}) => string} config.buildAuthUrl
 * @param {(ctx: {providerId, code, codeVerifier, req}) => Promise<{refreshToken?: string}>} config.exchangeCodeForTokens
 * @param {(userId, tokens) => Promise<void>} config.storeUserTokens
 * @param {(userId, providerId) => Promise<boolean>} config.isUserAuthenticated
 * @param {(userId, providerId) => Promise<object>} config.getUserInfo
 * @param {(userId, providerId) => Promise<object>} config.getTokenExpirationInfo
 * @param {(userId, providerId) => Promise<boolean>} config.deleteUserTokens
 * @param {(userInfo: object) => object} config.formatUserInfo - shapes the `/status` userInfo payload
 * @param {boolean} [config.tolerateUserInfoFailure] - if true, a failed getUserInfo on `/status` is logged and reported as `userInfo: null` instead of failing the request (Nextcloud)
 * @param {import('express').RequestHandler} [config.authLimiter] - rate limiter applied to `/auth`
 * @param {import('express').RequestHandler} [config.statusLimiter] - optional extra rate limiter applied to `/status`
 * @param {(providerId: string|undefined) => void} [config.logMissingRefreshToken] - custom log when no refresh token is returned
 * @param {(error: Error) => string} [config.mapCallbackError] - stable `<providerKey>_error` code for a failed token exchange; defaults to `callback_failed`
 * @returns {import('express').Router} the router passed in
 */
export function createOAuthIntegrationRouter(
  router,
  {
    providerKey,
    displayName,
    requiresProviderId,
    usesPkce,
    buildAuthUrl,
    exchangeCodeForTokens,
    storeUserTokens,
    isUserAuthenticated,
    getUserInfo,
    getTokenExpirationInfo,
    deleteUserTokens,
    formatUserInfo,
    tolerateUserInfoFailure = false,
    authLimiter,
    statusLimiter,
    logMissingRefreshToken,
    mapCallbackError = _error => 'callback_failed'
  }
) {
  const errorParam = `${providerKey}_error`;

  /**
   * Initiate the OAuth2 flow.
   * GET /api/integrations/<providerKey>/auth?providerId=xxx
   */
  router.get('/auth', authRequired, ...(authLimiter ? [authLimiter] : []), (req, res) => {
    try {
      const { returnUrl } = req.query;
      const providerId = requiresProviderId ? req.query.providerId : undefined;

      if (requiresProviderId && !providerId) {
        return sendBadRequest(res, 'providerId query parameter is required');
      }

      // authRequired lets the anonymous principal through when anonymous
      // access is allowed, and does not guarantee req.user.id is truthy.
      // Refuse to start an OAuth flow without a signed-in user id — otherwise
      // tokens would land under a shared key and could be read by another caller.
      if (!req.user?.id || req.user.id === 'anonymous') {
        return sendAuthRequired(res);
      }

      const codeVerifier = usesPkce ? crypto.randomBytes(32).toString('base64url') : undefined;

      // Validate returnUrl to reject `javascript:`, `data:`, off-host and
      // protocol-relative URLs that would leak the flow off-site afterwards.
      const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
        ? returnUrl
        : DEFAULT_INTEGRATION_RETURN_URL;

      // Signed, self-contained state instead of a session: the callback may
      // land on another cluster worker (see utils/integrationOAuthState.js).
      const state = issueIntegrationOAuthState({
        service: providerKey,
        providerId,
        userId: req.user.id,
        returnUrl: validatedReturnUrl,
        codeVerifier
      });

      const authUrl = buildAuthUrl({ providerId, state, codeVerifier, req });

      logger.info(`Initiating ${displayName} OAuth`, {
        component: displayName,
        userId: req.user.id,
        providerId
      });

      res.redirect(authUrl);
    } catch (error) {
      return sendInternalError(res, error, `initiate ${displayName} OAuth`);
    }
  });

  /**
   * Handle the OAuth2 callback.
   * GET /api/integrations/<providerKey>/:providerId/callback (multi-provider)
   * GET /api/integrations/<providerKey>/callback (single-provider)
   */
  router.get(
    requiresProviderId ? '/:providerId/callback' : '/callback',
    authOptional,
    async (req, res) => {
      const providerId = requiresProviderId ? req.params.providerId : undefined;
      // `returnUrl` is always set, so every outcome can send the user back to a safe page.
      const verified = verifyIntegrationOAuthState(req, { service: providerKey, providerId });
      const { returnUrl } = verified;
      try {
        const { code, error: oauthError } = req.query;

        // Only stable codes go into the URL — never the raw IdP error text.
        if (oauthError) {
          logger.error(`${displayName} OAuth error`, {
            component: displayName,
            error: oauthError,
            providerId
          });
          const errorCode = oauthError === 'access_denied' ? 'access_denied' : 'oauth_failed';
          return res.redirect(withQueryParam(returnUrl, errorParam, errorCode));
        }

        if (!verified.ok) {
          logger.error(`Invalid ${displayName} OAuth state parameter`, {
            component: displayName,
            providerId,
            reason: verified.error
          });
          return res.redirect(withQueryParam(returnUrl, errorParam, verified.error));
        }

        // Some IdP edge cases (consent denied without `error`, or a manual
        // hit on the callback URL) can land here with no `code`. Surface a
        // stable error code instead of throwing inside `exchangeCodeForTokens`.
        if (!code) {
          logger.error(`${displayName} OAuth callback missing code`, {
            component: displayName,
            providerId
          });
          return res.redirect(withQueryParam(returnUrl, errorParam, 'missing_code'));
        }

        const tokens = await exchangeCodeForTokens({
          providerId,
          code,
          codeVerifier: verified.codeVerifier,
          req
        });

        // Verify we received a refresh token
        if (!tokens.refreshToken) {
          if (logMissingRefreshToken) {
            logMissingRefreshToken(providerId);
          } else {
            logger.error(`No refresh token received from ${displayName} OAuth.`, {
              component: displayName,
              providerId
            });
          }
          logger.warn(
            'Storing tokens WITHOUT refresh capability - user will need to reconnect periodically',
            { component: displayName, providerId }
          );
        }

        await storeUserTokens(verified.userId, tokens);

        logger.info(`${displayName} OAuth completed`, {
          component: displayName,
          userId: verified.userId,
          providerId
        });

        res.redirect(withQueryParam(returnUrl, `${providerKey}_connected`, 'true'));
      } catch (error) {
        logger.error(`Error handling ${displayName} OAuth callback`, {
          component: displayName,
          error: error.message,
          providerId
        });
        // Stable error codes only — some upstream errors interpolate
        // user-influenced strings that must not land in the redirect URL.
        res.redirect(withQueryParam(returnUrl, errorParam, mapCallbackError(error)));
      }
    }
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
   * Disconnect the integration for the current user.
   * POST /api/integrations/<providerKey>/disconnect
   */
  router.post('/disconnect', authRequired, async (req, res) => {
    try {
      if (!req.user?.id || req.user.id === 'anonymous') {
        return sendAuthRequired(res);
      }

      // Accept providerId from either query (legacy clients) or JSON body.
      const providerId = requiresProviderId
        ? (typeof req.query.providerId === 'string' && req.query.providerId) ||
          (typeof req.body?.providerId === 'string' && req.body.providerId) ||
          undefined
        : undefined;

      const success = await deleteUserTokens(req.user.id, providerId);

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
