// Nextcloud OAuth Integration Routes
// Handles OAuth2 flow for Nextcloud file access authentication.

import express from 'express';
import crypto from 'crypto';
import NextcloudService from '../../services/integrations/NextcloudService.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';

const router = express.Router();

/**
 * Validate returnUrl to prevent open-redirect and pseudo-XSS attacks.
 *
 * Allows:
 *  - Relative paths (must start with a single `/`, never `//`).
 *  - Absolute URLs on the same hostname that use the http(s) scheme.
 *
 * Crucially rejects `javascript:`, `data:`, `file:`, `gopher:`, and any
 * other non-http(s) scheme — `url.hostname` is happy to parse
 * `javascript://ihub.example.com/...` and `URL.hostname` will then
 * match `req.hostname`, so a scheme check is mandatory.
 */
function isValidReturnUrl(returnUrl, req) {
  if (!returnUrl) return false;
  if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) return true;
  try {
    const url = new URL(returnUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === req.hostname;
  } catch {
    return false;
  }
}

/**
 * Validate a file path used in Nextcloud WebDAV URLs. We allow Unicode
 * filenames (Nextcloud supports them) but reject path traversal, NUL
 * bytes, and overly long inputs.
 */
function isValidNextcloudPath(value) {
  if (typeof value !== 'string') return false;
  if (value.length > 4096) return false;
  if (value.includes('\0')) return false;
  // Reject `..` segments to prevent path traversal escape from the
  // user's files root. The WebDAV server enforces auth scope but
  // defense in depth is cheap here.
  const segments = value.split('/');
  return !segments.some(seg => seg === '..' || seg === '.');
}

router.use(requireFeature('integrations'));

const nextcloudAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Initiate Nextcloud OAuth2 flow
 * GET /api/integrations/nextcloud/auth?providerId=xxx
 */
router.get('/auth', authRequired, nextcloudAuthLimiter, async (req, res) => {
  try {
    const { providerId, returnUrl } = req.query;

    if (!providerId) {
      return sendBadRequest(res, 'providerId query parameter is required');
    }

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
    const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
      ? returnUrl
      : '/settings/integrations';

    const sessionKey = `oauth_nextcloud_${providerId}`;
    req.session[sessionKey] = {
      state,
      providerId,
      userId: req.user.id,
      returnUrl: validatedReturnUrl,
      timestamp: Date.now()
    };

    const authUrl = NextcloudService.generateAuthUrl(providerId, state, req);

    logger.info('Initiating Nextcloud OAuth', {
      component: 'Nextcloud',
      userId: req.user?.id,
      providerId
    });

    res.redirect(authUrl);
  } catch (error) {
    return sendInternalError(res, error, 'initiate Nextcloud OAuth');
  }
});

/**
 * Handle Nextcloud OAuth callback (provider-specific)
 * GET /api/integrations/nextcloud/:providerId/callback
 */
