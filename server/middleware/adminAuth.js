// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isAdmin } from '../utils/authorization.js';
import logger from '../utils/logger.js';
import { ServiceError } from '../utils/ServiceError.js';

/**
 * Admin authentication middleware
 * Enforces secure admin access based on user group permissions:
 * - Only authenticated users with admin groups (adminAccess: true) can access admin
 *
 * Fails closed: it calls `next()` only for an admin; every other outcome is a thrown
 * ServiceError the error middleware answers.
 */
export function adminAuth(req, res, next) {
  let admin;
  try {
    admin = isAdmin(req.user);
  } catch (error) {
    logger.error('Admin authentication error', { component: 'AdminAuth', error });
    throw new ServiceError('INTERNAL_ERROR', 'Internal server error during authentication');
  }
  if (admin) return next();

  // User is not authenticated or does not have admin privileges
  throw new ServiceError(
    'FORBIDDEN',
    'Admin access requires authentication with admin privileges.'
  );
}
