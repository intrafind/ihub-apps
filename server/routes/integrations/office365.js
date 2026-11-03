// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Office 365 OAuth Integration Routes
// Handles OAuth2 PKCE flow for Microsoft 365 file access authentication

import express from 'express';
import Office365Service from '../../services/integrations/Office365Service.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { registerIntegrationCallbackAlias } from './oauthIntegrationFactory.js';
import {
  requireCloudStorageGrant,
  requestedProviderId,
  respondIfAuthRequired
} from './cloudStorageAccess.js';
import { isValidGraphId } from '../../services/integrations/graphIds.js';

const router = express.Router();

/** Picker source id → the provider's `sources` toggle that enables it. */
const SOURCE_SETTINGS = { personal: 'personalDrive', sharepoint: 'followedSites', teams: 'teams' };

// Gate all Office 365 routes behind the integrations feature flag
router.use(requireFeature('integrations'));
// A provider the user's groups do not grant (`permissions.integrations`) can
// be neither connected nor browsed.
router.use(requireCloudStorageGrant('office365'));

// The OAuth callback registered in the vendor app: an alias of the one integration
// callback (see oauthIntegrationFactory.js). Connecting, the status and disconnecting
// are the one connect flow (POST /api/integrations/:id/connect|disconnect).
registerIntegrationCallbackAlias(router, {
  providerKey: 'office365',
  requiresProviderId: true,
  stack: 'cloud-storage'
});

/**
 * Get available source categories
 * GET /api/integrations/office365/sources
 */
router.get('/sources', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    // Static source categories (no Graph API calls), limited to the sources
    // the admin enabled for this provider.
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;
    const enabled = Office365Service.getEnabledSources(providerId);
    const allSources = [
      {
        id: 'personal',
        name: 'OneDrive',
        description: 'Your personal OneDrive files',
        icon: 'hard-drive'
      },
      {
        id: 'sharepoint',
        name: 'SharePoint Sites',
        description: 'Files from SharePoint sites you follow',
        icon: 'folder'
      },
      {
        id: 'teams',
        name: 'Microsoft Teams',
        description: 'Files from your Teams channels',
        icon: 'user-group'
      }
    ];
    const sources = allSources.filter(source => enabled[SOURCE_SETTINGS[source.id]]);

    res.json({
      success: true,
      sources
    });
  } catch (error) {
    logger.error('❌ Error getting Office 365 sources:', {
      component: 'Office 365',
      error: error.message
    });

    return sendInternalError(res, error, 'get Office 365 sources');
  }
});

/**
 * List drives for a specific source
 * GET /api/integrations/office365/drives/:source
 */
router.get('/drives/:source', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const { source } = req.params;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;
    let drives = [];

    // Sources the admin switched off are not offered, and the sign-in did not
    // ask for their permissions either.
    const enabled = Office365Service.getEnabledSources(providerId);
    const sourceSetting = SOURCE_SETTINGS[source];
    if (sourceSetting && !enabled[sourceSetting]) {
      return sendErrorResponse(res, 403, 'This source is not enabled for this provider');
    }

    switch (source) {
      case 'personal':
        drives = await Office365Service.listPersonalDrives(req.user.id, providerId);
        break;
      case 'sharepoint':
        drives = await Office365Service.listSharePointDrives(req.user.id, providerId);
        break;
      case 'teams':
        drives = await Office365Service.listTeamsDrives(req.user.id, providerId);
        break;
      default:
        return sendBadRequest(res, 'Source must be one of: personal, sharepoint, teams');
    }

    res.json({
      success: true,
      drives
    });
  } catch (error) {
    logger.error('Error listing Office 365 drives', {
      component: 'Office 365',
      source: req.params.source,
      error: error.message
    });

    if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;

    return sendInternalError(res, error, 'list Office 365 drives');
  }
});

/**
 * List items in a drive folder
 * GET /api/integrations/office365/items?driveId=xxx&folderId=xxx&search=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const { driveId, folderId, search } = req.query;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    if (driveId && !isValidGraphId(driveId)) {
      return sendBadRequest(res, 'driveId contains invalid characters or is too long');
    }

    if (folderId && !isValidGraphId(folderId)) {
      return sendBadRequest(res, 'folderId contains invalid characters or is too long');
    }

    let items;
    // If search query is provided, use search endpoint
    if (search && search.trim().length > 0) {
      if (!driveId) {
        return sendBadRequest(res, 'driveId is required for search');
      }
      items = await Office365Service.searchItems(req.user.id, driveId, search, providerId);
    } else {
      items = await Office365Service.listItems(req.user.id, driveId, folderId, providerId);
    }

    res.json({
      success: true,
      items
    });
  } catch (error) {
    logger.error('❌ Error listing Office 365 items:', {
      component: 'Office 365',
      error: error.message
    });

    if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;

    return sendInternalError(res, error, 'list Office 365 items');
  }
});

/**
 * Download a file from Office 365
 * GET /api/integrations/office365/download?fileId=xxx&driveId=xxx
 */
router.get('/download', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const { fileId, driveId } = req.query;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    if (!fileId) {
      return sendBadRequest(res, 'fileId query parameter is required');
    }

    if (!isValidGraphId(fileId)) {
      return sendBadRequest(res, 'fileId contains invalid characters or is too long');
    }

    if (driveId && !isValidGraphId(driveId)) {
      return sendBadRequest(res, 'driveId contains invalid characters or is too long');
    }

    const file = await Office365Service.downloadFile(req.user.id, fileId, driveId, providerId);

    // Force `application/octet-stream` rather than reflecting the
    // upstream Graph Content-Type. The download is always served with
    // `Content-Disposition: attachment` so even `text/html` would not
    // render today, but reflecting upstream MIME types means any
    // future refactor that drops the attachment disposition would
    // open an XSS path. Keep the safer baseline.
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', buildContentDisposition(file.name));

    // Send file content
    res.send(file.content);
  } catch (error) {
    logger.error('❌ Error downloading Office 365 file:', {
      component: 'Office 365',
      error: error.message
    });

    if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;

    return sendInternalError(res, error, 'download Office 365 file');
  }
});

export default router;
