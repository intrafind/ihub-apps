import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import { httpFetch } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';
import iFinderService from '../../services/integrations/iFinderService.js';

const router = express.Router();

/**
 * Proxy endpoint for fetching documents from iFinder.
 * Resolves the real download link (with opaque access token) by searching iFinder
 * for the document ID, then fetches and streams the binary to the client.
 *
 * GET /api/integrations/ifinder/document?documentId=<id>[&searchProfile=<profile>][&convertToPdf=true]
 */
router.get('/document', authRequired, async (req, res) => {
  const { documentId, searchProfile, convertToPdf } = req.query;

  if (!documentId) {
    return res.status(400).json({ error: 'documentId parameter is required' });
  }

  try {
    // Resolve the real download link from iFinder (contains opaque access token)
    let documentUrl = await iFinderService.resolveDocumentLink({
      documentId,
      user: req.user,
      searchProfile: searchProfile || undefined
    });

    // Add convertToPdf if requested
    if (convertToPdf === 'true' && !documentUrl.includes('convertToPdf')) {
      documentUrl += (documentUrl.includes('?') ? '&' : '?') + 'convertToPdf=true';
    }

    // Build absolute URL
    const iFinderConfig = iFinderService.getConfig();
    const baseUrl = iFinderConfig.baseUrl.replace(/\/+$/, '');
    const fullUrl = `${baseUrl}/${documentUrl.replace(/^\//, '')}`;

    logger.debug(`iFinder document proxy: fetching document ${documentId}`);

    const authHeader = getIFinderAuthorizationHeader(req.user);
    const response = await httpFetch(fullUrl, {
      headers: { Authorization: authHeader }
    });

    if (!response.ok) {
      logger.warn(
        `iFinder document proxy returned ${response.status} for documentId=${documentId}`
      );
      return res.status(response.status).json({
        error: `iFinder returned ${response.status}`
      });
    }

    // Forward content headers
    for (const h of ['content-type', 'content-disposition', 'content-length']) {
      const v = response.headers.get(h);
      if (v) res.set(h, v);
    }

    // Stream response body to client (node-fetch returns a Node.js Readable, not a WHATWG ReadableStream)
    response.body.pipe(res);
  } catch (error) {
    logger.error('iFinder document proxy error:', error.message);
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * Text content fallback endpoint for documents without a binary access URL.
 * Uses iFinderService.getContent() to retrieve the document's text content.
 *
 * GET /api/integrations/ifinder/document/content?documentId=<id>[&searchProfile=<profile>]
 */
router.get('/document/content', authRequired, async (req, res) => {
  const { documentId, searchProfile } = req.query;

  if (!documentId) {
    return res.status(400).json({ error: 'documentId parameter is required' });
  }

  try {
    const result = await iFinderService.getContent({
      documentId,
      chatId: 'ui-download',
      user: req.user,
      searchProfile: searchProfile || undefined
    });

    const title = result.metadata?.title || documentId;
    const safeTitle = title.replace(/[^a-zA-Z0-9._-]/g, '_');

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${safeTitle}.txt"`);
    res.send(result.content || '');
  } catch (error) {
    logger.error('iFinder document content error:', error.message);
    const status = error.message.includes('not found')
      ? 404
      : error.message.includes('Access denied')
        ? 403
        : 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * Metadata endpoint for fetching document details from iFinder.
 * Uses the search API (via getMetadata) which accepts raw document_id values
 * from the conversation API — unlike the public document API which requires
 * a clean ID without prefixes.
 *
 * GET /api/integrations/ifinder/document/metadata?documentId=<id>[&searchProfile=<profile>]
 */
router.get('/document/metadata', authRequired, async (req, res) => {
  const { documentId, searchProfile } = req.query;

  if (!documentId) {
    return res.status(400).json({ error: 'documentId parameter is required' });
  }

  try {
    const result = await iFinderService.getMetadata({
      documentId,
      chatId: 'ui-metadata',
      user: req.user,
      searchProfile: searchProfile || undefined
    });

    // Safely extract a scalar — normalized results can be scalar or array
    const scalar = (val, fallback = '') =>
      Array.isArray(val) && val.length > 0 ? val[0] : val || fallback;

    const fileSizeBytes = Number(
      scalar(result.size) || scalar(result.file?.size) || scalar(result.contentLength) || 0
    );

    // Normalize navigationTree: iFinder returns breadcrumb segments joined by \u001f (Unit Separator)
    let navigationTree = result.navigationTree;
    if (typeof navigationTree === 'string') {
      navigationTree = navigationTree.split('\u001f').filter(Boolean);
    } else if (Array.isArray(navigationTree)) {
      navigationTree = navigationTree.flatMap(s =>
        typeof s === 'string' ? s.split('\u001f').filter(Boolean) : [s]
      );
    }

    const response = {
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
    logger.info(`iFinder Metadata response for ${documentId}: ${JSON.stringify(response)}`);
    res.json(response);
  } catch (error) {
    logger.error('iFinder document metadata error:', error.message);
    const status = error.message.includes('not found')
      ? 404
      : error.message.includes('Access denied')
        ? 403
        : 500;
    res.status(status).json({ error: error.message });
  }
});

export default router;
