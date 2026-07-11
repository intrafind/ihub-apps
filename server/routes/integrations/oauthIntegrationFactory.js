// Shared OAuth2 integration route factory.
//
// office365.js, googledrive.js, nextcloud.js and jira.js each implement the
// same auth -> callback -> status -> disconnect OAuth2 (+PKCE) flow with
// only the provider service, PKCE usage, and multi- vs single-provider
// routing as real differences. This factory registers those four routes
// directly on the router passed in; each provider file supplies the small
// adapter functions below and keeps its own provider-specific routes
// (sources/drives/items/download/etc.) on the same router.

import crypto from 'crypto';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { isValidReturnUrl } from '../../utils/oauthReturnUrl.js';

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * @param {import('express').Router} router - router to register the shared OAuth routes on
 * @param {object} config
 * @param {string} config.providerKey - route/session/query-param slug, e.g. 'office365'
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
    logMissingRefreshToken
  }
) {
  const sessionKeyFor = providerId =>
    requiresProviderId ? `oauth_${providerKey}_${providerId}` : `oauth_${providerKey}`;

  const authMiddleware = [authRequired, ...(authLimiter ? [authLimiter] : [])];

  /**
   * Initiate the OAuth2 flow.
   * GET /api/integrations/<providerKey>/auth?providerId=xxx
   */
  router.get('/auth', ...authMiddleware, async (req, res) => {
    try {
      const { providerId, returnUrl } = req.query;

      if (requiresProviderId && !providerId) {
        return sendBadRequest(res, 'providerId query parameter is required');
      }

      logger.debug(`${displayName} Auth Debug:`, {
        component: displayName,
        hasUser: !!req.user,
        userId: req.user?.id,
        providerId,
        returnUrl,
        hasSession: !!req.session
      });

      if (!req.session) {
        return sendErrorResponse(res, 500, 'Session not available');
      }

      // authRequired only rejects missing `req.user` or anonymous users;
      // it does NOT guarantee req.user.id is truthy. Refuse to start an
      // OAuth flow without a real user id — otherwise tokens would land
      // under a shared sentinel key and could be read by another caller.
      if (!req.user?.id) {
        return sendAuthRequired(res);
      }

      const state = crypto.randomBytes(32).toString('hex');
      const codeVerifier = usesPkce ? crypto.randomBytes(32).toString('base64url') : undefined;

      // Validate returnUrl to prevent open redirects
      const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
        ? returnUrl
        : '/settings/integrations';

      const sessionKey = sessionKeyFor(providerId);
      req.session[sessionKey] = {
        state,
        codeVerifier,
        providerId,
        userId: req.user.id,
        returnUrl: validatedReturnUrl,
        timestamp: Date.now()
      };

      const authUrl = buildAuthUrl({ providerId, state, codeVerifier, req });

      logger.info(`Initiating ${displayName} OAuth`, {
        component: displayName,
        userId: req.user?.id,
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
      try {
        const { code, state, error: oauthError } = req.query;

        const sessionKey = sessionKeyFor(providerId);
        const storedAuth = req.session?.[sessionKey];
        const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
        const separator = returnUrl.includes('?') ? '&' : '?';

        if (oauthError) {
          logger.error(`${displayName} OAuth error`, {
            component: displayName,
            error: oauthError,
            providerId
          });
          // Redirect with a generic error code to avoid exposing raw error details in the URL
          return res.redirect(`${returnUrl}${separator}${providerKey}_error=oauth_failed`);
        }

        // Some IdP edge cases (consent denied without `error`, or a manual
        // hit on the callback URL) can land here with no `code`. Surface a
        // stable error code instead of throwing inside `exchangeCodeForTokens`
        // and leaking the raw error into the redirect URL.
        if (!code) {
          logger.error(`${displayName} OAuth callback missing code`, {
            component: displayName,
            providerId
          });
          return res.redirect(`${returnUrl}${separator}${providerKey}_error=missing_code`);
        }

        if (!req.session) {
          logger.error(`No session available for ${displayName} OAuth callback`, {
            component: displayName,
            providerId
          });
          return res.redirect(`${returnUrl}${separator}${providerKey}_error=no_session`);
        }

        if (!storedAuth || storedAuth.state !== state) {
          logger.error(`Invalid ${displayName} OAuth state parameter`, {
            component: displayName,
            providerId
          });
          return res.redirect(`${returnUrl}${separator}${providerKey}_error=invalid_state`);
        }

        if (requiresProviderId && storedAuth.providerId !== providerId) {
          logger.error(`Provider ID mismatch in ${displayName} OAuth callback`, {
            component: displayName,
            urlProviderId: providerId,
            sessionProviderId: storedAuth.providerId
          });
          return res.redirect(`${returnUrl}${separator}${providerKey}_error=provider_mismatch`);
        }

        // Check session timeout
        if (Date.now() - storedAuth.timestamp > SESSION_TIMEOUT_MS) {
          logger.error(`${displayName} OAuth session expired`, {
            component: displayName,
            providerId
          });
          return res.redirect(`${returnUrl}${separator}${providerKey}_error=session_expired`);
        }

        // Exchange authorization code for tokens
        const tokens = await exchangeCodeForTokens({
          providerId: storedAuth.providerId,
          code,
          codeVerifier: storedAuth.codeVerifier,
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

        // Store encrypted tokens for user
        await storeUserTokens(storedAuth.userId, tokens);

        // Clear session data
        delete req.session[sessionKey];

        logger.info(`${displayName} OAuth completed`, {
          component: displayName,
          userId: storedAuth.userId,
          providerId: storedAuth.providerId
        });

        // Redirect back to the original page with success
        res.redirect(`${returnUrl}${separator}${providerKey}_connected=true`);
      } catch (error) {
        logger.error(`Error handling ${displayName} OAuth callback`, {
          component: displayName,
          error: error.message,
          providerId
        });

        // Try to get returnUrl from session before clearing
        let catchReturnUrl = '/settings/integrations';
        if (req.session) {
          const catchKey = sessionKeyFor(providerId);
          catchReturnUrl = req.session[catchKey]?.returnUrl || catchReturnUrl;
          delete req.session[catchKey];
        }

        const catchSeparator = catchReturnUrl.includes('?') ? '&' : '?';
        // Use a stable error code rather than echoing `error.message` —
        // some upstream errors interpolate user-influenced strings, and
        // we don't want those landing in the redirect URL.
        res.redirect(`${catchReturnUrl}${catchSeparator}${providerKey}_error=callback_failed`);
      }
    }
  );

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
        if (!req.user?.id) {
          return sendAuthRequired(res);
        }

        const providerId =
          typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

        const isAuthenticated = await isUserAuthenticated(req.user.id, providerId);

        if (!isAuthenticated) {
          return res.json({
            connected: false,
            message: `${displayName} account not connected`
          });
        }

        let userInfo;
        if (tolerateUserInfoFailure) {
          try {
            userInfo = await getUserInfo(req.user.id, providerId);
          } catch (userInfoError) {
            logger.warn(`${displayName} connected but user info lookup failed`, {
              component: displayName,
              userId: req.user.id,
              providerId,
              error: userInfoError.message
            });
            userInfo = null;
          }
        } else {
          userInfo = await getUserInfo(req.user.id, providerId);
        }

        const tokenInfo = await getTokenExpirationInfo(req.user.id, providerId);

        res.json({
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
        });
      } catch (error) {
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
    }
  );

  /**
   * Disconnect the integration for the current user.
   * POST /api/integrations/<providerKey>/disconnect
   */
  router.post('/disconnect', authRequired, async (req, res) => {
    try {
      if (!req.user?.id) {
        return sendAuthRequired(res);
      }

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
