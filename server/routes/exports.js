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
import { PdfGenerationError } from '../services/documents/pdf/PdfService.js';

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

export default function registerExportRoutes(app) {
  app.post(buildServerPath('/api/exports/pdf'), authRequired, exportLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.kind === 'chat' && !chatExportAllowed(body.appId)) {
      return sendErrorResponse(res, 403, 'Export is not enabled');
    }
    const pdfDefaults = configCache.getPlatform()?.pdfExport || {};
    const template = ['default', 'professional', 'minimal'].includes(body.template)
      ? body.template
      : pdfDefaults.defaultTemplate;
    try {
      let spec;
      if (body.kind === 'chat') {
        spec = buildChatExportSpec({
          messages: body.messages,
          settings: body.settings,
          title: body.title,
          appName: body.appName,
          template,
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

      const { buffer, pages } = await renderExport(spec);
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
      if (error instanceof PdfGenerationError) {
        const status = error.code === 'busy' ? 503 : error.code === 'timeout' ? 504 : 422;
        return sendErrorResponse(res, status, error.message);
      }
      logger.error('PDF export failed', { component: 'Exports', error });
      return sendErrorResponse(res, 500, 'The PDF could not be created.');
    }
  });
}
