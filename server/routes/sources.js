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
import { getSourceProvider, hasSourceProvider } from '../services/sources/providers.js';
import logger from '../utils/logger.js';

const router = express.Router();

const FORMATS = new Set(['original', 'pdf', 'text']);
const MAX_REF_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;

/**
 * Write what a provider's `content` returned: its headers, then its stream or body.
 *
 * @param {import('express').Response} res
 * @param {Object} content
 */
export function sendProviderContent(res, content) {
  res.set('Content-Type', content.contentType || 'application/octet-stream');
  if (content.contentDisposition) res.set('Content-Disposition', content.contentDisposition);
  else if (content.fileName) {
    const fileName = String(content.fileName).replace(/["\\\r\n]/g, '_');
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  }
  if (content.contentLength && !content.body)
    res.set('Content-Length', String(content.contentLength));
  if (content.stream && typeof content.stream.pipe === 'function') {
    pipeContent(res, content.stream);
    return;
  }
  res.send(content.body ?? '');
}

/**
 * Stream a provider's content to the client. `pipe` alone neither handles an
 * error of the source (an upstream reset would crash the process, or leave the
 * request hanging) nor stops reading it when the client goes away.
 *
 * @param {import('express').Response} res
 * @param {import('node:stream').Readable} stream
 */
function pipeContent(res, stream) {
  let failed = false;
  stream.on('error', error => {
    if (failed) return;
    failed = true;
    logger.warn('Source content stream failed', { component: 'sources', error: error.message });
    stream.unpipe(res);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    for (const header of ['Content-Type', 'Content-Disposition', 'Content-Length']) {
      res.removeHeader(header);
    }
    sendErrorResponse(res, 502, 'Source content stream failed');
  });
  res.on('close', () => {
    if (!stream.readableEnded && typeof stream.destroy === 'function') stream.destroy();
  });
  stream.pipe(res);
}

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
  const provider = hasSourceProvider(providerId) ? await getSourceProvider(providerId) : null;
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
