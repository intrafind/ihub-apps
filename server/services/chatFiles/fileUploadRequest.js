// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * HTTP-level helpers shared by every route that ingests a chat or scheduled
 * task file (`POST /api/chats/:chatId/files`,
 * `POST /api/scheduled-tasks/:taskId/files`): multipart parsing, the request
 * body shapes, and the translation of ingest failures into responses.
 *
 * A multipart file is never held in memory: it is written to a spool file while
 * it is received (`services/uploads/uploadSpool.js`: a private directory per
 * request under `contents/data/tmp/chat-uploads/`), read from there for the
 * extraction and streamed from there into the store. The spool directory is
 * removed when the request ends, whatever its outcome ({@link receiveSpooledUpload}).
 *
 * @module services/chatFiles/fileUploadRequest
 */
import multer from 'multer';
import { ServiceError } from '../../utils/ServiceError.js';
import { ChatFileQuotaError } from './ChatFileRepository.js';
import { ChatFileError, ingestChatFile } from './ChatFileService.js';
import { ingestFromSource } from './fileSources.js';
import {
  CHAT_UPLOAD_SPOOL_AREA,
  removeSpoolDir,
  spoolRoot,
  spoolStorage
} from '../uploads/uploadSpool.js';

/** The file size limit when the policy sets none (`maxFileBytes <= 0`). */
const FALLBACK_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Where a request keeps the state of its spooled upload. */
const SPOOL = Symbol('uploadSpool');

/**
 * Remove the spool directory of a request, unless an ingest is reading it right
 * now (it is removed when that ends). Safe to call any number of times.
 *
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
export async function removeUploadSpool(req) {
  const spool = req?.[SPOOL];
  if (!spool?.dir) return;
  // `withUploadSpool` removes it when the ingest is done.
  if (spool.busy > 0) return;
  const { dir } = spool;
  spool.dir = null;
  await removeSpoolDir(dir);
}

/**
 * Run `task` while the spool file of `req` is in use: a response that closes
 * meanwhile (the client went away) does not remove the file under it.
 *
 * @template T
 * @param {import('express').Request} req
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function withUploadSpool(req, task) {
  const spool = req?.[SPOOL];
  if (!spool) return task();
  spool.busy += 1;
  try {
    return await task();
  } finally {
    spool.busy -= 1;
    // The upload is stored or refused: the spool file has done its work.
    if (spool.busy === 0) await removeUploadSpool(req);
  }
}

/**
 * The signal of a request's upload: aborted when the client goes away before
 * the response is written.
 *
 * @param {import('express').Request} req
 * @returns {AbortSignal|null}
 */
export function uploadAbortSignal(req) {
  return req?.[SPOOL]?.abort.signal || null;
}

/**
 * Receive the one file of a multipart request into a spool file
 * (`req.file.path`, `req.file.size`; never `req.file.buffer`) and its text
 * fields into `req.body`.
 *
 * The size limit is enforced while receiving: nothing beyond `maxFileBytes` is
 * written, and the partial file is removed. The spool directory is removed when
 * the response closes — after success, a refusal, an exception or a client that
 * went away — so the caller has nothing to clean up; {@link withUploadSpool}
 * removes it earlier, as soon as the ingest is done.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Object} options
 * @param {number} options.maxFileBytes - `<= 0`: the default of 25 MB.
 * @param {string} [options.fieldName='file']
 * @returns {Promise<void>}
 * @throws {import('multer').MulterError|Error} What multer reports; the caller translates it.
 */
export function receiveSpooledUpload(req, res, { maxFileBytes, fieldName = 'file' }) {
  const spool = { dir: null, busy: 0, abort: new AbortController() };
  req[SPOOL] = spool;
  // One hook for every way a request ends. `close` follows `finish` on a
  // response that was sent, and comes alone when the client went away.
  res.once?.('close', () => {
    if (!res.writableFinished) spool.abort.abort();
    removeUploadSpool(req).catch(() => {});
  });
  const upload = multer({
    storage: spoolStorage({
      root: () => spoolRoot(CHAT_UPLOAD_SPOOL_AREA),
      onDir: (_request, dir) => {
        spool.dir = dir;
      }
    }),
    // Browsers send file names as UTF-8; multer reads them as latin1 unless told.
    defParamCharset: 'utf8',
    limits: {
      fileSize: maxFileBytes > 0 ? maxFileBytes : FALLBACK_MAX_FILE_BYTES,
      files: 1,
      fields: 10
    }
  }).single(fieldName);

  return new Promise((resolve, reject) => {
    upload(req, res, async error => {
      if (!error) return resolve();
      // Refused while receiving: nothing of it stays on disk.
      await removeUploadSpool(req);
      reject(error);
    });
  });
}

