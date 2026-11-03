// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * HTTP-level helpers shared by every route that ingests a chat or scheduled
 * task file (`POST /api/chats/:chatId/files`,
 * `POST /api/scheduled-tasks/:taskId/files`): multipart parsing, the request
 * body shapes, and the translation of ingest failures into responses.
 *
 * @module services/chatFiles/fileUploadRequest
 */
import multer from 'multer';
import { sendBadRequest, sendErrorResponse } from '../../utils/responseHelpers.js';
import { ChatFileQuotaError } from './ChatFileRepository.js';
import { ChatFileError, ingestChatFile } from './ChatFileService.js';

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
 * Parse a single file upload from a multipart request into `req.file` and `req.body`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} maxFileBytes
 * @returns {Promise<boolean>} True when parsed, false when an error response was sent.
 */
export function parseChatFileMultipart(req, res, maxFileBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: {
      fileSize: maxFileBytes > 0 ? maxFileBytes : 25 * 1024 * 1024,
      files: 1,
      fields: 10
    }
  }).single('file');

  return new Promise(resolve => {
    upload(req, res, error => {
      if (!error) return resolve(true);
      if (error?.code === 'LIMIT_FILE_SIZE') {
        sendErrorResponse(
          res,
          413,
          `A file may be at most ${Math.floor(maxFileBytes / (1024 * 1024)) || 1} MB`,
          { details: { code: 'QUOTA_FILE_BYTES', limit: maxFileBytes } }
        );
        return resolve(false);
      }
      if (error?.code === 'LIMIT_FILE_COUNT' || error?.code === 'LIMIT_UNEXPECTED_FILE') {
        sendBadRequest(res, 'Send at most one file in the "file" field');
        return resolve(false);
      }
      sendBadRequest(res, error.message || 'Invalid multipart upload');
      return resolve(false);
    });
  });
}

/**
 * Whether an error is an expected ingest refusal (quota, unsupported type, …)
 * that carries its own status and code.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isChatFileFailure(error) {
  return error instanceof ChatFileQuotaError || error instanceof ChatFileError;
}

/**
 * Send an ingest refusal as a JSON error.
 *
 * @param {import('express').Response} res
 * @param {ChatFileQuotaError|ChatFileError} error
 * @returns {import('express').Response}
 */
export function sendChatFileFailure(res, error) {
  return sendErrorResponse(res, error.status || 400, error.message, {
    details: { code: error.code, ...(error.details || {}) }
  });
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
  origin = 'upload'
}) {
  if (req.file) {
    return ingestChatFile({
      scope,
      ownerId,
      name: req.file.originalname || req.body?.name || 'document',
      mimeType: req.file.mimetype || req.body?.mimeType || 'application/octet-stream',
      buffer: req.file.buffer,
      text: typeof req.body?.text === 'string' ? req.body.text : null,
      origin,
      appConfig,
      policy,
      store
    });
  }

  const body = req.body || {};
  const hasText = typeof body.text === 'string' && body.text.length > 0;
  const hasPages = Array.isArray(body.pageImages) && body.pageImages.length > 0;
  const hasBase64 = typeof body.data === 'string' && body.data.length > 0;
  if (!hasText && !hasPages && !hasBase64) {
    throw new ChatFileError(
      'BAD_REQUEST',
      'Provide either a multipart "file" upload or a JSON body with "text", "data" or "pageImages"',
      400
    );
  }
  return ingestChatFile({
    scope,
    ownerId,
    name: body.name || body.fileName || 'document.txt',
    mimeType: body.mimeType || body.fileType || 'text/plain',
    buffer: hasBase64 ? Buffer.from(body.data, 'base64') : null,
    text: typeof body.text === 'string' ? body.text : '',
    pageImages: Array.isArray(body.pageImages) ? body.pageImages : null,
    pages: body.pages,
    formatLabel: body.formatLabel || null,
    origin,
    appConfig,
    policy,
    store
  });
}
