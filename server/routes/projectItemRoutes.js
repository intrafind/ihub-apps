// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The item handlers the user and the admin projects routers share (spec 3
 * §2, §4, §9): the multipart upload, the refresh of a picked document, the
 * text of an item, and the pickers (iFinder search and metadata, the page
 * list, the URL check, preview and site crawl).
 *
 * The upload goes to disk first (multer `diskStorage` into a private
 * directory per request under `contents/data/tmp/project-uploads/`), never
 * into memory; `fileFilter` runs the type and quota checks before the first
 * byte is accepted; the route answers `202 { item }` as soon as the file is
 * on disk and the item document written, and extraction continues on the
 * ingest queue.
 *
 * @module routes/projectItemRoutes
 */
import fs from 'node:fs/promises';
import multer from 'multer';
import configCache from '../configCache.js';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { requireFeature } from '../featureRegistry.js';
import { logAudit } from '../services/AuditLogService.js';
import { recordUpload } from '../telemetry/metrics.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import { KnowledgeError } from '../services/knowledge/types.js';
import { getItemText } from '../services/knowledge/ItemTextService.js';
import { ProjectError, getProjectService } from '../services/projects/ProjectService.js';
import { PROJECTS_FEATURE, projectSettings } from '../services/projects/projectSettings.js';
import { ACCEPTED_TYPES, acceptedTypeOf, sniffBytes } from '../services/projects/extractText.js';
import { projectName, serializeItem } from '../services/projects/projectView.js';
import {
  ifinderPickerSchema,
  itemTextUpdateSchema,
  urlCheckSchema,
  urlCrawlSchema,
  urlPreviewSchema
} from '../validators/projectSchema.js';

/** Field name of the uploaded file. */
export const UPLOAD_FIELD = 'file';

function platformOf() {
  return configCache.getPlatform?.() || {};
}

/**
 * Map a project error (or a multer one) onto the response.
 *
 * @param {import('express').Response} res
 * @param {unknown} error
 * @param {string} operation
 */
export function sendProjectError(res, error, operation) {
  if (error instanceof ProjectError || error instanceof KnowledgeError) {
    const status = error.status || statusOfKnowledge(error.code);
    return sendErrorResponse(res, status, error.message, {
      details: { code: error.code, ...(error.details || {}) }
    });
  }
  return sendFailedOperationError(res, operation, error);
}

function statusOfKnowledge(code) {
  switch (code) {
    case 'ITEM_NOT_READY':
      return 409;
    case 'SOURCE_FORBIDDEN':
    case 'KEY_ACCESS_DENIED':
      return 403;
    case 'SOURCE_GONE':
    case 'ITEM_NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
      return 404;
    case 'STORAGE_UNAVAILABLE':
      return 503;
    case 'TEXT_UNAVAILABLE':
      return 410;
    default:
      return 400;
  }
}

/**
 * Whether the request carries a multipart body (an upload) rather than JSON.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isMultipart(req) {
  return typeof req.is === 'function'
    ? Boolean(req.is('multipart/form-data'))
    : /^multipart\/form-data/i.test(String(req.headers?.['content-type'] || ''));
}

/**
 * The multer middleware of one request, built on the current settings (the
 * limits are configuration, and tests change them between requests).
 *
 * @param {import('express').Request} req - With `req.project` loaded.
 * @param {import('express').Response} res
 * @param {Function} next
 */
