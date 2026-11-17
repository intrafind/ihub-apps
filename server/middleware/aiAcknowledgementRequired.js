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
  isMachinePrincipal
} from '../services/aiAcknowledgement/aiAcknowledgementService.js';
import { getAiAcknowledgementRepository } from '../services/aiAcknowledgement/AiAcknowledgementRepository.js';
import {
  isRememberedAcknowledged,
  rememberAcknowledged
} from '../services/aiAcknowledgement/acknowledgementCache.js';
import {
  ACK_COOKIE,
  hasValidAcknowledgementCookie,
  verifyAcknowledgement
} from '../services/aiAcknowledgement/guestAcknowledgement.js';
import { ServiceError } from '../utils/ServiceError.js';
import logger from '../utils/logger.js';

/**
 * Whether the caller has a valid acknowledgement.
 *
 * A signed-in user is judged by their acknowledgement document in the shared
 * store: one small read, the same answer on every worker and pod. When it says
 * "not yet", the signed cookie `POST /me` set counts too, unless it was issued
 * before an admin removed this user's acknowledgements
 * (`aiAcknowledgementsClearedAt`). The cookie also carries a user through a
 * store that cannot be read. An anonymous guest is judged by the cookie alone.
 *
 * Version bumps and "Remove all" need nothing here: `requiredVersion` and
 * `resetAt` in the settings already rule out older entries and cookies.
 *
 * @param {import('express').Request} req
 * @param {Object} settings - See `getSettings`
 * @returns {Promise<{acknowledged: boolean, record: Object|null}>} `record` is
 *   the user's acknowledgement document, null for a guest or a user without one
 */
export async function evaluateAcknowledgement(req, settings) {
  const userId = req.user?.id;
  if (!userId || userId === 'anonymous') {
    return { acknowledged: hasValidAcknowledgementCookie(req, settings), record: null };
  }
  let record = null;
  try {
    record = await getAiAcknowledgementRepository().get(userId);
  } catch (error) {
    logger.warn('Could not read the AI acknowledgement of a user; only the cookie counts', {
      component: 'AiAcknowledgement',
      userId,
      error
    });
  }
  if (isAcknowledged(record, settings)) return { acknowledged: true, record };
  const issuedAt = verifyAcknowledgement(req.cookies?.[ACK_COOKIE], `user:${userId}`, settings);
  const clearedAt = Date.parse(record?.aiAcknowledgementsClearedAt);
  const cookieCounts = issuedAt !== null && (!Number.isFinite(clearedAt) || issuedAt > clearedAt);
  return { acknowledged: cookieCounts, record };
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
    // Off or ask-only: a pure no-op, no store read.
    if (!settings.enabled || !settings.enforce) return next();
    if (isMachinePrincipal(req.user)) return next();

    // A signed-in user's "yes" is remembered on this worker (see
    // acknowledgementCache); "not yet" is always asked again.
    const userId = req.user?.id;
    const isUser = Boolean(userId) && userId !== 'anonymous';
    if (isUser && isRememberedAcknowledged(userId, settings)) return next();

    const { acknowledged } = await evaluateAcknowledgement(req, settings);
    if (acknowledged) {
      if (isUser) rememberAcknowledged(userId, settings);
      return next();
    }

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
