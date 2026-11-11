// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The 428 guard of the AI-use acknowledgement (#3326).
 *
 * Mounted after the auth middleware (so a 401/403 wins over a 428) and before
 * any validation or side effect of a human, session-bound LLM start: the chat
 * POST, workflow execution and its chat step, and agent profile runs. One
 * middleware, so another entry point is one more argument in its route.
 *
 * Machine principals (OAuth clients, personal API keys, delegated tokens,
 * agents) are exempt: nobody can click a dialog there. The inference API, MCP
 * and A2A do not use this middleware.
 *
 * @module middleware/aiAcknowledgementRequired
 */
import {
  getSettings,
  isAcknowledged,
  isMachinePrincipal,
  usersFilePath
} from '../services/aiAcknowledgement/aiAcknowledgementService.js';
import { hasValidAcknowledgementCookie } from '../services/aiAcknowledgement/guestAcknowledgement.js';
import { loadUsers, loadUsersFresh } from '../utils/userManager.js';
import { ServiceError } from '../utils/ServiceError.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

/**
 * Whether the caller has a valid acknowledgement.
 *
 * A principal with a users.json record is judged by it (re-read once from the
 * store before refusing: another worker may have written it milliseconds ago).
 * Anyone else, an anonymous guest above all, by the signed cookie.
 *
 * @param {import('express').Request} req
 * @param {Object} settings - See `getSettings`
 * @returns {Promise<{acknowledged: boolean, hasRecord: boolean}>}
 */
export async function evaluateAcknowledgement(req, settings) {
  const userId = req.user?.id;
  const file = usersFilePath(configCache.getPlatform() || {});
  const record = id => {
    if (!id || id === 'anonymous') return null;
    const users = loadUsers(file).users || {};
    return Object.hasOwn(users, id) ? users[id] : null;
  };

  let user = record(userId);
  if (user) {
    if (isAcknowledged(user, settings)) return { acknowledged: true, hasRecord: true };
    try {
      const fresh = (await loadUsersFresh(file)).users || {};
      user = Object.hasOwn(fresh, userId) ? fresh[userId] : null;
    } catch (error) {
      logger.debug('Could not re-read users for the acknowledgement check', {
        component: 'AiAcknowledgement',
        error
      });
    }
    return { acknowledged: user ? isAcknowledged(user, settings) : false, hasRecord: true };
  }
  return { acknowledged: hasValidAcknowledgementCookie(req, settings), hasRecord: false };
}

/**
 * Express middleware: answer `428 AI_ACKNOWLEDGEMENT_REQUIRED` unless the
 * caller acknowledged the current version.
 *
 * @type {import('express').RequestHandler}
 */
export async function aiAcknowledgementRequired(req, res, next) {
  try {
    const settings = getSettings();
    // Off or ask-only: a pure no-op, no users.json read.
    if (!settings.enabled || !settings.enforce) return next();
    if (isMachinePrincipal(req.user)) return next();

    const { acknowledged } = await evaluateAcknowledgement(req, settings);
    if (acknowledged) return next();

    logger.debug('AI acknowledgement required', {
      component: 'AiAcknowledgement',
      userId: req.user?.id,
      url: req.originalUrl
    });
    throw new ServiceError(
      'AI_ACKNOWLEDGEMENT_REQUIRED',
      'Confirm the AI usage notice before sending messages',
      { status: 428, details: { requiredVersion: settings.requiredVersion } }
    );
  } catch (error) {
    return next(error);
  }
}

export default aiAcknowledgementRequired;
