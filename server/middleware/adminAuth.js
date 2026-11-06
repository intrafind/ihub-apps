// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isAdmin } from '../utils/authorization.js';
import logger from '../utils/logger.js';

import { sendErrorResponse } from '../utils/responseHelpers.js';
/**
 * Admin authentication middleware
 * Enforces secure admin access based on user group permissions:
 * - Only authenticated users with admin groups (adminAccess: true) can access admin
 */
export function adminAuth(req, res, next) {
  try {
    if (isAdmin(req.user)) {
      return next();
    }

    // User is not authenticated or does not have admin privileges
    return sendErrorResponse(
      res,
      403,
      'Admin access requires authentication with admin privileges.'
    );
  } catch (error) {
    logger.error('Admin authentication error', { component: 'AdminAuth', error });
    return sendErrorResponse(res, 500, 'Internal server error during authentication');
  }
}
