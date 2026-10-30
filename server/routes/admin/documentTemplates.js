// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import multer from 'multer';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { sendErrorResponse } from '../../utils/responseHelpers.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { ASSET_SLOTS, referencedAssets } from '../../validators/documentTemplateSchema.js';
import {
  DocumentTemplateError,
  deleteTemplate,
  getTemplate,
  listTemplates,
  readTemplateAsset,
  removeTemplateAsset,
  saveTemplate,
  saveTemplateAsset
} from '../../services/documents/templates/DocumentTemplateService.js';
import { renderTemplateSample } from '../../services/documents/templates/templateSamples.js';
import { DocumentGenerationError } from '../../services/documents/renderService.js';

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

function fail(res, error, operation) {
  if (error instanceof DocumentTemplateError) {
    return sendErrorResponse(res, error.status, error.message);
  }
  if (error instanceof DocumentGenerationError) {
    return sendErrorResponse(res, error.code === 'busy' ? 503 : 422, error.message);
  }
  logger.error(`Document template ${operation} failed`, {
    component: 'AdminDocumentTemplates',
    error
  });
  return sendErrorResponse(res, 500, `The document template could not be ${operation}.`);
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
        template.pptx.layouts
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

export default function registerAdminDocumentTemplatesRoutes(app) {
  const base = buildServerPath('/api/admin/document-templates');

  app.get(base, adminAuth, async (req, res) => {
    try {
      res.json({ templates: await listTemplates({ includeDisabled: true }) });
    } catch (error) {
      fail(res, error, 'loaded');
    }
  });

  app.post(base, adminAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const template = await saveTemplate(String(body.id || ''), body, { create: true });
      res.status(201).json({ template });
    } catch (error) {
      fail(res, error, 'created');
    }
  });

  app.get(`${base}/:id`, adminAuth, async (req, res) => {
    try {
      const template = await getTemplate(req.params.id, { includeDisabled: true });
      if (!template) return sendErrorResponse(res, 404, 'Template not found.');
      res.json({ template, files: await describeFiles(template) });
    } catch (error) {
      fail(res, error, 'loaded');
    }
  });

  app.put(`${base}/:id`, adminAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const template = await saveTemplate(req.params.id, body);
      res.json({ template, files: await describeFiles(template) });
    } catch (error) {
      fail(res, error, 'saved');
    }
  });

  app.delete(`${base}/:id`, adminAuth, async (req, res) => {
    try {
      await deleteTemplate(req.params.id);
      res.json({ success: true });
    } catch (error) {
      fail(res, error, 'deleted');
    }
  });

  app.post(`${base}/:id/files/:slot`, adminAuth, (req, res) => {
    upload.single('file')(req, res, async uploadError => {
      if (uploadError) {
        return sendErrorResponse(
          res,
          uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
          uploadError.code === 'LIMIT_FILE_SIZE' ? 'The file is too large.' : 'Invalid upload.'
        );
      }
      if (!Object.hasOwn(ASSET_SLOTS, req.params.slot)) {
        return sendErrorResponse(res, 400, 'Unknown template file slot.');
      }
      if (!req.file?.buffer) return sendErrorResponse(res, 400, 'No file uploaded.');
      try {
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
      } catch (error) {
        fail(res, error, 'saved');
      }
    });
  });

  app.delete(`${base}/:id/files/:slot`, adminAuth, async (req, res) => {
    try {
      const template = await removeTemplateAsset(req.params.id, {
        slot: req.params.slot,
        family: req.query.family,
        face: req.query.face
      });
      res.json({ template, files: await describeFiles(template) });
    } catch (error) {
      fail(res, error, 'saved');
    }
  });

  app.get(`${base}/:id/files/:slot`, adminAuth, async (req, res) => {
    try {
      const template = await getTemplate(req.params.id, { includeDisabled: true });
      const name = template
        ? assetInSlot(template, req.params.slot, {
            family: req.query.family,
            face: req.query.face
          })
        : null;
      if (!name || !referencedAssets(template).includes(name)) {
        return sendErrorResponse(res, 404, 'File not found.');
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
    } catch (error) {
      fail(res, error, 'loaded');
    }
  });

  app.post(`${base}/:id/sample/:format`, adminAuth, async (req, res) => {
    const format = req.params.format;
    if (!SAMPLE_TYPES[format]) return sendErrorResponse(res, 400, 'Unknown sample format.');
    try {
      const template = await getTemplate(req.params.id, { includeDisabled: true });
      if (!template) return sendErrorResponse(res, 404, 'Template not found.');
      const language = typeof req.body?.language === 'string' ? req.body.language : 'en';
      const { buffer, filename } = await renderTemplateSample(template, format, language);
      res.setHeader('Content-Type', SAMPLE_TYPES[format]);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (format !== 'png') res.setHeader('Content-Disposition', buildContentDisposition(filename));
      res.send(buffer);
    } catch (error) {
      fail(res, error, 'rendered');
    }
  });
}