export function receiveUpload(req, res, next) {
  const service = getProjectService();
  const ingest = service.ingest;
  if (!ingest) {
    return sendProjectError(
      res,
      new ProjectError('INGEST_UNAVAILABLE', 'Uploads are not available on this installation'),
      'upload project item'
    );
  }
  const { limits } = projectSettings(platformOf());
  const project = req.project;
  const storage = multer.diskStorage({
    destination: (request, _file, cb) => {
      ingest.newTempDir().then(dir => {
        request.projectUploadDir = dir;
        cb(null, dir);
      }, cb);
    },
    filename: (_request, _file, cb) => cb(null, 'upload')
  });
  const upload = multer({
    storage,
    // Browsers send file names as UTF-8; multer reads them as latin1 unless told
    // (an en dash in a name arrived as the three characters "â", "€" and a quote).
    defParamCharset: 'utf8',
    limits: { fileSize: limits.maxFileBytes, files: 1, fields: 10 },
    fileFilter: (request, file, cb) => {
      const accepted = acceptedTypeOf({ contentType: file.mimetype, name: file.originalname });
      if (!accepted) {
        recordUpload('project', 'rejected_type');
        return cb(
          new ProjectError(
            'UNSUPPORTED_TYPE',
            `${file.originalname || 'The file'} has an unsupported type. Supported: ${ACCEPTED_TYPES.summary}.`,
            { accepted: ACCEPTED_TYPES }
          )
        );
      }
      const items = project?.items || [];
      if (items.length >= limits.maxFiles) {
        recordUpload('project', 'rejected_quota');
        return cb(
          new ProjectError('QUOTA_FILES', `A project holds at most ${limits.maxFiles} items`, {
            limit: limits.maxFiles,
            used: items.length
          })
        );
      }
      // The declared length bounds the file; the real size is checked again
      // after receive and once more in the pipeline.
      const declared = Number(request.headers?.['content-length']) || 0;
      const used = project?.usage?.bytes || 0;
      if (declared > 0 && used + declared > limits.maxProjectBytes + 64 * 1024) {
        recordUpload('project', 'rejected_quota');
        return cb(
          new ProjectError(
            'QUOTA_PROJECT_BYTES',
            `This project may hold at most ${Math.floor(limits.maxProjectBytes / (1024 * 1024))} MB`,
            { limit: limits.maxProjectBytes, used, size: declared }
          )
        );
      }
      cb(null, true);
    }
  });
  upload.single(UPLOAD_FIELD)(req, res, async error => {
    if (!error) return next();
    await removeUploadDir(req);
    if (error instanceof ProjectError) return sendProjectError(res, error, 'upload project item');
    if (error?.code === 'LIMIT_FILE_SIZE') {
      recordUpload('project', 'rejected_size');
      return sendProjectError(
        res,
        new ProjectError(
          'QUOTA_FILE_BYTES',
          `A file may be at most ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB`,
          { limit: limits.maxFileBytes }
        ),
        'upload project item'
      );
    }
    if (error?.code === 'LIMIT_FILE_COUNT' || error?.code === 'LIMIT_UNEXPECTED_FILE') {
      return sendBadRequest(res, `Send exactly one file in the "${UPLOAD_FIELD}" field`);
    }
    return sendProjectError(res, error, 'upload project item');
  });
}

