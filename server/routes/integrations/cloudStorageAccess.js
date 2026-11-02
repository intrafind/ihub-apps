// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  findCloudStorageProvider,
  mayUseCloudStorage
} from '../../services/integrations/cloudStorageConfig.js';

/**
 * Paths of a storage router that stay open whatever the grant and whether the
 * installation still exists: a user whose group lost a provider, or whose
 * provider was removed, can still see that a connection exists and remove it.
 */
const ALWAYS_OPEN_PATHS = new Set(['/status', '/disconnect']);

/**
 * The OAuth callback (`/<installation id>/callback`) carries the installation
 * id in the path and is bound to the user by the signed `state` ticket; the
 * provider redirects the browser there, so it cannot name a query parameter.
 */
const CALLBACK_PATH = /^\/[^/]+\/callback$/;

/**
 * The installation a request names: `?providerId=` (every route), or
 * `providerId` in the JSON body (`POST /disconnect`).
 * @param {import('express').Request} req
 * @returns {string}
 */
export function requestedProviderId(req) {
  if (typeof req.query?.providerId === 'string' && req.query.providerId) {
    return req.query.providerId;
  }
  if (typeof req.body?.providerId === 'string' && req.body.providerId) {
    return req.body.providerId;
  }
  return '';
}

/**
 * Router middleware for the storage provider routes (`office365`,
 * `googledrive`, `nextcloud`). Every request names one installation of the
 * provider by its id (`?providerId=<installation id>`): there can be several
 * installations of each provider, so a request without one is refused with
 * 400. Then:
 *
 * - an installation that does not exist (or belongs to another provider) is
 *   refused with 404 — except on `/status` and `/disconnect`, which answer for
 *   connections whose installation is gone;
 * - an installation the user's groups do not grant
 *   (`groups.json` → `permissions.integrations`; #3093) is refused with 403 —
 *   again except `/status` and `/disconnect`;
 * - the OAuth callback (`/<installation id>/callback`) is left to the route.
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
    if (CALLBACK_PATH.test(req.path)) return next();
    const providerId = requestedProviderId(req);
    if (!providerId) {
      return res.status(400).json({
        error: 'providerId (the id of the storage provider installation) is required',
        code: 'STORAGE_PROVIDER_REQUIRED'
      });
    }
    if (ALWAYS_OPEN_PATHS.has(req.path)) return next();
    const provider = findCloudStorageProvider(providerId, type);
    if (!provider) {
      return res.status(404).json({
        error: 'No such storage provider installation',
        code: 'STORAGE_PROVIDER_NOT_FOUND'
      });
    }
    if (mayUseCloudStorage(req.user, provider)) return next();
    return res.status(403).json({
      error: 'Your groups may not use this storage provider',
      code: 'INTEGRATION_NOT_GRANTED'
    });
  };
}

export default requireCloudStorageGrant;
