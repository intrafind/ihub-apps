/**
 * Server-side exports (EU AI Act Art. 50(2); issues #2571, #2576).
 *
 * `POST /api/exports` renders the selected messages or document in the
 * requested format, embeds signed provenance (see
 * `services/provenance/export/ExportSigner.js`) and returns the file.
 * `GET /api/exports/manifests/:manifestId` returns the signed manifest as a
 * sidecar for formats and tools that lose the embedded one.
 *
 * @module routes/exports
 */
import { z } from 'zod';
import { authRequired } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendInternalError,
  sendNotFound
} from '../utils/responseHelpers.js';
import configCache from '../configCache.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import logger from '../utils/logger.js';
import {
  createExport,
  ExportError,
  MAX_EXPORT_MESSAGES
} from '../services/provenance/export/ExportService.js';
import { EXPORT_FORMATS } from '../services/provenance/export/renderers/index.js';
import provenanceStore from '../services/provenance/ProvenanceStore.js';
import { decodeJws } from '../services/provenance/signing/jws.js';

const exportBodySchema = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    appId: z.string().max(200).optional(),
    chatId: z.string().max(200).optional(),
    title: z.string().max(300).optional(),
    messageIds: z.array(z.string().max(200)).max(MAX_EXPORT_MESSAGES).optional(),
    messages: z
      .array(
        z
          .object({
            id: z.string().max(200).optional(),
            role: z.enum(['user', 'assistant', 'system']),
            content: z.string().max(500000),
            timestamp: z.string().max(64).optional(),
            model: z.string().max(200).optional()
          })
          .passthrough()
      )
      .max(MAX_EXPORT_MESSAGES)
      .optional(),
    settings: z
      .object({
        model: z.string().max(200).optional().nullable(),
        style: z.string().max(200).optional().nullable(),
        outputFormat: z.string().max(100).optional().nullable(),
        temperature: z.union([z.number(), z.string()]).optional().nullable(),
        variables: z.record(z.string(), z.any()).optional().nullable()
      })
      .passthrough()
      .optional()
      .nullable(),
    source: z.enum(['chat', 'canvas', 'markdown', 'workflow', 'artifact']).optional(),
    options: z
      .object({
        template: z.enum(['default', 'professional', 'minimal']).optional(),
        euIcon: z.boolean().optional(),
        humanReviewed: z.boolean().optional()
      })
      .passthrough()
      .optional(),
    single: z.boolean().optional()
  })
  .refine(b => (b.messageIds && b.chatId) || (Array.isArray(b.messages) && b.messages.length > 0), {
    message: 'Send messageIds with a chatId, or the selected messages'
  });

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export default function registerExportRoutes(app) {
  /**
   * @swagger
   * /api/exports:
   *   post:
   *     summary: Export messages or a document (signed, AI-labelled)
   *     description: |
   *       Renders the selected chat messages (by id for stored chats, or as sent by
   *       the client for unstored chats) or a document in PDF, DOCX, PPTX, XLSX, CSV,
   *       TXT, Markdown, HTML, JSON or JSONL, with a visible AI label and signed
   *       provenance metadata (EU AI Act Art. 50). The `X-AI-Export-Manifest` header
   *       carries the manifest id.
   *     tags: [Exports]
   */
  app.post(buildServerPath('/api/exports'), authRequired, async (req, res) => {
    if (!isFeatureEnabled('export', configCache.getFeatures())) {
      return sendErrorResponse(res, 403, 'Exports are disabled');
    }
    const parsed = exportBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendBadRequest(
        res,
        `Invalid export request: ${parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`
      );
    }
    try {
      const language = String(req.headers['accept-language'] || 'en').slice(0, 2);
      const result = await createExport(parsed.data, { user: req.user, language });
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', contentDisposition(result.filename));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-AI-Generated', 'true');
      if (result.manifestId) res.setHeader('X-AI-Export-Manifest', result.manifestId);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-AI-Export-Manifest');
      return res.send(result.buffer);
    } catch (error) {
      if (error instanceof ExportError) return sendErrorResponse(res, error.status, error.message);
      logger.error('Export failed', {
        component: 'Exports',
        format: parsed.data.format,
        error: error.message
      });
      return sendInternalError(res, error, 'create export');
    }
  });

  /** The signed manifest of an export (sidecar). */
  app.get(buildServerPath('/api/exports/manifests/:manifestId'), authRequired, async (req, res) => {
    try {
      const record = await provenanceStore.get(req.params.manifestId);
      if (!record || record.kind !== 'export' || !record.jws) return sendNotFound(res, 'Manifest');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        manifestId: record.contentId,
        format: record.format,
        createdAt: record.generatedAt,
        fileHash: record.contentHash,
        jws: record.jws,
        payload: decodeJws(record.jws)?.payload || null
      });
    } catch (error) {
      return sendInternalError(res, error, 'read export manifest');
    }
  });
}
