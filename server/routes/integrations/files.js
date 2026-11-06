// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Documents by reference from an installed integration (the `files`
 * capability of its definition; `services/integrations/documentAccess.js`):
 *
 *   GET /api/integrations/:integration/files                        the probe
 *   GET /api/integrations/:integration/files/:id[?scope=]           the document's details
 *   GET /api/integrations/:integration/files/:id/content[?scope=&format=]
 *   GET /api/integrations/:integration/files/:id/content/:filename  the same bytes under a name
 *
 * The document is a resource of the integration: its id is a path segment (URL-encoded, as
 * iFinder's own API takes it), which leaves room for more under `/files/:id` and for a listing
 * at `/files`. `scope` (iFinder: the search profile) and `format` stay in the query. The
 * `:filename` segment changes nothing about what is served; it only gives a browser, a download
 * manager or a viewer a name to show when the integration sent none.
 *
 * `:integration` is an installation id. The installation must exist, be configured and
 * be granted to the user's groups before the connector is asked for anything;
 * the connector fetches with the signed-in user's own permissions in its system.
 * A built-in source provider that is not an installation (`project`) answers the
 * same routes under its own access rules: these are the one way to a source's content and
 * details, for Preview, Download, Add to email, Details and Open in App alike.
 *
 * @module routes/integrations/files
 */
import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { sendBadRequest, sendErrorResponse } from '../../utils/responseHelpers.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
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
const MAX_FILENAME_CHARS = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * What a request's `:integration` acts through, after the gate: the installation's connector,
 * or a built-in provider (`project`) with its own access rules. Null after answering.
 */
async function resolve(req, res) {
  if (!validateIdForPath(req.params.integration, 'integration', res)) return null;
  try {
    const provider = await resolveDocumentProvider(req.params.integration, req.user);
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
  const { id } = req.params;
  const { scope } = req.query;
  if (typeof id !== 'string' || !id || id.length > MAX_REF_ID_CHARS || CONTROL_CHARS.test(id)) {
    sendBadRequest(res, 'Invalid document id');
    return null;
  }
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > MAX_SCOPE_CHARS)) {
    sendBadRequest(res, 'Invalid scope parameter');
    return null;
  }
  return scope ? { id, scope } : { id };
}

/**
 * The content, named by the request's `:filename` when the integration named it neither in a
 * `Content-Disposition` nor as `fileName`, encoded so that any name is a valid header.
 */
function namedBy(filename, content) {
  if (!filename || content.contentDisposition || content.fileName) return content;
  return { ...content, contentDisposition: buildContentDisposition(filename) };
}

/** Answer a connector's failure with its status (a plain error is a logged 500). */
function sendFailure(res, error, what) {
  // A 401 here is the other system turning the user down, not iHub: the request has passed
  // `authRequired`. Sent as 401 it would reach the client as an expired iHub session (the api
  // client clears the token and raises the sign-in), so it is a 403.
  const upstream = Number.isInteger(error?.status) ? error.status : 500;
  const status = upstream === 401 ? 403 : upstream;
  if (status >= 500) logger.error(`Integration ${what} failed`, { component: 'files', error });
  // A 5xx message can carry the upstream response body; the log keeps it, the client gets a generic one.
  const message = status >= 500 ? undefined : error?.message;
  return sendErrorResponse(res, status, message || `Integration ${what} failed`);
}

router.get('/:integration/files', authRequired, async (req, res) => {
  if (!(await resolve(req, res))) return undefined;
  return res.json(describeDocumentProvider(req.params.integration));
});

router.get(
  ['/:integration/files/:id/content', '/:integration/files/:id/content/:filename'],
  authRequired,
  async (req, res) => {
    const format = req.query.format ?? 'original';
    if (!FORMATS.has(format)) return sendBadRequest(res, 'Invalid format parameter');
    const { filename } = req.params;
    if (
      filename !== undefined &&
      (!filename || filename.length > MAX_FILENAME_CHARS || CONTROL_CHARS.test(filename))
    ) {
      return sendBadRequest(res, 'Invalid file name');
    }
    const provider = await resolve(req, res);
    if (!provider) return undefined;
    const ref = refOf(req, res);
    if (!ref) return undefined;
    try {
      const content = await provider.content({ ref, user: req.user, format });
      return sendProviderContent(res, namedBy(filename, content));
    } catch (error) {
      return sendFailure(res, error, 'content');
    }
  }
);

router.get('/:integration/files/:id', authRequired, async (req, res) => {
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
