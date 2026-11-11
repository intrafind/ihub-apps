// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import multer from 'multer';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { ASSET_SLOTS, referencedAssets } from '../../validators/documentTemplateSchema.js';
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  readTemplateAsset,
  removeTemplateAsset,
  saveTemplate,
  saveTemplateAsset
} from '../../services/documents/templates/DocumentTemplateService.js';
import { renderTemplateSample } from '../../services/documents/templates/templateSamples.js';
import { toDocumentServiceError } from '../../services/documents/documentHttpErrors.js';
import { sendCreated, segment } from '../../utils/created.js';

/**
 * Admin API for document templates (`contents/document-templates/<id>/`).
 *
 *   GET    /api/admin/document-templates                    every template
 *   POST   /api/admin/document-templates                    create one
 *   GET    /api/admin/document-templates/:id                one, with what its files hold
 *   PUT    /api/admin/document-templates/:id                save its settings
 *   DELETE /api/admin/document-templates/:id                delete it and its files
 *   POST   /api/admin/document-templates/:id/files/:slot    upload a file (multipart `file`)
 *   DELETE /api/admin/document-templates/:id/files/:slot    remove a file
 *   GET    /api/admin/document-templates/:id/files/:slot    download a file (logo preview)
 *   POST   /api/admin/document-templates/:id/sample/:format a sample PDF, PNG, DOCX or PPTX
 *
 * Every route is behind `adminAuth`. Uploaded files are parsed before they are
 * stored (`templateAssets.js`); a file that is not what its slot needs is
 * refused with a message.
 */

const MAX_UPLOAD_BYTES = Math.max(...Object.values(ASSET_SLOTS).map(slot => slot.maxBytes));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 }
});

const SAMPLE_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

const ASSET_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  ttf: 'font/ttf',
  otf: 'font/otf',
  docx: SAMPLE_TYPES.docx,
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  pptx: SAMPLE_TYPES.pptx,
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template'
};

/**
 * Runs a handler; the document services' errors keep their status, anything else is logged
 * and answered as a 500 that names the operation but not the cause.
 */
function handle(operation, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const mapped = toDocumentServiceError(error);
      if (mapped instanceof ServiceError) throw mapped;
      logger.error(`Document template ${operation} failed`, {
        component: 'AdminDocumentTemplates',
        error
      });
      throw new ServiceError('INTERNAL_ERROR', `The document template could not be ${operation}.`);
    }
  };
}

/** The file a template has in a slot (font slots: the family's face). */
function assetInSlot(template, slot, { family, face } = {}) {
  if (slot === 'logo') return template.brand.logo;
  if (slot === 'letterhead') return template.pdf.letterhead;
  if (slot === 'letterheadFollowing') return template.pdf.letterheadFollowing;
  if (slot === 'wordTemplate') return template.docx.template;
  if (slot === 'powerpointTemplate') return template.pptx.template;
  if (slot === 'font') {
    const font = template.fonts.find(f => f.family.toLowerCase() === String(family).toLowerCase());
    return font?.[face || 'normal'];
  }
  return undefined;
}

/**
 * What a template's Office files hold (layouts, placeholders), for the
 * editor. A file that cannot be read any more is reported, not fatal.
 */
async function describeFiles(template) {
  const out = {};
  if (template.pptx.template) {
    try {
      const { analyzePowerpointTemplate } =
        await import('../../services/documents/pptx/pptxTemplate.js');
      out.powerpointTemplate = await analyzePowerpointTemplate(
        await readTemplateAsset(template.id, template.pptx.template),
        template.pptx.layouts,
        { slots: template.pptx.slots }
      );
    } catch (error) {
      out.powerpointTemplate = { error: error.message };
    }
  }
  if (template.docx.template) {
    try {
      const { inspectWordTemplate } = await import('../../services/documents/docx/wordTemplate.js');
      out.wordTemplate = await inspectWordTemplate(
        await readTemplateAsset(template.id, template.docx.template)
      );
    } catch (error) {
      out.wordTemplate = { error: error.message };
    }
  }
  return out;
}

/** Runs the multipart upload middleware; its failures are answered as ServiceErrors. */
function receiveUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, uploadError => {
      if (!uploadError) return resolve();
      if (uploadError.code === 'LIMIT_FILE_SIZE') {
        return reject(new ServiceError('PAYLOAD_TOO_LARGE', 'The file is too large.'));
      }
      reject(new ServiceError('BAD_REQUEST', 'Invalid upload.'));
    });
  });
}

