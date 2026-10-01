/**
 * The `ifinder` source provider: a document's content and details, fetched
 * with the signed-in user's own iFinder permissions. Serves the sources the
 * iFinder tools and iAssistant report (`ref: { id: documentId, scope:
 * searchProfile }`), and the iFinder document routes
 * (`routes/integrations/ifinder.js`).
 *
 * @module services/sources/providers/ifinder
 */
import { getIFinderAuthorizationHeader } from '../../../utils/iFinderJwt.js';
import { httpFetch } from '../../../utils/httpConfig.js';
import logger from '../../../utils/logger.js';
import iFinderService from '../../integrations/iFinderService.js';
import { sourceProviderError } from '../providers.js';

/** The status an iFinder service error stands for. */
function statusOf(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const message = String(error?.message || '');
  if (message.includes('not found')) return 404;
  if (message.includes('Access denied')) return 403;
  return 500;
}

/** Throw an iFinder service error as a provider error with the status it stands for. */
function rethrow(error) {
  throw sourceProviderError(statusOf(error), error?.message || 'iFinder request failed');
}

/**
 * The document's text, for documents iFinder offers no binary of.
 */
async function textContent({ ref, user }) {
  try {
    const result = await iFinderService.getContent({
      documentId: ref.id,
      chatId: 'ui-download',
      user,
      searchProfile: ref.scope || undefined
    });
    const title = result.metadata?.title || ref.id;
    return {
      contentType: 'text/plain; charset=utf-8',
      fileName: `${String(title).replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`,
      body: result.content || ''
    };
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * @param {{ref: {id: string, scope?: string}, user: Object, format?: 'original'|'pdf'|'text'}} request
 * @returns {Promise<Object>} see `services/sources/providers.js`
 */
async function content({ ref, user, format = 'original' }) {
  if (format === 'text') return textContent({ ref, user });
  let documentUrl;
  try {
    // The real download link carries an opaque access token.
    documentUrl = await iFinderService.resolveDocumentLink({
      documentId: ref.id,
      user,
      searchProfile: ref.scope || undefined
    });
  } catch (error) {
    return rethrow(error);
  }
  if (format === 'pdf' && !documentUrl.includes('convertToPdf')) {
    documentUrl += (documentUrl.includes('?') ? '&' : '?') + 'convertToPdf=true';
  }
  const baseUrl = iFinderService.getConfig().baseUrl.replace(/\/+$/, '');
  const fullUrl = `${baseUrl}/${documentUrl.replace(/^\//, '')}`;
  logger.debug('iFinder document proxy: fetching document', {
    component: 'iFinder',
    documentId: ref.id
  });
  const response = await httpFetch(fullUrl, {
    headers: { Authorization: getIFinderAuthorizationHeader(user) }
  });
  if (!response.ok) {
    logger.warn('iFinder document proxy returned non-OK status', {
      component: 'iFinder',
      status: response.status,
      documentId: ref.id
    });
    throw sourceProviderError(response.status, `iFinder returned ${response.status}`);
  }
  return {
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    contentDisposition: response.headers.get('content-disposition') || undefined,
    contentLength: response.headers.get('content-length') || undefined,
    // node-fetch returns a Node.js Readable, not a WHATWG ReadableStream.
    stream: response.body
  };
}

/** A value that may arrive as a scalar or a list, as a scalar. */
function scalar(value, fallback = '') {
  return Array.isArray(value) && value.length > 0 ? value[0] : value || fallback;
}

/**
 * The document's details. Uses the search API (via `getMetadata`), which
 * accepts raw `document_id` values from the conversation API — unlike the
 * public document API, which requires a clean id without prefixes.
 *
 * @param {{ref: {id: string, scope?: string}, user: Object}} request
 * @returns {Promise<Object>}
 */
async function metadata({ ref, user }) {
  let result;
  try {
    result = await iFinderService.getMetadata({
      documentId: ref.id,
      chatId: 'ui-metadata',
      user,
      searchProfile: ref.scope || undefined
    });
  } catch (error) {
    return rethrow(error);
  }
  const fileSizeBytes = Number(
    scalar(result.size) || scalar(result.file?.size) || scalar(result.contentLength) || 0
  );
  // iFinder returns breadcrumb segments joined by \u001f (Unit Separator).
  let navigationTree = result.navigationTree;
  if (typeof navigationTree === 'string') {
    navigationTree = navigationTree.split('\u001f').filter(Boolean);
  } else if (Array.isArray(navigationTree)) {
    navigationTree = navigationTree.flatMap(segment =>
      typeof segment === 'string' ? segment.split('\u001f').filter(Boolean) : [segment]
    );
  }
  return {
    title: scalar(result.title),
    filename: scalar(result.filename) || scalar(result.file?.name),
    fileSize: fileSizeBytes || null,
    sizeFormatted: result.sizeFormatted || null,
    application: scalar(result.application),
    mediaType: scalar(result.mediaType),
    sourceType: scalar(result.sourceType),
    sourceName: scalar(result.sourceName),
    author: scalar(result.author) || scalar(result.file?.author),
    modificationDate: scalar(result.modificationDate),
    indexingDate: scalar(result.indexingDate),
    deepLink: scalar(result.deepLink) || scalar(result.accessInfo?.deepLink),
    language: scalar(result.language),
    navigationTree: navigationTree?.length > 0 ? navigationTree : null
  };
}

export default { id: 'ifinder', content, metadata };
