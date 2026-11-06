// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One route for every source provider's actions, so the sources panel acts on
 * a source by its `provider` and `ref` alone and a new integration needs no
 * route or client code of its own (see `services/sources/providers.js`).
 *
 *   GET /api/sources/:provider/content?id=<ref.id>[&scope=<ref.scope>][&format=original|pdf|text]
 *   GET /api/sources/:provider/metadata?id=<ref.id>[&scope=<ref.scope>]
 *
 * The provider fetches with the signed-in user's own permissions in its
 * system; this route only checks the request's shape.
 *
 * @module routes/sources
 */
import express from 'express';
import { authRequired } from '../middleware/authRequired.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { sendBadRequest, sendErrorResponse } from '../utils/responseHelpers.js';
import { sendProviderContent } from '../utils/sendProviderContent.js';
import {
  DocumentAccessError,
  resolveDocumentProvider
} from '../services/integrations/documentAccess.js';
import logger from '../utils/logger.js';

const router = express.Router();

const FORMATS = new Set(['original', 'pdf', 'text']);
const MAX_REF_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;

/**
 * The provider and ref a request names, or null after answering 400/404.
 */
async function resolve(req, res) {
  const { provider: providerId } = req.params;
  if (!validateIdForPath(providerId, 'source provider', res)) return null;
  const { id, scope } = req.query;
  if (typeof id !== 'string' || !id || id.length > MAX_REF_ID_CHARS) {
    sendBadRequest(res, 'id parameter is required');
    return null;
  }
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > MAX_SCOPE_CHARS)) {
    sendBadRequest(res, 'Invalid scope parameter');
    return null;
  }
  let provider;
  try {
    // A provider that is an installed integration passes the same gate as
    // `GET /api/integrations/:integration/files/*` (configured, granted).
    provider = await resolveDocumentProvider(providerId, req.user);
  } catch (error) {
    if (!(error instanceof DocumentAccessError)) throw error;
    res.status(error.status).json({ error: error.message, code: error.code });
    return null;
  }
  if (!provider) {
    res.status(404).json({ error: 'Source provider not found' });
    return null;
  }
  return { provider, ref: scope ? { id, scope } : { id } };
}

/** Answer a provider's failure with its status (a plain error is a logged 500). */
function sendFailure(res, error, what) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) logger.error(`Source ${what} failed`, { component: 'sources', error });
  return sendErrorResponse(res, status, error?.message || `Source ${what} failed`);
}

router.get('/:provider/content', authRequired, async (req, res) => {
  const format = req.query.format ?? 'original';
  if (!FORMATS.has(format)) return sendBadRequest(res, 'Invalid format parameter');
  const resolved = await resolve(req, res);
  if (!resolved) return undefined;
  try {
    const content = await resolved.provider.content({ ref: resolved.ref, user: req.user, format });
    return sendProviderContent(res, content);
  } catch (error) {
    return sendFailure(res, error, 'content');
  }
});

router.get('/:provider/metadata', authRequired, async (req, res) => {
  const resolved = await resolve(req, res);
  if (!resolved) return undefined;
  if (typeof resolved.provider.metadata !== 'function') {
    return res.status(404).json({ error: 'This source provider has no details' });
  }
  try {
    return res.json(await resolved.provider.metadata({ ref: resolved.ref, user: req.user }));
  } catch (error) {
    return sendFailure(res, error, 'metadata');
  }
});

export default router;