router.get('/:providerId/callback', authOptional, async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    const { providerId } = req.params;

    if (oauthError) {
      logger.error('Nextcloud OAuth error', {
        component: 'Nextcloud',
        error: oauthError,
        providerId
      });
      return res.redirect('/settings/integrations?nextcloud_error=oauth_failed');
    }

    // Some IdP edge cases (consent denied without `error`, or a manual
    // hit on the callback URL) can land here with no `code`. Surface a
    // stable error code instead of throwing inside `exchangeCodeForTokens`
    // and leaking the raw error into the redirect URL.
    if (!code) {
      logger.error('Nextcloud OAuth callback missing code', {
        component: 'Nextcloud',
        providerId
      });
      return res.redirect('/settings/integrations?nextcloud_error=missing_code');
    }

    if (!req.session) {
      logger.error('No session available for Nextcloud OAuth callback', {
        component: 'Nextcloud',
        providerId
      });
      return res.redirect('/settings/integrations?nextcloud_error=no_session');
    }

    const sessionKey = `oauth_nextcloud_${providerId}`;
    const storedAuth = req.session[sessionKey];

    const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
    const separator = returnUrl.includes('?') ? '&' : '?';

    if (!storedAuth || storedAuth.state !== state) {
      logger.error('Invalid Nextcloud OAuth state parameter', {
        component: 'Nextcloud',
        providerId
      });
      return res.redirect(`${returnUrl}${separator}nextcloud_error=invalid_state`);
    }

    if (storedAuth.providerId !== providerId) {
      logger.error('Provider ID mismatch in Nextcloud OAuth callback', {
        component: 'Nextcloud',
        urlProviderId: providerId,
        sessionProviderId: storedAuth.providerId
      });
      return res.redirect(`${returnUrl}${separator}nextcloud_error=provider_mismatch`);
    }

    // 15-minute session timeout for the OAuth handshake
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('Nextcloud OAuth session expired', {
        component: 'Nextcloud',
        providerId
      });
      return res.redirect(`${returnUrl}${separator}nextcloud_error=session_expired`);
    }

    const tokens = await NextcloudService.exchangeCodeForTokens(storedAuth.providerId, code, req);

    if (!tokens.refreshToken) {
      logger.warn(
        'Storing Nextcloud tokens WITHOUT refresh capability - user will need to reconnect periodically',
        { component: 'Nextcloud', providerId }
      );
    }

    await NextcloudService.storeUserTokens(storedAuth.userId, tokens);
    delete req.session[sessionKey];

    logger.info('Nextcloud OAuth completed', {
      component: 'Nextcloud',
      userId: storedAuth.userId,
      providerId: storedAuth.providerId
    });

    res.redirect(`${returnUrl}${separator}nextcloud_connected=true`);
  } catch (error) {
    logger.error('Error handling Nextcloud OAuth callback', {
      component: 'Nextcloud',
      error: error.message,
      providerId: req.params.providerId
    });

    let catchReturnUrl = '/settings/integrations';
    if (req.session) {
      const catchKey = `oauth_nextcloud_${req.params.providerId}`;
      catchReturnUrl = req.session[catchKey]?.returnUrl || catchReturnUrl;
      delete req.session[catchKey];
    }
    const catchSeparator = catchReturnUrl.includes('?') ? '&' : '?';
    // Use a stable error code rather than echoing `error.message` —
    // some upstream errors interpolate user-influenced strings, and
    // we don't want those landing in the redirect URL.
    res.redirect(`${catchReturnUrl}${catchSeparator}nextcloud_error=callback_failed`);
  }
});

/**
 * Get Nextcloud connection status for current user
 * GET /api/integrations/nextcloud/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const isAuthenticated = await NextcloudService.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'Nextcloud account not connected'
      });
    }

    let userInfo = null;
    try {
      userInfo = await NextcloudService.getUserInfo(req.user.id);
    } catch (userInfoError) {
      logger.warn('Nextcloud connected but user info lookup failed', {
        component: 'Nextcloud',
        userId: req.user.id,
        error: userInfoError.message
      });
    }
    const tokenInfo = await NextcloudService.getTokenExpirationInfo(req.user.id);

    res.json({
      connected: true,
      userInfo: userInfo
        ? {
            displayName: userInfo.displayName,
            email: userInfo.email,
            userPrincipalName: userInfo.id,
            serverUrl: userInfo.serverUrl
          }
        : null,
      tokenInfo: {
        expiresAt: tokenInfo.expiresAt,
        minutesUntilExpiry: tokenInfo.minutesUntilExpiry,
        isExpiring: tokenInfo.isExpiring,
        isExpired: tokenInfo.isExpired
      },
      message: tokenInfo.isExpiring
        ? 'Nextcloud account connected (tokens expiring soon)'
        : 'Nextcloud account connected successfully'
    });
  } catch (error) {
    logger.error('Error getting Nextcloud status', {
      component: 'Nextcloud',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: 'Nextcloud authentication expired'
      });
    }

    return sendInternalError(res, error, 'get Nextcloud status');
  }
});

/**
 * Disconnect Nextcloud account
 * POST /api/integrations/nextcloud/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const success = await NextcloudService.deleteUserTokens(req.user.id);

    if (success) {
      logger.info('Nextcloud disconnected', {
        component: 'Nextcloud',
        userId: req.user.id
      });
      res.json({
        success: true,
        message: 'Nextcloud account disconnected successfully'
      });
    } else {
      res.json({
        success: false,
        message: 'No Nextcloud connection found to disconnect'
      });
    }
  } catch (error) {
    return sendInternalError(res, error, 'disconnect Nextcloud');
  }
});

/**
 * Get available source categories. Nextcloud exposes a single source —
 * the user's personal files — but the picker UI is built around a
 * sources → drives → folders flow, so we mirror the same shape used by
 * Office 365 / Google Drive.
 *
 * GET /api/integrations/nextcloud/sources
 */