/** The first bytes of the received file, for the magic-byte check. */
async function headOf(filePath, length = 16) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function removeUploadDir(req) {
  if (!req.projectUploadDir) return;
  try {
    await fs.rm(req.projectUploadDir, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Add the uploaded file as an item (after {@link receiveUpload}).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{project: Object, authorize?: Function, admin?: boolean}} options
 */
export async function addUploadedItem(req, res, { project, authorize, admin = false }) {
  const file = req.file;
  if (!file) {
    await removeUploadDir(req);
    return sendBadRequest(res, `A multipart upload needs a "${UPLOAD_FIELD}" field`);
  }
  try {
    // `fileFilter` saw only the declared type; the bytes decide what the
    // file is. An image, media, archive or executable is refused here,
    // before the item exists, whatever the client declared.
    if (sniffBytes(await headOf(file.path)) === 'refused') {
      recordUpload('project', 'rejected_type', file.size);
      await removeUploadDir(req);
      return sendProjectError(
        res,
        new ProjectError(
          'UNSUPPORTED_TYPE',
          `${file.originalname || 'The file'} is an image, media, archive or binary file. Supported: ${ACCEPTED_TYPES.summary}.`,
          { accepted: ACCEPTED_TYPES }
        ),
        'upload project item'
      );
    }
    const service = getProjectService();
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 300) : '';
    const pinned = req.body?.pinned === true || req.body?.pinned === 'true';
    const { item } = await service.addItem(
      project.id,
      {
        kind: 'upload',
        ref: {},
        ...(name ? { name } : {}),
        pinned,
        file: {
          path: file.path,
          contentType: file.mimetype,
          name: file.originalname || name || 'upload',
          bytes: file.size,
          cleanupDir: req.projectUploadDir
        }
      },
      { user: req.user, authorize }
    );
    recordUpload('project', 'accepted', file.size);
    logAudit({
      req,
      action: 'create',
      resource: 'projectItem',
      resourceId: project.id,
      summary: `Uploaded "${item.name}" (${file.size} bytes) to ${admin ? 'admin ' : ''}project "${projectName(project)}"`
    });
    res.status(202).json({ item: serializeItem(item) });
  } catch (error) {
    await removeUploadDir(req);
    sendProjectError(res, error, 'upload project item');
  }
}

/**
 * Refresh a picked document.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{project: Object, authorize?: Function}} options
 */
export async function refreshItem(req, res, { project, authorize }) {
  const { itemId } = req.params;
  if (!validateIdForPath(itemId, 'item', res)) return;
  try {
    const { item } = await getProjectService().refreshItem(project.id, itemId, {
      user: req.user,
      authorize,
      wait: req.query?.wait === '1' || req.query?.wait === 'true'
    });
    logAudit({
      req,
      action: 'update',
      resource: 'projectItem',
      resourceId: project.id,
      summary: `Refreshed ${item.kind} item "${item.name}" in project "${projectName(project)}"`
    });
    res.status(item.status === 'pending' || item.status === 'extracting' ? 202 : 200).json({
      item: serializeItem(item)
    });
  } catch (error) {
    sendProjectError(res, error, 'refresh project item');
  }
}

/**
 * Replace the text of a written, uploaded or imported item (`PUT …/text`,
 * user and admin routes): the text is stored like written text and the item
 * becomes `written` by the caller.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{project: Object, authorize?: Function}} options
 */
export async function replaceItemText(req, res, { project, authorize }) {
  const { itemId } = req.params;
  if (!validateIdForPath(itemId, 'item', res)) return;
  const parsed = itemTextUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return sendBadRequest(res, parsed.error.issues[0]?.message || 'Invalid text');
  }
  try {
    const { item } = await getProjectService().replaceItemText(
      project.id,
      itemId,
      parsed.data.text,
      { user: req.user, authorize }
    );
    logAudit({
      req,
      action: 'update',
      resource: 'projectItem',
      resourceId: project.id,
      summary: `Edited the text of ${item.kind} item "${item.name}" in project "${projectName(project)}"`
    });
    res.json({ item: serializeItem(item) });
  } catch (error) {
    sendProjectError(res, error, 'edit project item text');
  }
}

/**
 * The text of an item as `text/plain` (preview and download), audited as a
 * `read` when `platform.audit.logReads` is on.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{project: Object}} options
 */
export async function sendItemText(req, res, { project }) {
  const { itemId } = req.params;
  if (!validateIdForPath(itemId, 'item', res)) return;
  const item = (project.items || []).find(entry => entry.id === itemId);
  if (!item) return sendNotFound(res, 'Item');
  try {
    const { text } = await getItemText(project, item, {
      user: req.user,
      chatId: `project-text-${project.id}-${item.id}`,
      language: req.query?.lang || req.user?.language || 'en',
      purpose: 'read'
    });
    const maxChars = Math.max(0, parseInt(req.query?.maxChars, 10) || 0);
    const body = maxChars > 0 && text.length > maxChars ? text.slice(0, maxChars) : text;
    if (platformOf().audit?.logReads === true) {
      logAudit({
        req,
        action: 'read',
        resource: 'projectItem',
        resourceId: project.id,
        summary: `Read ${item.kind} item "${item.name}" (${item.text?.format || 'link'}) of project "${projectName(project)}"`
      });
    }
    const download = req.query?.download === '1' || req.query?.download === 'true';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Item-Chars', String(text.length));
    if (maxChars > 0 && text.length > maxChars) res.setHeader('X-Item-Truncated', 'true');
    if (download) {
      const base = String(item.name || item.id)
        .replace(/\.[A-Za-z0-9]{1,8}$/, '')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120);
      res.setHeader('Content-Disposition', `attachment; filename="${base || item.id}.txt"`);
    }
    res.send(body);
  } catch (error) {
    sendProjectError(res, error, 'read project item');
  }
}

// --- pickers ----------------------------------------------------------------

function ifinderConfigured() {
  return Boolean(platformOf().iFinder?.baseUrl || process.env.IFINDER_API_URL);
}

function readablePage(pageConfig, user) {
  const { authRequired = false, allowedGroups } = pageConfig || {};
  if (authRequired && (!user || user.id === 'anonymous')) return false;
  if (Array.isArray(allowedGroups) && allowedGroups.length > 0 && !allowedGroups.includes('*')) {
    return (user?.groups || []).some(group => allowedGroups.includes(group));
  }
  return true;
}

