// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `/api/inference/v1/files` — the OpenAI Files API on the shared chat-file store.
 *
 *   POST   /files                 upload (multipart `file` + `purpose`, or JSON)
 *   GET    /files                 list the caller's files
 *   GET    /files/{id}            read one file object
 *   GET    /files/{id}/content    the original bytes (`?format=text`: the extracted text)
 *   DELETE /files/{id}            delete
 *
 * A file lives in the caller's `user` scope of the `ChatFileRepository`
 * (`userFileScope`), so it is read and kept by the same pipeline as a Web UI upload
 * (server-side extraction incl. Excel and scanned PDFs, quotas, storage modes, malware
 * scan) and is the caller's alone: another caller's file id is a 404, like an unknown
 * one. Its id is what `file_id` of `/responses` and `/chat/completions` content parts
 * names (services/inference/inputContent.js).
 *
 * @module routes/inference/files
 */
import multer from 'multer';
import { buildServerPath } from '../../utils/basePath.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { servedMediaType } from '../../services/artifacts/artifactPolicy.js';
import { chatFilePolicy } from '../../services/chatFiles/chatFilePolicy.js';
import { withUserFileLimit } from '../../services/quota/quotaService.js';
import { userFileScope } from '../../services/chatFiles/ChatFileRepository.js';
import { ingestChatFile } from '../../services/chatFiles/ChatFileService.js';
import { InferenceApiError, sendOpenAiError } from '../../services/inference/errors.js';
import {
  fileObject,
  inferenceFileError,
  normalizePurpose,
  requireFileOwner,
  requireFileStore
} from '../../services/inference/files.js';
import { apiUser, numberField } from './shared.js';

const COMPONENT = 'FilesApi';

/** OpenAI's bounds on a file listing. */
const DEFAULT_LIST_LIMIT = 10_000;

/**
 * The file of a multipart upload (field `file`) and its text fields.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} maxFileBytes
 * @returns {Promise<void>}
 * @throws {InferenceApiError}
 */
function parseMultipart(req, res, maxFileBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: maxFileBytes > 0 ? maxFileBytes : 25 * 1024 * 1024, files: 1, fields: 10 }
  }).single('file');
  return new Promise((resolve, reject) => {
    upload(req, res, error => {
      if (!error) return resolve();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return reject(
          new InferenceApiError(
            413,
            'quota_file_bytes',
            `A file may be at most ${Math.floor(maxFileBytes / (1024 * 1024)) || 1} MB`,
            { param: 'file', details: { limit: maxFileBytes } }
          )
        );
      }
      if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
        return reject(
          new InferenceApiError(400, 'invalid_file', 'Send exactly one file in the "file" field', {
            param: 'file'
          })
        );
      }
      return reject(
        new InferenceApiError(400, 'invalid_request', error.message || 'Invalid multipart upload')
      );
    });
  });
}

/** A JSON body's base64 (or `data:` URL) payload as bytes. */
function bytesOfJsonBody(body) {
  const raw = body.base64 ?? body.data;
  if (typeof raw !== 'string' || !raw) return null;
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(raw);
  const bytes = Buffer.from((match ? match[2] : raw).replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) {
    throw new InferenceApiError(400, 'invalid_file', 'base64 file data is empty or invalid', {
      param: body.base64 !== undefined ? 'base64' : 'data'
    });
  }
  return { bytes, mimeType: match?.[1] || null };
}