/**
 * Whether `req` is a `multipart/form-data` request.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isMultipartRequest(req) {
  return typeof req.is === 'function'
    ? Boolean(req.is('multipart/form-data'))
    : /^multipart\/form-data/i.test(String(req.headers?.['content-type'] || ''));
}

/**
 * Parse a single file upload from a multipart request into `req.file` (a spool
 * file: `path` and `size`) and `req.body`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} maxFileBytes
 * @returns {Promise<void>}
 * @throws {ChatFileQuotaError} `QUOTA_FILE_BYTES` (413) when the file is over the limit.
 * @throws {ServiceError} `BAD_REQUEST` for more than one file or an unreadable upload.
 */
export async function parseChatFileMultipart(req, res, maxFileBytes) {
  try {
    await receiveSpooledUpload(req, res, { maxFileBytes });
  } catch (error) {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      throw new ChatFileQuotaError(
        'QUOTA_FILE_BYTES',
        `A file may be at most ${Math.floor(maxFileBytes / (1024 * 1024)) || 1} MB`,
        { limit: maxFileBytes }
      );
    }
    if (error?.code === 'LIMIT_FILE_COUNT' || error?.code === 'LIMIT_UNEXPECTED_FILE') {
      throw new ServiceError('BAD_REQUEST', 'Send at most one file in the "file" field');
    }
    throw new ServiceError('BAD_REQUEST', error?.message || 'Invalid multipart upload');
  }
}

/**
 * Ingest the file a request carries: a multipart `file`, or a JSON body with
 * `data` (base64), `text` and/or `pageImages`.
 *
 * @param {Object} params
 * @param {import('express').Request} params.req - After {@link parseChatFileMultipart} for multipart requests.
 * @param {{type: 'chat'|'task', id: string}} params.scope
 * @param {string|null} params.ownerId
 * @param {Object|null} [params.appConfig]
 * @param {Object} params.policy
 * @param {Object} params.store - `ChatFileRepository`.
 * @param {Object} [params.user] - The caller; needed for `source` (its stored connector credentials).
 * @param {string} [params.origin='upload']
 * @returns {Promise<Object>} The stored file's descriptor.
 * @throws {ChatFileError} `BAD_REQUEST` (status 400) when the request carries no file.
 */
export async function ingestRequestFile({
  req,
  scope,
  ownerId,
  appConfig = null,
  policy,
  store,
  user = null,
  origin = 'upload',
  countEvidence = false
}) {
  // A file in a connected system (`{ source: { kind, ref, refreshOnRun? } }`):
  // the server fetches the original itself.
  const requestedSource = req.body?.source;
  if (!req.file && requestedSource !== undefined && requestedSource !== null) {
    if (typeof requestedSource !== 'object' || Array.isArray(requestedSource)) {
      throw new ChatFileError('BAD_REQUEST', '"source" must be an object { kind, ref }', 400);
    }
    return ingestFromSource({
      source: requestedSource,
      user,
      scope,
      ownerId,
      appConfig,
      policy,
      store,
      countEvidence
    });
  }

  if (req.file) {
    return withUploadSpool(req, () =>
      ingestChatFile({
        scope,
        ownerId,
        name: req.file.originalname || req.body?.name || 'document',
        mimeType: req.file.mimetype || req.body?.mimeType || 'application/octet-stream',
        // A spooled upload has a path; a buffer is what a caller without multer hands in.
        ...(req.file.path ? { filePath: req.file.path } : { buffer: req.file.buffer }),
        signal: uploadAbortSignal(req),
        text: typeof req.body?.text === 'string' ? req.body.text : null,
        origin,
        appConfig,
        policy,
        store,
        countEvidence
      })
    );
  }

  const body = req.body || {};
  const hasText = typeof body.text === 'string' && body.text.length > 0;
  const hasPages = Array.isArray(body.pageImages) && body.pageImages.length > 0;
  const hasBase64 = typeof body.data === 'string' && body.data.length > 0;
  if (!hasText && !hasPages && !hasBase64) {
    throw new ChatFileError(
      'BAD_REQUEST',
      'Provide a multipart "file" upload, or a JSON body with "text", "data", "pageImages" or "source"',
      400
    );
  }
  // The JSON body is in memory already (the body parser's limit bounds it); the
  // decoded bytes replace the base64 text instead of being held beside it.
  const decoded = hasBase64 ? Buffer.from(body.data, 'base64') : null;
  if (hasBase64) body.data = undefined;
  return ingestChatFile({
    scope,
    ownerId,
    name: body.name || body.fileName || 'document.txt',
    mimeType: body.mimeType || body.fileType || 'text/plain',
    buffer: decoded,
    text: typeof body.text === 'string' ? body.text : '',
    pageImages: Array.isArray(body.pageImages) ? body.pageImages : null,
    pages: body.pages,
    formatLabel: body.formatLabel || null,
    origin,
    appConfig,
    policy,
    store,
    countEvidence
  });
}
