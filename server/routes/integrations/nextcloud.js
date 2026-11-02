// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Nextcloud OAuth Integration Routes
// Handles OAuth2 flow for Nextcloud file access authentication.

import express from 'express';
import NextcloudService from '../../services/integrations/NextcloudService.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest
} from '../../utils/responseHelpers.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { registerIntegrationCallbackAlias } from './oauthIntegrationFactory.js';
import {
  requireCloudStorageGrant,
  requestedProviderId,
  respondIfAuthRequired
} from './cloudStorageAccess.js';

const router = express.Router();

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
// A provider the user's groups do not grant (`permissions.integrations`) can
// be neither connected nor browsed.
router.use(requireCloudStorageGrant('nextcloud'));

// The OAuth callback registered in the vendor app: an alias of the one integration
// callback (see oauthIntegrationFactory.js). Connecting, the status and disconnecting
// are the one connect flow (POST /api/integrations/:id/connect|disconnect).
// The sign-in runs through the connection service (PKCE, server-side state).
registerIntegrationCallbackAlias(router, {
  providerKey: 'nextcloud',
  requiresProviderId: true,
  stack: 'cloud-storage'
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const { source } = req.params;
    if (source !== 'personal') {
      return sendBadRequest(res, 'Source must be one of: personal');
    }

    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    let displayName = 'Nextcloud';
    try {
      const userInfo = await NextcloudService.getUserInfo(req.user.id, providerId);
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
    if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;
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
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const folderPath = typeof req.query.folderPath === 'string' ? req.query.folderPath : '';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    if (folderPath && !isValidNextcloudPath(folderPath)) {
      return sendBadRequest(res, 'folderPath contains invalid characters or path traversal');
    }

    let items;
    if (search && search.trim().length > 0) {
      items = await NextcloudService.searchItems(req.user.id, search, folderPath, providerId);
    } else {
      items = await NextcloudService.listItems(req.user.id, folderPath, providerId);
    }

    res.json({ success: true, items });
  } catch (error) {
    logger.error('Error listing Nextcloud items', {
      component: 'Nextcloud',
      error: error.message
    });

    if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;

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
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;
    if (!filePath) {
      return sendBadRequest(res, 'filePath query parameter is required');
    }

    if (!isValidNextcloudPath(filePath)) {
      return sendBadRequest(res, 'filePath contains invalid characters or path traversal');
    }

    const file = await NextcloudService.downloadFile(req.user.id, filePath, providerId);

    // Force `application/octet-stream` rather than reflecting the
    // upstream Content-Type. The download is always served with
    // `Content-Disposition: attachment` so even `text/html` would not
    // render today, but reflecting upstream MIME types means any
    // future refactor that drops the attachment disposition would
    // open an XSS path. Keep the safer baseline.
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', buildContentDisposition(file.name));
    res.send(file.content);
  } catch (error) {
    logger.error('Error downloading Nextcloud file', {
      component: 'Nextcloud',
      error: error.message
    });

    if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;

    return sendInternalError(res, error, 'download Nextcloud file');
  }
});

export default router;
