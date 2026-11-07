// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  findCloudStorageProvider,
  mayUseCloudStorage
} from '../../services/integrations/cloudStorageConfig.js';
import {
  INTEGRATION_AUTH_REASONS,
  INTEGRATION_AUTH_REQUIRED,
  integrationAuthRequiredResult,
  isIntegrationAuthRequired
} from '../../services/integrations/auth/integrationAuthRequired.js';

import { sendErrorResponse } from '../../utils/responseHelpers.js';
/**
 * The OAuth callback (`/<installation id>/callback`) carries the installation
 * id in the path and is bound to the user by the server-side `state`; the
 * provider redirects the browser there, so it cannot name a query parameter.
 */
const CALLBACK_PATH = /^\/[^/]+\/callback$/;

/**
 * The installation a request names: `?providerId=` (every route).
 * @param {import('express').Request} req
 * @returns {string}
 */
export function requestedProviderId(req) {
  if (typeof req.query?.providerId === 'string' && req.query.providerId) {
    return req.query.providerId;
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
 *   refused with 404;
 * - an installation the user's groups do not grant
 *   (`groups.json` → `permissions.integrations`; #3093) is refused with 403;
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
      return sendErrorResponse(
        res,
        400,
        'providerId (the id of the storage provider installation) is required',
        { code: 'STORAGE_PROVIDER_REQUIRED' }
      );
    }
    const provider = findCloudStorageProvider(providerId, type);
    if (!provider) {
      return sendErrorResponse(res, 404, 'No such storage provider installation', {
        code: 'STORAGE_PROVIDER_NOT_FOUND'
      });
    }
    if (mayUseCloudStorage(req.user, provider)) return next();
    return sendErrorResponse(res, 403, 'Your groups may not use this storage provider', {
      code: 'INTEGRATION_NOT_GRANTED'
    });
  };
}

/**
 * Answer a browse or download request that failed because the user has no
 * usable connection to the provider with the one "connect first" body
 * (`INTEGRATION_AUTH_REQUIRED`, `reason`, `connectUrl`), status 409 — not 401,
 * which would read as an expired iHub session. The file browser then shows
 * the Connect card.
 *
 * @param {import('express').Response} res
 * @param {Error} error - What the provider service threw
 * @param {string} installationId - The provider installation the request named
 * @returns {boolean} True when a response was sent
 *
 * @example
 * } catch (error) {
 *   if (respondIfAuthRequired(res, error, requestedProviderId(req))) return;
 *   return sendInternalError(res, error, 'list items');
 * }
 */
export function respondIfAuthRequired(res, error, installationId) {
  if (!isIntegrationAuthRequired(error)) return false;
  const integration = error.integration || installationId;
  // The structured "connect first" result is the body the model's tools see; over HTTP it is
  // an ordinary problem: the code, and what the Connect card needs in `details`.
  const result = integrationAuthRequiredResult({
    integration,
    reason: error.reason || INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
    message: error.message,
    connectUrl: error.connectUrl || undefined,
    scopes: error.scopes || undefined
  });
  // `error` (the code) and `message` are the code and the detail of the answer
  const details = { ...result };
  delete details.error;
  delete details.message;
  sendErrorResponse(res, 409, result.message, { code: INTEGRATION_AUTH_REQUIRED, details });
  return true;
}

export default requireCloudStorageGrant;
