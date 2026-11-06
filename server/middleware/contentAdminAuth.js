// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isContentAdmin } from '../utils/authorization.js';
import logger from '../utils/logger.js';

import { sendErrorResponse } from '../utils/responseHelpers.js';
/**
 * Content admin authentication middleware
 * Allows access for users with either adminAccess or contentAdmin permissions.
 * Used on apps, prompts, and sources routes.
 */
export function contentAdminAuth(req, res, next) {
  try {
    if (!req.user || req.user.id === 'anonymous') {
      return sendErrorResponse(res, 401, 'You must be logged in to access this resource.');
    }

    // Delegated and machine principals (personal API keys, OAuth clients,
    // agents) never edit content, regardless of the groups they carry.
    if (isContentAdmin(req.user)) {
      return next();
    }

    return sendErrorResponse(res, 403, 'Content admin access required.');
  } catch (error) {
    logger.error('Content admin authentication error', { component: 'ContentAdminAuth', error });
    return sendErrorResponse(res, 500, 'Internal server error during authentication');
  }
}
