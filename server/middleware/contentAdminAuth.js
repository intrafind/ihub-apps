// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isContentAdmin } from '../utils/authorization.js';
import logger from '../utils/logger.js';

import { ServiceError } from '../utils/ServiceError.js';
/**
 * Content admin authentication middleware
 * Allows access for users with either adminAccess or contentAdmin permissions.
 * Used on apps, prompts, and sources routes.
 */
export function contentAdminAuth(req, res, next) {
  if (!req.user || req.user.id === 'anonymous') {
    throw new ServiceError('AUTH_REQUIRED', 'You must be logged in to access this resource.');
  }

  // Delegated and machine principals (personal API keys, OAuth clients,
  // agents) never edit content, regardless of the groups they carry.
  let allowed;
  try {
    allowed = isContentAdmin(req.user);
  } catch (error) {
    logger.error('Content admin authentication error', { component: 'ContentAdminAuth', error });
    throw new ServiceError('INTERNAL_ERROR', 'Internal server error during authentication');
  }
  if (allowed) return next();

  throw new ServiceError('FORBIDDEN', 'Content admin access required.');
}
