// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';
import { sendErrorResponse } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import {
  deleteLoginTokens,
  getExchangeProviderName,
  getLoginTokenStatus
} from '../../services/integrations/iFinderTokenProvider.js';
import { logAudit } from '../../services/AuditLogService.js';
import { getIFinderConfig } from '../../services/integrations/ifinderConfig.js';

const router = express.Router();

function sendFailure(res, error, message) {
  logger.error(message, { component: 'IFinder', error });
  return sendErrorResponse(
    res,
    Number.isInteger(error?.status) ? error.status : 500,
    error.message
  );
}

/**
 * The exchange provider, when iFinder uses the OIDC token exchange; null otherwise.
 * @returns {{name: string, displayName: string}|null}
 */
function exchangeProvider() {
  const platform = configCache.getPlatform() || {};
  const iFinder = getIFinderConfig();
  if (!iFinder.enabled) return null;
  const name = getExchangeProviderName(platform, iFinder);
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
