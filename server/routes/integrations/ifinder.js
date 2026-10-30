// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';
import iFinderProvider from '../../services/sources/providers/ifinder.js';
import { sendProviderContent } from '../sources.js';
import { sendBadRequest, sendErrorResponse } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import {
  deleteLoginTokens,
  getExchangeProviderName,
  getLoginTokenStatus
} from '../../services/integrations/iFinderTokenProvider.js';
import { logAudit } from '../../services/AuditLogService.js';

const router = express.Router();

/*
 * The iFinder document routes. They serve the same `ifinder` source provider
 * as `GET /api/sources/ifinder/*` (routes/sources.js), which the sources panel
 * uses; these keep their own paths for callers that address iFinder directly.
 */

function refOf(req, res) {
  const { documentId, searchProfile } = req.query;
  if (!documentId || typeof documentId !== 'string') {
    sendBadRequest(res, 'documentId parameter is required');
    return null;
  }
  return typeof searchProfile === 'string' && searchProfile
    ? { id: documentId, scope: searchProfile }
    : { id: documentId };
}

function sendFailure(res, error, message) {
  logger.error(message, { component: 'IFinder', error });
  return sendErrorResponse(
    res,
    Number.isInteger(error?.status) ? error.status : 500,
    error.message
  );
}

/**
 * Proxy endpoint for fetching documents from iFinder.
 * Resolves the real download link (with opaque access token) by searching iFinder
 * for the document ID, then fetches and streams the binary to the client.
 *
 * GET /api/integrations/ifinder/document?documentId=<id>[&searchProfile=<profile>][&convertToPdf=true]
 */
router.get('/document', authRequired, async (req, res) => {
  const ref = refOf(req, res);
  if (!ref) return undefined;
  try {
    const content = await iFinderProvider.content({
      ref,
      user: req.user,
      format: req.query.convertToPdf === 'true' ? 'pdf' : 'original'
    });
    return sendProviderContent(res, content);
  } catch (error) {
    return sendFailure(res, error, 'iFinder document proxy error');
  }
});

/**
 * Text content fallback endpoint for documents without a binary access URL.
 * Uses iFinderService.getContent() to retrieve the document's text content.
 *
 * GET /api/integrations/ifinder/document/content?documentId=<id>[&searchProfile=<profile>]
 */
router.get('/document/content', authRequired, async (req, res) => {
  const ref = refOf(req, res);
  if (!ref) return undefined;
  try {
    const content = await iFinderProvider.content({ ref, user: req.user, format: 'text' });
    return sendProviderContent(res, content);
  } catch (error) {
    return sendFailure(res, error, 'iFinder document content error');
  }
});

/**
 * Metadata endpoint for fetching document details from iFinder.
 *
 * GET /api/integrations/ifinder/document/metadata?documentId=<id>[&searchProfile=<profile>]
 */
router.get('/document/metadata', authRequired, async (req, res) => {
  const ref = refOf(req, res);
  if (!ref) return undefined;
  try {
    const response = await iFinderProvider.metadata({ ref, user: req.user });
    logger.info('iFinder Metadata response', {
      component: 'iFinder',
      documentId: ref.id,
      response
    });
    return res.json(response);
  } catch (error) {
    return sendFailure(res, error, 'iFinder document metadata error');
  }
});

/**
 * The exchange provider, when iFinder uses the OIDC token exchange; null otherwise.
 * @returns {{name: string, displayName: string}|null}
 */
function exchangeProvider() {
  const platform = configCache.getPlatform() || {};
  if (platform.iFinder?.enabled !== true) return null;
  const name = getExchangeProviderName(platform);
  if (!name) return null;
  const provider = (platform.oidcAuth?.providers || []).find(entry => entry.name === name);
  return { name, displayName: provider?.displayName || name };
}

/**
 * Whether iHub holds a stored sign-in of the current user that iFinder calls
 * (and background runs) are authorized with. Only meaningful in the OIDC token
 * exchange mode; otherwise `enabled` is false and the profile page shows nothing.
 *
 * GET /api/integrations/ifinder/authorization
 */
router.get('/authorization', authRequired, async (req, res) => {
  try {
    const provider = exchangeProvider();
    if (!provider) return res.json({ enabled: false });
    const status = await getLoginTokenStatus(req.user.id, provider.name);
    return res.json({ enabled: true, provider, ...status });
  } catch (error) {
    return sendFailure(res, error, 'iFinder authorization status error');
  }
});

/**
 * Revoke the stored sign-in: iFinder calls, including scheduled tasks, stop
 * working until the user signs in again through the provider.
 *
 * DELETE /api/integrations/ifinder/authorization
 */
router.delete('/authorization', authRequired, async (req, res) => {
  try {
    const revoked = await deleteLoginTokens(req.user.id);
    if (revoked) {
      logAudit({
        req,
        action: 'delete',
        resource: 'iFinderAuthorization',
        resourceId: req.user.id,
        summary: 'Revoked the stored iFinder authorization',
        source: 'web'
      });
    }
    return res.json({ revoked });
  } catch (error) {
    return sendFailure(res, error, 'iFinder authorization revoke error');
  }
});

export default router;
