// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Answer a request with a stream (a stored blob, a sealed file) instead of a
 * buffer.
 *
 * A stream can fail after part of it was sent: the storage backend goes away,
 * or a later part of an encrypted object does not verify
 * (`storage/BlobStore.js`, "Whole or as a stream"). The rule this module
 * implements for every route:
 *
 * - **Before the first byte**: nothing is sent, the response headers set here
 *   are taken back and the error is thrown, so the error middleware answers
 *   with a status as for any other failure.
 * - **After the first byte**: the response is destroyed. The client sees a
 *   transfer that broke off short of its `Content-Length`, which every HTTP
 *   client reports as a failed download. The response is never ended cleanly:
 *   that would hand out a cut file as the whole one.
 *
 * @module utils/streamResponse
 */
import { finished } from 'node:stream';

/**
 * The entity tag for content whose SHA-256 is recorded, or undefined.
 *
 * @param {unknown} sha256 - Hex digest of the content as it is served.
 * @returns {string|undefined} A strong ETag.
 */
export function etagOfSha256(sha256) {
  return typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? `"${sha256}"` : undefined;
}

/**
 * Whether a conditional request can be answered `304 Not Modified` for this
 * entity tag. Asked before anything is opened: the tag comes from the
 * metadata, so a `304` costs no read of the content.
 *
 * The `ETag` header is left on the response only when the answer is yes (a
 * `304` carries it). Otherwise the caller hands the tag to
 * {@link sendStream} with the other headers of the body, so that it does not
 * end up on an error answer.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string|undefined} etag - See {@link etagOfSha256}.
 * @returns {boolean} True when the caller should answer with
 *   `res.status(304).end()`.
 */
export function isFreshFor(req, res, etag) {
  if (!etag) return false;
  // Express compares the request's validators with the response's headers.
  res.setHeader('ETag', etag);
  const fresh = (req.method === 'GET' || req.method === 'HEAD') && req.fresh === true;
  if (!fresh) res.removeHeader('ETag');
  return fresh;
}

/**
 * Pipe a stream into the response and wait until the response is done.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('node:stream').Readable} stream - The body. Destroyed when
 *   the client goes away, so its source (a file, a bucket request) is released.
 * @param {Object} [options]
 * @param {Record<string, string|number|undefined>} [options.headers] - Response
 *   headers that describe the body or are only right for it (`Content-Type`,
 *   `Content-Length`, `ETag`, `Cache-Control`, …). Set here; removed again
 *   when the stream fails before the first byte, so they do not end up on the
 *   error answer: an error with `Cache-Control: immutable` would be kept by
 *   the browser for as long as the content.
 * @returns {Promise<void>} Resolves when the response finished, the client
 *   closed the connection (also when it had closed it before this was
 *   called), or the response was destroyed after a late failure.
 * @throws What the stream failed with, when nothing was sent yet.
 *
 * @example
 * const blob = await blobs.openRead(ns, key);
 * await sendStream(req, res, blob.stream, {
 *   headers: { 'Content-Type': type, 'Content-Length': String(blob.bytes), ETag: etag }
 * });
 */
export async function sendStream(req, res, stream, { headers = {} } = {}) {
  // The client hung up while the route was still working (authorization, the
  // metadata, opening the stream): `'close'` has been emitted and will not be
  // again, and a pipe into this response would wait for a `'drain'` that
  // never comes, with the source open.
  if (res.destroyed || res.closed || res.writableEnded) {
    stream.destroy();
    return;
  }
  const names = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    res.setHeader(name, value);
    names.push(name);
  }
  if (req?.method === 'HEAD') {
    stream.destroy();
    res.end();
    return;
  }
  const failure = await new Promise(resolve => {
    // `finished` also reports a stream that failed before this was called,
    // which an `'error'` listener attached now would never hear of.
    finished(stream, { writable: false }, error => {
      if (error) resolve(error);
    });
    res.once('close', () => {
      // The client went away (or the response is done): release the source.
      // Resolved first, so that the source's own "closed early" is not taken
      // for a failure.
      resolve(null);
      stream.destroy();
    });
    res.once('finish', () => resolve(null));
    stream.pipe(res);
  });
  if (!failure) return;
  stream.unpipe(res);
  stream.destroy();
  if (res.headersSent) {
    res.destroy(failure);
    return;
  }
  for (const name of names) res.removeHeader(name);
  throw failure;
}
