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
 * Failures are thrown as `ServiceError`s for the error middleware to answer.
 * A built-in source provider that is not an installation (`project`) answers the
 * same routes under its own access rules: these are the one way to a source's content and
 * details, for Preview, Download, Add to email, Details and Open in App alike.
 *
 * @module routes/integrations/files
 */
import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { API_ERROR_CODES, GENERIC_ERROR_CODES } from '../../../shared/apiErrors.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { sendProviderContent } from '../../utils/sendProviderContent.js';
import logger from '../../utils/logger.js';
import {
  describeDocumentProvider,
  resolveDocumentProvider
} from '../../services/integrations/documentAccess.js';

const router = express.Router();

const FORMATS = new Set(['original', 'pdf', 'text']);
const MAX_REF_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;
const MAX_FILENAME_CHARS = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The generic registry code of an HTTP status (`404` → `NOT_FOUND`). */
const CODE_BY_STATUS = Object.freeze(
  Object.fromEntries(
    Object.entries(GENERIC_ERROR_CODES)
      .filter(([code]) => code !== 'VALIDATION_FAILED' && code !== 'TIMEOUT')
      .map(([code, status]) => [status, code])
  )
);

const badRequest = message => new ServiceError('BAD_REQUEST', message);

/**
 * What a request's `:integration` acts through, after the gate: the installation's connector,
 * or a built-in provider (`project`) with its own access rules. Throws when there is none: a
 * `DocumentAccessError` from the gate, or `INTEGRATION_NOT_FOUND`.
 */
async function resolve(req) {
  if (!isValidId(req.params.integration)) throw badRequest('Invalid integration ID');
  const provider = await resolveDocumentProvider(req.params.integration, req.user);
  if (!provider) throw new ServiceError('INTEGRATION_NOT_FOUND', 'No such integration');
  return provider;
}

/** The document a request names: `{ id, scope? }`; throws a 400 for an unusable id or scope. */
function refOf(req) {
  const { id } = req.params;
  const { scope } = req.query;
  if (typeof id !== 'string' || !id || id.length > MAX_REF_ID_CHARS || CONTROL_CHARS.test(id)) {
    throw badRequest('Invalid document id');
  }
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > MAX_SCOPE_CHARS)) {
    throw badRequest('Invalid scope parameter');
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

/**
 * A connector's failure as the error to throw. A 401 here is the other system turning the user
 * down, not iHub: the request has passed `authRequired`. Sent as 401 it would reach the client as
 * an expired iHub session (the api client clears the token and raises the sign-in), so it is a 403.
 * A 5xx message can carry the upstream response body; the log keeps it, the client gets a generic one.
 * A 4xx keeps the connector's own message and, when the connector names a registry code of that
 * status (`ORIGINAL_DISCARDED`), that code.
 */
function failureOf(error, what) {
  if (error instanceof ServiceError) return error;
  const upstream = Number.isInteger(error?.status) ? error.status : 500;
  if (upstream >= 500) {
    logger.error(`Integration ${what} failed`, { component: 'files', error });
    return new ServiceError(
      upstream === 500 ? 'INTERNAL_ERROR' : 'UPSTREAM_ERROR',
      `Integration ${what} failed`,
      { status: upstream, cause: error }
    );
  }
  const status = upstream === 401 ? 403 : upstream;
  const code =
    Object.hasOwn(API_ERROR_CODES, error?.code) && API_ERROR_CODES[error.code] === status
      ? error.code
      : (CODE_BY_STATUS[status] ?? 'BAD_REQUEST');
  return new ServiceError(code, error?.message || `Integration ${what} failed`, {
    status,
    cause: error
  });
}

router.get('/:integration/files', authRequired, async (req, res) => {
  await resolve(req);
  return res.json(describeDocumentProvider(req.params.integration));
});

router.get(
  ['/:integration/files/:id/content', '/:integration/files/:id/content/:filename'],
  authRequired,
  async (req, res) => {
    const format = req.query.format ?? 'original';
    if (!FORMATS.has(format)) throw badRequest('Invalid format parameter');
    const { filename } = req.params;
    if (
      filename !== undefined &&
      (!filename || filename.length > MAX_FILENAME_CHARS || CONTROL_CHARS.test(filename))
    ) {
      throw badRequest('Invalid file name');
    }
    const provider = await resolve(req);
    const ref = refOf(req);
    let content;
    try {
      content = await provider.content({ ref, user: req.user, format });
    } catch (error) {
      throw failureOf(error, 'content');
    }
    return sendProviderContent(res, namedBy(filename, content));
  }
);

router.get('/:integration/files/:id', authRequired, async (req, res) => {
  const provider = await resolve(req);
  const ref = refOf(req);
  if (typeof provider.metadata !== 'function') {
    throw new ServiceError('DOCUMENT_DETAILS_UNAVAILABLE', 'This integration has no details');
  }
  try {
    return res.json(await provider.metadata({ ref, user: req.user }));
  } catch (error) {
    throw failureOf(error, 'metadata');
  }
});

export default router;