export default function registerFilesRoutes(app) {
  const base = buildServerPath('/api/inference/v1');

  /** The caller's file scope, with its owner; 401 for an anonymous caller. */
  async function callerScope(req) {
    const owner = await requireFileOwner(apiUser(req));
    return { owner, scope: userFileScope(owner.id) };
  }

  const fail = (res, error) => sendOpenAiError(res, inferenceFileError(error), COMPONENT);

  /**
   * @swagger
   * /inference/v1/files:
   *   post:
   *     summary: Upload a file (OpenAI Files API)
   *     description: |
   *       Stores a file for the caller and returns an OpenAI `file` object; its `id` can be used as
   *       `file_id` in `input_file` parts of `/inference/v1/responses` and `file` parts of
   *       `/inference/v1/chat/completions`. The file is read by the same pipeline as a chat upload:
   *       PDF (a scanned PDF is kept as page images), Word, PowerPoint, Excel, OpenDocument, HTML,
   *       e-mail and text files; size and storage limits follow the platform's upload quotas
   *       (`413` / `507` when exceeded). Send `multipart/form-data` (`file`, `purpose`) like the
   *       OpenAI SDKs, or JSON `{ filename, base64 | content, mime_type?, purpose? }`.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             required: [file]
   *             properties:
   *               file:
   *                 type: string
   *                 format: binary
   *               purpose:
   *                 type: string
   *                 description: Free-form label, default `user_data`
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               filename:
   *                 type: string
   *               base64:
   *                 type: string
   *                 description: The file, base64 or a `data:` URL
   *               content:
   *                 type: string
   *                 description: Text content, instead of `base64`
   *               mime_type:
   *                 type: string
   *               purpose:
   *                 type: string
   *     responses:
   *       200:
   *         description: The `file` object
   *       400:
   *         description: Unsupported type, no text, unreadable file or malware scan refusal
   *       401:
   *         description: Authentication required (files are per caller)
   *       413:
   *         description: A file or storage quota is exceeded
   *       503:
   *         description: File storage is unavailable or switched off
   *       507:
   *         description: The server-wide file storage is full
   */
  app.post(`${base}/files`, async (req, res) => {
    try {
      const { owner, scope } = await callerScope(req);
      const store = requireFileStore();
      const policy = withUserFileLimit(chatFilePolicy(), req.user);
      if (!policy.enabled) {
        throw new InferenceApiError(403, 'uploads_disabled', 'File uploads are disabled');
      }
      const multipart = /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
      if (multipart) await parseMultipart(req, res, policy.quotas.maxFileBytes);
      const body = req.body || {};
      const purpose = normalizePurpose(body.purpose);

      let name;
      let mimeType;
      let bytes = null;
      let text = null;
      if (multipart || req.file) {
        if (!req.file) {
          throw new InferenceApiError(400, 'missing_file', 'file is required', { param: 'file' });
        }
        name = req.file.originalname || 'document';
        mimeType = req.file.mimetype || 'application/octet-stream';
        bytes = req.file.buffer;
      } else {
        const inline = bytesOfJsonBody(body);
        const rawText = typeof body.content === 'string' ? body.content : null;
        if (!inline && !rawText) {
          throw new InferenceApiError(
            400,
            'missing_file',
            'Send a multipart "file", or JSON with "base64" or "content"',
            { param: 'file' }
          );
        }
        name =
          (typeof body.filename === 'string' && body.filename) ||
          (typeof body.name === 'string' && body.name) ||
          (inline ? 'document' : 'document.txt');
        mimeType =
          (typeof (body.mime_type ?? body.mimeType) === 'string' &&
            (body.mime_type ?? body.mimeType)) ||
          inline?.mimeType ||
          (inline ? 'application/octet-stream' : 'text/plain');
        bytes = inline ? inline.bytes : null;
        text = inline ? null : rawText;
      }

      const descriptor = await ingestChatFile({
        scope,
        ownerId: owner.id,
        name,
        mimeType,
        buffer: bytes,
        text,
        origin: 'api',
        meta: { purpose, size: bytes ? bytes.length : Buffer.byteLength(text || '', 'utf8') },
        policy,
        store
      });
      return res.json(fileObject(descriptor));
    } catch (error) {
      return fail(res, error);
    }
  });

  /**
   * @swagger
   * /inference/v1/files:
   *   get:
   *     summary: List the caller's files (OpenAI Files API)
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: query
   *         name: purpose
   *         schema:
   *           type: string
   *         description: Only files uploaded with this purpose
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: order
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *           default: desc
   *         description: By creation time
   *       - in: query
   *         name: after
   *         schema:
   *           type: string
   *         description: A file id; list the files after it
   *     responses:
   *       200:
   *         description: A `list` of `file` objects
   *       401:
   *         description: Authentication required
   */
  app.get(`${base}/files`, async (req, res) => {
    try {
      const { scope } = await callerScope(req);
      const store = requireFileStore();
      const query = { limit: req.query.limit === undefined ? undefined : Number(req.query.limit) };
      const limit =
        numberField(query, 'limit', { min: 1, max: DEFAULT_LIST_LIMIT, integer: true }) ??
        DEFAULT_LIST_LIMIT;
      const order = req.query.order === 'asc' ? 'asc' : 'desc';
      if (req.query.order !== undefined && !['asc', 'desc'].includes(req.query.order)) {
        throw new InferenceApiError(400, 'invalid_parameter', 'order must be asc or desc', {
          param: 'order'
        });
      }
      // The repository lists newest first.
      let items = (await store.list(scope)).map(fileObject);
      if (typeof req.query.purpose === 'string' && req.query.purpose) {
        items = items.filter(item => item.purpose === req.query.purpose);
      }
      if (order === 'asc') items.reverse();
      if (typeof req.query.after === 'string' && req.query.after) {
        const at = items.findIndex(item => item.id === req.query.after);
        if (at >= 0) items = items.slice(at + 1);
      }
      const page = items.slice(0, limit);
      return res.json({
        object: 'list',
        data: page,
        first_id: page[0]?.id ?? null,
        last_id: page[page.length - 1]?.id ?? null,
        has_more: items.length > page.length
      });
    } catch (error) {
      return fail(res, error);
    }
  });

  /** One file of the caller; 404 for an unknown id and for another caller's alike. */
  async function loadFile(req) {
    const { scope } = await callerScope(req);
    const store = requireFileStore();
    const fileId = req.params.file_id;
    const descriptor = await store.getDescriptor(scope, fileId);
    if (!descriptor) {
      throw new InferenceApiError(404, 'file_not_found', `No such file: ${fileId}`, {
        param: 'file_id'
      });
    }
    return { store, scope, descriptor };
  }

  /**
   * @swagger
   * /inference/v1/files/{file_id}:
   *   get:
   *     summary: Retrieve a file (OpenAI Files API)
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: file_id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The `file` object
   *       401:
   *         description: Authentication required
   *       404:
   *         description: No such file (also for another caller's file)
   */
  app.get(`${base}/files/:file_id`, async (req, res) => {
    try {
      const { descriptor } = await loadFile(req);
      return res.json(fileObject(descriptor));
    } catch (error) {
      return fail(res, error);
    }
  });

  /**
   * @swagger
   * /inference/v1/files/{file_id}/content:
   *   get:
   *     summary: Retrieve the content of a file (OpenAI Files API)
   *     description: |
   *       The file as it was uploaded. The original is kept for a limited time (the platform's
   *       `uploads.originalRetentionDays`) and not at all with the `server_text_only` storage mode;
   *       once it is gone this answers `410 original_discarded` and the extracted text stays
   *       available with `?format=text` (also usable while the original exists).
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: file_id
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: format
   *         schema:
   *           type: string
   *           enum: [original, text]
   *           default: original
   *     responses:
   *       200:
   *         description: The file bytes (or the extracted text as `text/plain`)
   *       404:
   *         description: No such file (also for another caller's file)
   *       410:
   *         description: The original is no longer stored; use `?format=text`
   */
  app.get(`${base}/files/:file_id/content`, async (req, res) => {
    try {
      const { store, scope, descriptor } = await loadFile(req);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.query.format === 'text') {
        const stored = await store.getText(scope, descriptor.id);
        if (!stored) {
          throw new InferenceApiError(404, 'file_not_found', `No such file: ${descriptor.id}`, {
            param: 'file_id'
          });
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(stored.text);
      }
      if (req.query.format !== undefined && req.query.format !== 'original') {
        throw new InferenceApiError(400, 'invalid_parameter', 'format must be original or text', {
          param: 'format'
        });
      }
      const original = await store.getOriginal(scope, descriptor.id);
      if (!original) {
        throw new InferenceApiError(404, 'file_not_found', `No such file: ${descriptor.id}`, {
          param: 'file_id'
        });
      }
      if (original.discarded) {
        // OpenAI has no notion of an expired original; "Gone" is the honest answer, and the
        // text is still there to be fetched.
        throw new InferenceApiError(
          410,
          'original_discarded',
          'The original file is no longer stored; request the extracted text with ?format=text',
          { param: 'file_id', details: { originalDeletedAt: original.originalDeletedAt || null } }
        );
      }
      res.setHeader('Content-Type', servedMediaType(original.mimeType));
      res.setHeader('Content-Length', String(original.data.length));
      res.setHeader('Content-Disposition', buildContentDisposition(original.name));
      return res.send(original.data);
    } catch (error) {
      return fail(res, error);
    }
  });

  /**
   * @swagger
   * /inference/v1/files/{file_id}:
   *   delete:
   *     summary: Delete a file (OpenAI Files API)
   *     description: |
   *       Deletes the upload. Conversations that used it keep their own copy.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: file_id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "`{ id, object: 'file', deleted: true }`"
   *       401:
   *         description: Authentication required
   *       404:
   *         description: No such file (also for another caller's file)
   */
  app.delete(`${base}/files/:file_id`, async (req, res) => {
    try {
      const { store, scope, descriptor } = await loadFile(req);
      await store.delete(scope, descriptor.id);
      return res.json({ id: descriptor.id, object: 'file', deleted: true });
    } catch (error) {
      return fail(res, error);
    }
  });
}
