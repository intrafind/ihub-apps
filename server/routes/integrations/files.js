// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Documents by reference from an installed integration (the `files`
 * capability of its definition; `services/integrations/documentAccess.js`):
 *
 *   GET /api/integrations/:id/files                       the probe
 *   GET /api/integrations/:id/files/content?id=&scope=&format=
 *   GET /api/integrations/:id/files/metadata?id=&scope=
 *
 * `:id` is an installation id. The installation must exist, be configured and
 * be granted to the user's groups before the connector is asked for anything;
 * the connector fetches with the signed-in user's own permissions in its system.
 * A built-in source provider that is not an installation (`project`) answers the
 * same routes under its own access rules, so "Open in App" works for its documents.
 *
 * @module routes/integrations/files
 */
import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { sendBadRequest, sendErrorResponse } from '../../utils/responseHelpers.js';
import { sendProviderContent } from '../../utils/sendProviderContent.js';
import logger from '../../utils/logger.js';
import {
  DocumentAccessError,
  describeDocumentProvider,
  resolveDocumentProvider
} from '../../services/integrations/documentAccess.js';

const router = express.Router();

const FORMATS = new Set(['original', 'pdf', 'text']);
const MAX_REF_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;

// The feature gate sits on the file routes below, not on the router: this router is mounted at
// `/api/integrations` ahead of other integration routes (scopes, the iFinder authorization),
// which must keep answering when the integrations feature is off.
const featureGate = requireFeature('integrations');

/**
 * What a request's `:id` acts through, after the gate: the installation's connector,
 * or a built-in provider (`project`) with its own access rules. Null after answering.
 */
async function resolve(req, res) {
  if (!validateIdForPath(req.params.id, 'integration', res)) return null;
  try {
    const provider = await resolveDocumentProvider(req.params.id, req.user);
    if (provider) return provider;
    res.status(404).json({ error: 'No such integration', code: 'INTEGRATION_NOT_FOUND' });
    return null;
  } catch (error) {
    if (error instanceof DocumentAccessError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return null;
    }
    throw error;
  }
}

/** The document a request names: `{ id, scope? }`, or null after answering 400. */
function refOf(req, res) {
  const { id, scope } = req.query;
  if (typeof id !== 'string' || !id || id.length > MAX_REF_ID_CHARS) {
    sendBadRequest(res, 'id parameter is required');
    return null;
  }
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > MAX_SCOPE_CHARS)) {
    sendBadRequest(res, 'Invalid scope parameter');
    return null;
  }
  return scope ? { id, scope } : { id };
}

/** Answer a connector's failure with its status (a plain error is a logged 500). */
function sendFailure(res, error, what) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) logger.error(`Integration ${what} failed`, { component: 'files', error });
  // A 5xx message can carry the upstream response body; the log keeps it, the client gets a generic one.
  const message = status >= 500 ? undefined : error?.message;
  return sendErrorResponse(res, status, message || `Integration ${what} failed`);
}

router.get('/:id/files', featureGate, authRequired, async (req, res) => {
  if (!(await resolve(req, res))) return undefined;
  return res.json(describeDocumentProvider(req.params.id));
});

router.get('/:id/files/content', featureGate, authRequired, async (req, res) => {
  const format = req.query.format ?? 'original';
  if (!FORMATS.has(format)) return sendBadRequest(res, 'Invalid format parameter');
  const provider = await resolve(req, res);
  if (!provider) return undefined;
  const ref = refOf(req, res);
  if (!ref) return undefined;
  try {
    const content = await provider.content({ ref, user: req.user, format });
    return sendProviderContent(res, content);
  } catch (error) {
    return sendFailure(res, error, 'content');
  }
});

router.get('/:id/files/metadata', featureGate, authRequired, async (req, res) => {
  const provider = await resolve(req, res);
  if (!provider) return undefined;
  const ref = refOf(req, res);
  if (!ref) return undefined;
  if (typeof provider.metadata !== 'function') {
    return res.status(404).json({ error: 'This integration has no details' });
  }
  try {
    return res.json(await provider.metadata({ ref, user: req.user }));
  } catch (error) {
    return sendFailure(res, error, 'metadata');
  }
});

export default router;