router.get('/sources', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const sources = [
      {
        id: 'personal',
        name: 'My Files',
        description: 'Your Nextcloud files',
        icon: 'hard-drive'
      }
    ];

    res.json({ success: true, sources });
  } catch (error) {
    return sendInternalError(res, error, 'get Nextcloud sources');
  }
});

/**
 * List drives for a source. Nextcloud has a single "drive" per user —
 * the root of their files directory — so we synthesise a single entry
 * to match the picker UI's drive selection step.
 *
 * GET /api/integrations/nextcloud/drives/:source
 */
router.get('/drives/:source', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { source } = req.params;
    if (source !== 'personal') {
      return sendBadRequest(res, 'Source must be one of: personal');
    }

    let displayName = 'Nextcloud';
    try {
      const userInfo = await NextcloudService.getUserInfo(req.user.id);
      if (userInfo?.displayName) {
        displayName = `${userInfo.displayName}'s files`;
      } else if (userInfo?.id) {
        displayName = `${userInfo.id}'s files`;
      }
    } catch (userInfoError) {
      logger.debug('Could not fetch Nextcloud user info for drive label', {
        component: 'Nextcloud',
        error: userInfoError.message
      });
    }

    res.json({
      success: true,
      drives: [
        {
          id: 'root',
          name: displayName,
          description: 'Root of your Nextcloud files',
          source: 'personal'
        }
      ]
    });
  } catch (error) {
    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }
    return sendInternalError(res, error, 'list Nextcloud drives');
  }
});

/**
 * List items in a Nextcloud folder.
 *
 * Unlike Office 365 / Google Drive — which use opaque IDs — Nextcloud
 * WebDAV is path-based, so we use `folderPath` (a slash-joined relative
 * path) rather than `folderId`. The `driveId` parameter is accepted for
 * API symmetry with the other providers but ignored (Nextcloud has a
 * single drive per user).
 *
 * GET /api/integrations/nextcloud/items?folderPath=xxx&search=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const folderPath = typeof req.query.folderPath === 'string' ? req.query.folderPath : '';
    const search = typeof req.query.search === 'string' ? req.query.search : '';

    if (folderPath && !isValidNextcloudPath(folderPath)) {
      return sendBadRequest(res, 'folderPath contains invalid characters or path traversal');
    }

    let items;
    if (search && search.trim().length > 0) {
      items = await NextcloudService.searchItems(req.user.id, search, folderPath);
    } else {
      items = await NextcloudService.listItems(req.user.id, folderPath);
    }

    res.json({ success: true, items });
  } catch (error) {
    logger.error('Error listing Nextcloud items', {
      component: 'Nextcloud',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'list Nextcloud items');
  }
});

/**
 * Download a Nextcloud file.
 *
 * GET /api/integrations/nextcloud/download?filePath=xxx
 */
router.get('/download', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
    if (!filePath) {
      return sendBadRequest(res, 'filePath query parameter is required');
    }

    if (!isValidNextcloudPath(filePath)) {
      return sendBadRequest(res, 'filePath contains invalid characters or path traversal');
    }

    const file = await NextcloudService.downloadFile(req.user.id, filePath);

    // Force `application/octet-stream` rather than reflecting the
    // upstream Content-Type. The download is always served with
    // `Content-Disposition: attachment` so even `text/html` would not
    // render today, but reflecting upstream MIME types means any
    // future refactor that drops the attachment disposition would
    // open an XSS path. Keep the safer baseline.
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);
    // Nextcloud allows quotes, backslashes, newlines, and Unicode in
    // filenames. Send both an ASCII-safe `filename` (fallback for old
    // clients) and an RFC 5987 `filename*` (UTF-8) so the value can't
    // break out of the header or inject extra headers.
    const asciiFallback = (file.name || 'download')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\\r\n]/g, '_');
    const utf8Encoded = encodeURIComponent(file.name || 'download');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`
    );
    res.send(file.content);
  } catch (error) {
    logger.error('Error downloading Nextcloud file', {
      component: 'Nextcloud',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'download Nextcloud file');
  }
});

export default router;
