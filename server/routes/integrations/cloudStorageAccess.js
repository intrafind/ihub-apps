// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  findCloudStorageProvider,
  mayUseCloudStorage
} from '../../services/integrations/cloudStorageConfig.js';

/**
 * Paths of a storage router that stay open whatever the grant: a user whose
 * group lost a provider can still see that a connection exists and remove it.
 */
const ALWAYS_OPEN_PATHS = new Set(['/status', '/disconnect']);

/**
 * Router middleware for the cloud storage routes (`office365`, `googledrive`,
 * `nextcloud`): a request that names a provider (`?providerId=`) is refused
 * with 403 when the user's groups do not grant the provider's installation
 * (`groups.json` → `permissions.integrations`; #3093). Starting a connection
 * (`/auth`) and browsing or downloading files are covered; `/status` and
 * `/disconnect` are not, and a request that names no provider, or one that
 * does not exist, is left to the route (which answers 400 or 404 itself).
 *
 * @param {string} type - Provider type: `office365` | `googledrive` | `nextcloud`
 * @returns {import('express').RequestHandler}
 *
 * @example
 * router.use(requireFeature('integrations'));
 * router.use(requireCloudStorageGrant('office365'));
 */
export function requireCloudStorageGrant(type) {
  return (req, res, next) => {
    if (ALWAYS_OPEN_PATHS.has(req.path)) return next();
    const providerId = typeof req.query?.providerId === 'string' ? req.query.providerId : '';
    if (!providerId) return next();
    const provider = findCloudStorageProvider(providerId, type);
    if (!provider || mayUseCloudStorage(req.user, provider)) return next();
    return res.status(403).json({
      error: 'Your groups may not use this storage provider',
      code: 'INTEGRATION_NOT_GRANTED'
    });
  };
}

export default requireCloudStorageGrant;
