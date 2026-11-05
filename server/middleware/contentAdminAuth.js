// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isContentAdmin } from '../utils/authorization.js';
import logger from '../utils/logger.js';

/**
 * Content admin authentication middleware
 * Allows access for users with either adminAccess or contentAdmin permissions.
 * Used on apps, prompts, and sources routes.
 */
export function contentAdminAuth(req, res, next) {
  try {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'You must be logged in to access this resource.'
      });
    }

    // Delegated and machine principals (personal API keys, OAuth clients,
    // agents) never edit content, regardless of the groups they carry.
    if (isContentAdmin(req.user)) {
      return next();
    }

    return res.status(403).json({
      error: 'Access denied',
      message: 'Content admin access required.'
    });
  } catch (error) {
    logger.error('Content admin authentication error', { component: 'ContentAdminAuth', error });
    return res.status(500).json({
      error: 'Authentication system error',
      message: 'Internal server error during authentication'
    });
  }
}