export default function registerAdminDocumentTemplatesRoutes(app) {
  const base = buildServerPath('/api/admin/document-templates');
  const bodyOf = req => (req.body && typeof req.body === 'object' ? req.body : {});

  app.get(
    base,
    adminAuth,
    handle('loaded', async (req, res) => {
      res.json({ items: await listTemplates({ includeDisabled: true }) });
    })
  );

  app.post(
    base,
    adminAuth,
    handle('created', async (req, res) => {
      const body = bodyOf(req);
      const template = await saveTemplate(String(body.id || ''), body, { create: true });
      sendCreated(res, `/api/admin/document-templates/${segment(template.id)}`, template);
    })
  );

  app.get(
    `${base}/:id`,
    adminAuth,
    handle('loaded', async (req, res) => {
      const template = await getTemplate(req.params.id, { includeDisabled: true });
      if (!template) throw new ServiceError('NOT_FOUND', 'Template not found.');
      res.json({ template, files: await describeFiles(template) });
    })
  );

  app.put(
    `${base}/:id`,
    adminAuth,
    handle('saved', async (req, res) => {
      const template = await saveTemplate(req.params.id, bodyOf(req));
      res.json({ template, files: await describeFiles(template) });
    })
  );

  app.delete(
    `${base}/:id`,
    adminAuth,
    handle('deleted', async (req, res) => {
      await deleteTemplate(req.params.id);
      res.status(204).end();
    })
  );

  app.post(
    `${base}/:id/files/:slot`,
    adminAuth,
    handle('saved', async (req, res) => {
      await receiveUpload(req, res);
      if (!Object.hasOwn(ASSET_SLOTS, req.params.slot)) {
        throw new ServiceError('BAD_REQUEST', 'Unknown template file slot.');
      }
      if (!req.file?.buffer) throw new ServiceError('BAD_REQUEST', 'No file uploaded.');
      const result = await saveTemplateAsset(req.params.id, {
        slot: req.params.slot,
        data: req.file.buffer,
        originalName: req.file.originalname,
        family: req.body?.family,
        face: req.body?.face || 'normal'
      });
      res.json({
        template: result.template,
        file: result.file,
        info: result.info,
        files: await describeFiles(result.template)
      });
    })
  );

  app.delete(
    `${base}/:id/files/:slot`,
    adminAuth,
    handle('saved', async (req, res) => {
      const template = await removeTemplateAsset(req.params.id, {
        slot: req.params.slot,
        family: req.query.family,
        face: req.query.face
      });
      res.json({ template, files: await describeFiles(template) });
    })
  );

  app.get(
    `${base}/:id/files/:slot`,
    adminAuth,
    handle('loaded', async (req, res) => {
      const template = await getTemplate(req.params.id, { includeDisabled: true });
      const name = template
        ? assetInSlot(template, req.params.slot, {
            family: req.query.family,
            face: req.query.face
          })
        : null;
      if (!name || !referencedAssets(template).includes(name)) {
        throw new ServiceError('NOT_FOUND', 'File not found.');
      }
      const data = await readTemplateAsset(template.id, name);
      const extension = name.split('.').pop();
      res.setHeader('Content-Type', ASSET_TYPES[extension] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      // Only the logo is shown in the page; every other file downloads.
      if (req.params.slot !== 'logo') {
        res.setHeader('Content-Disposition', buildContentDisposition(name));
      }
      res.send(data);
    })
  );

  app.post(
    `${base}/:id/sample/:format`,
    adminAuth,
    handle('rendered', async (req, res) => {
      const format = req.params.format;
      if (!SAMPLE_TYPES[format]) throw new ServiceError('BAD_REQUEST', 'Unknown sample format.');
      const template = await getTemplate(req.params.id, { includeDisabled: true });
      if (!template) throw new ServiceError('NOT_FOUND', 'Template not found.');
      const language = typeof req.body?.language === 'string' ? req.body.language : 'en';
      const { buffer, filename } = await renderTemplateSample(template, format, language);
      res.setHeader('Content-Type', SAMPLE_TYPES[format]);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (format !== 'png') res.setHeader('Content-Disposition', buildContentDisposition(filename));
      res.send(buffer);
    })
  );
}
