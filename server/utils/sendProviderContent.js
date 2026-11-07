// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Answer a request with what a document provider's `content` returned
 * (`services/sources/providers.js`): the headers, then the stream or body.
 * Used by the integration file routes (`routes/integrations/files.js`).
 *
 * @module utils/sendProviderContent
 */
import { sendErrorResponse } from './responseHelpers.js';
import logger from './logger.js';

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
