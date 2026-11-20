// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A small HTTP server that takes file uploads the way the chat route does
 * (`routes/chats.js`): the shared multipart parser and the shared ingest of
 * `services/chatFiles/fileUploadRequest.js`, the real error middleware. Tests
 * of the upload spool call it over a real connection, because what they look
 * at — a file size limit that cuts a transfer, a client that goes away — does
 * not happen with a request double.
 *
 * Also the clients those tests need: one that streams a generated body (so a
 * test of the server's memory does not hold the payload itself) and one that
 * stops in the middle.
 *
 * @module tests/support/uploadTestApp
 */
import './scratchContents.js';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import multer from 'multer';
import errorHandler from '../../middleware/errorHandler.js';
import { ingestChatFile } from '../../services/chatFiles/ChatFileService.js';
import {
  ingestRequestFile,
  isMultipartRequest,
  parseChatFileMultipart
} from '../../services/chatFiles/fileUploadRequest.js';

/**
 * Start an upload server.
 *
 * @param {Object} options
 * @param {Object} options.store - A `ChatFileRepository` (or a double with `isAvailable` and `put`).
 * @param {() => Object} options.policy - The upload policy of the next request.
 * @param {{type: string, id: string}|(() => Object)} options.scope
 * @param {'spool'|'memory'} [options.mode='spool'] - `memory` is the code path before the
 *   spool (`multer.memoryStorage()`, the whole file handed to the ingest as a Buffer), kept
 *   here for the memory comparison.
 * @param {Object} [options.limiter] - Extraction limiter of the `memory` mode's ingest.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export async function startUploadApp({ store, policy, scope, mode = 'spool', limiter = null }) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/upload', async (req, res) => {
    const current = policy();
    const target = typeof scope === 'function' ? scope() : scope;
    if (mode === 'memory') {
      await new Promise((resolve, reject) =>
        multer({
          storage: multer.memoryStorage(),
          defParamCharset: 'utf8',
          limits: { fileSize: current.quotas.maxFileBytes, files: 1, fields: 10 }
        }).single('file')(req, res, error => (error ? reject(error) : resolve()))
      );
      const descriptor = await ingestChatFile({
        scope: target,
        ownerId: 'user-ada',
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        policy: current,
        store,
        ...(limiter ? { limiter } : {})
      });
      return res.status(201).json(descriptor);
    }
    if (isMultipartRequest(req)) {
      await parseChatFileMultipart(req, res, current.quotas.maxFileBytes);
    }
    const descriptor = await ingestRequestFile({
      req,
      scope: target,
      ownerId: 'user-ada',
      policy: current,
      store
    });
    return res.status(201).json(descriptor);
  });
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/upload`,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

/**
 * Upload one file as `multipart/form-data` (field `file`).
 *
 * @param {string} url
 * @param {Buffer} bytes
 * @param {{filename?: string, type?: string, fields?: Object}} [options]
 * @returns {Promise<{status: number, headers: Headers, body: Object}>}
 */
export async function postFile(
  url,
  bytes,
  { filename = 'notes.txt', type = 'text/plain', fields = {} } = {}
) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', new Blob([bytes], { type }), filename);
  const response = await fetch(url, { method: 'POST', body: form });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, headers: response.headers, body };
}

/** The multipart frame around one file part. */
function multipartFrame(filename, type) {
  const boundary = `----ihub${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, head, tail };
}

/**
 * Upload a generated file of `bytes` bytes without holding it: the same block
 * of text lines is sent again and again.
 *
 * @param {number} port
 * @param {number} bytes
 * @param {Object} [options]
 * @param {string} [options.filename='big.txt']
 * @param {number} [options.stopAfter] - Send this many bytes of the file, then
 *   cut the connection (a client that goes away mid-upload).
 * @param {() => void} [options.onStopped] - Called before the connection is cut.
 * @returns {Promise<{status: number|null, headers: Object, body: Object|null, sha256: string}>}
 *   `status` is null when the connection ended without a response.
 */
export function streamUpload(port, bytes, { filename = 'big.txt', stopAfter, onStopped } = {}) {
  const { boundary, head, tail } = multipartFrame(filename, 'text/plain');
  const line = 'The quick brown fox jumps over the lazy dog. 0123456789\n';
  const block = Buffer.from(line.repeat(Math.ceil(65536 / line.length)).slice(0, 65536));
  const hash = crypto.createHash('sha256');
  return new Promise(resolve => {
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve({ ...value, sha256: hash.digest('hex') });
    };
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/upload',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': head.length + bytes + tail.length
        }
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          settle({ status: response.statusCode, headers: response.headers, body });
        });
        response.on('error', () =>
          settle({ status: response.statusCode, headers: {}, body: null })
        );
      }
    );
    request.on('error', () => settle({ status: null, headers: {}, body: null }));
    request.write(head);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        if (stopAfter !== undefined && sent >= stopAfter) {
          onStopped?.();
          request.destroy();
          return settle({ status: null, headers: {}, body: null });
        }
        const piece = block.subarray(0, Math.min(block.length, bytes - sent));
        sent += piece.length;
        hash.update(piece);
        if (!request.write(piece)) {
          request.once('drain', pump);
          return;
        }
      }
      request.end(tail);
    };
    pump();
  });
}