/**
 * Register the picker endpoints under `/api/projects/pickers`.
 *
 * @param {import('express').Express} app
 */
export function registerProjectPickerRoutes(app) {
  const route = suffix => buildServerPath(`/api/projects/pickers${suffix}`);
  const gate = [requireFeature(PROJECTS_FEATURE), authenticatedOnly];

  app.get(route('/pages'), ...gate, (req, res) => {
    const { data: uiConfig } = configCache.getUI();
    const pages = Object.entries(uiConfig?.pages || {})
      .filter(([, config]) => readablePage(config, req.user))
      .map(([id, config]) => ({
        id,
        title: config?.title || id,
        languages: Object.keys(config?.filePath || {})
      }));
    res.json({ pages });
  });

  app.get(route('/ifinder/search'), ...gate, async (req, res) => {
    if (!ifinderConfigured()) return sendNotFound(res, 'iFinder');
    const parsed = ifinderPickerSchema.safeParse(req.query || {});
    if (!parsed.success) return sendBadRequest(res, 'A search query is required');
    const { q, profile, limit } = parsed.data;
    try {
      const { default: IFinderHandler } = await import('../sources/IFinderHandler.js');
      const handler = new IFinderHandler();
      const results = await handler.searchDocuments({
        query: q,
        user: req.user,
        chatId: `project-picker-${req.user.id}`,
        maxResults: limit,
        ...(profile ? { searchProfile: profile } : {})
      });
      res.json({ results });
    } catch (error) {
      sendFailedOperationError(res, 'search iFinder', error);
    }
  });

  app.get(route('/ifinder/metadata'), ...gate, async (req, res) => {
    if (!ifinderConfigured()) return sendNotFound(res, 'iFinder');
    const documentId = String(req.query?.documentId || '').trim();
    if (!documentId) return sendBadRequest(res, 'documentId is required');
    try {
      const { default: iFinder } = await import('../services/integrations/iFinderService.js');
      const metadata = await iFinder.getMetadata({
        documentId,
        chatId: `project-picker-${req.user.id}`,
        user: req.user,
        ...(req.query?.profile ? { searchProfile: String(req.query.profile) } : {})
      });
      res.json({ metadata });
    } catch (error) {
      sendFailedOperationError(res, 'read iFinder metadata', error);
    }
  });

  app.post(route('/url/check'), ...gate, async (req, res) => {
    const parsed = urlCheckSchema.safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, 'A http(s) URL is required');
    try {
      const { createSourceManager } = await import('../sources/index.js');
      const result = await createSourceManager().testSource('url', { url: parsed.data.url });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(200).json({ ok: false, error: error.message });
    }
  });

  // The text a URL item would give the model, before the item exists: read
  // through the same handler (and cache) a URL item is read with.
  app.post(route('/url/preview'), ...gate, async (req, res) => {
    const parsed = urlPreviewSchema.safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, 'A http(s) URL is required');
    try {
      const { createSourceManager } = await import('../sources/index.js');
      const { content, metadata } = await createSourceManager()
        .getHandler('url')
        .getCachedContent({ url: parsed.data.url, chatId: `project-picker-${req.user.id}` });
      res.json({
        ok: true,
        title: metadata?.title || '',
        finalUrl: metadata?.finalUrl || parsed.data.url,
        text: content || '',
        chars: (content || '').length,
        truncated: metadata?.truncated === true
      });
    } catch (error) {
      res.status(200).json({ ok: false, error: error.message });
    }
  });

  // The pages of a site below a start URL, for picking several at once.
  app.post(route('/url/crawl'), ...gate, async (req, res) => {
    const parsed = urlCrawlSchema.safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, 'A http(s) URL is required');
    try {
      const { crawlSite } = await import('../services/projects/siteCrawler.js');
      const result = await crawlSite(parsed.data);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(200).json({ ok: false, error: error.message });
    }
  });

  app.get(route('/cloud'), ...gate, (req, res) => {
    // Which cloud providers the picker may offer; the file browsing itself
    // goes through the existing integration routes.
    const providers = (platformOf().cloudStorage?.providers || [])
      .filter(provider => provider && provider.enabled !== false)
      .map(provider => ({
        id: provider.id,
        type: provider.type,
        displayName: provider.displayName || provider.name || provider.id
      }));
    res.json({ providers });
  });
}

export default registerProjectPickerRoutes;
