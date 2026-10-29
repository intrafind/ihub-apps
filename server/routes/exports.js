// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import rateLimit from 'express-rate-limit';
import { authRequired } from '../middleware/authRequired.js';
import configCache from '../configCache.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import { buildServerPath } from '../utils/basePath.js';
import { buildContentDisposition } from '../utils/safeContentDisposition.js';
import logger from '../utils/logger.js';
import { sendErrorResponse } from '../utils/responseHelpers.js';
import {
  buildChatExportSpec,
  buildMarkdownExportSpec,
  renderExport
} from '../services/documents/ExportService.js';
import { safeFileName } from '../services/documents/generatedFiles.js';
import {
  applyTemplateToPdfSpec,
  templateBundleFor
} from '../services/documents/templates/applyTemplate.js';
import { DocumentGenerationError } from '../services/documents/renderService.js';

/**
 * Server-side exports. `POST /api/exports/pdf` renders a chat, or any
 * Markdown the UI offers for download, as a real PDF file (replacing the
 * browser print dialog).
 *
 * The content comes from the client, like the browser exports it replaces:
 * the endpoint renders what it is sent and stores nothing.
 */

const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Chat exports follow the `export` feature (platform and app). A Markdown
 * export — workflow output, agent artifacts — is a plain download that was
 * never behind that switch, and stays available.
 */
function chatExportAllowed(appId) {
  if (!isFeatureEnabled('export', configCache.getFeatures())) return false;
  if (typeof appId !== 'string' || !appId) return true;
  const app = (configCache.getApps()?.data || []).find(a => a.id === appId);
  // An app can switch exports off for itself (`features.export: false`).
  return app?.features?.export !== false;
}

const BUILT_IN_THEMES = ['default', 'professional', 'minimal'];

function appOf(appId) {
  if (typeof appId !== 'string' || !appId) return null;
  return (configCache.getApps()?.data || []).find(a => a.id === appId) || null;
}

/**
 * The look of an export: a document template (the app's, when it pins one;
 * else the one the request names; else the default template) or, when the
 * request names a built-in theme or no template exists, a theme.
 */
async function exportLook(body, pdfDefaults) {
  const requested = typeof body.template === 'string' ? body.template : undefined;
  const app = appOf(body.appId);
  if (!app?.documentTemplate && BUILT_IN_THEMES.includes(requested)) {
    return { theme: requested, bundle: null };
  }
  const bundle = await templateBundleFor({ format: 'pdf', app, requested });
  if (bundle) return { theme: bundle.template.pdf.theme, bundle };
  return {
    theme: BUILT_IN_THEMES.includes(pdfDefaults.defaultTemplate)
      ? pdfDefaults.defaultTemplate
      : 'default',
    bundle: null
  };
}

export default function registerExportRoutes(app) {
  app.post(buildServerPath('/api/exports/pdf'), authRequired, exportLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.kind === 'chat' && !chatExportAllowed(body.appId)) {
      return sendErrorResponse(res, 403, 'Export is not enabled');
    }
    const pdfDefaults = configCache.getPlatform()?.pdfExport || {};
    try {
      const { theme: template, bundle } = await exportLook(body, pdfDefaults);
      let spec;
      if (body.kind === 'chat') {
        spec = buildChatExportSpec({
          messages: body.messages,
          settings: body.settings,
          title: body.title,
          appName: body.appName,
          template,
          themeOptions: bundle
            ? {
                primaryColor: bundle.template.brand.primaryColor,
                accentColor: bundle.template.brand.accentColor
              }
            : undefined,
          // The dialog sends the watermark the user chose; without one the
          // platform default applies when it is enabled.
          watermark:
            body.watermark && typeof body.watermark === 'object'
              ? body.watermark
              : pdfDefaults.watermark?.enabled
                ? pdfDefaults.watermark
                : null,
          language: body.language,
          timeZone: body.timeZone
        });
      } else if (body.kind === 'markdown') {
        spec = buildMarkdownExportSpec({
          markdown: body.markdown,
          title: body.title,
          template,
          language: body.language
        });
      } else {
        return sendErrorResponse(res, 400, 'kind must be "chat" or "markdown"');
      }

      const templated = applyTemplateToPdfSpec(spec, bundle);
      const { buffer, pages } = await renderExport(templated.spec, templated.assets);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader(
        'Content-Disposition',
        buildContentDisposition(safeFileName(body.filename || spec.title, 'pdf'))
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Page-Count', String(pages));
      return res.send(buffer);
    } catch (error) {
      if (error?.status) return sendErrorResponse(res, error.status, error.message);
      if (error instanceof DocumentGenerationError) {
        const status = error.code === 'busy' ? 503 : error.code === 'timeout' ? 504 : 422;
        return sendErrorResponse(res, status, error.message);
      }
      logger.error('PDF export failed', { component: 'Exports', error });
      return sendErrorResponse(res, 500, 'The PDF could not be created.');
    }
  });
}
