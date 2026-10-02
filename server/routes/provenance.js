/**
 * Public provenance surface (EU AI Act Art. 50(2); issues #2573, #2575):
 *
 * - `GET /.well-known/ai-provenance` — the signpost target: detector
 *   endpoint, supported techniques, trust anchor (CoP 3.4(c) option ii)
 * - `GET /api/provenance/info` — what the caller may do
 * - `POST /api/provenance/verify` — detection (file upload or text), with a
 *   signed report; access per `aiTransparency.detection.access`, rate
 *   limited, zero retention
 * - `POST /api/provenance/report/verify` — check a signed detection report
 * - `GET /api/provenance/trust-anchor.pem` — this installation's root
 *
 * @module routes/provenance
 */
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { buildServerPath } from '../utils/basePath.js';
import { authRequired } from '../middleware/authRequired.js';
import provenanceStore from '../services/provenance/ProvenanceStore.js';
import { applyTextSignpost, signpostEnabled } from '../services/provenance/text/signpost.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendInternalError,
  sendNotFound
} from '../utils/responseHelpers.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { isAdminAuthRequired } from '../middleware/adminAuth.js';
import { getAiTransparencyConfig, isAiTransparencyActive } from '../services/provenance/config.js';
import { getInstallationId, getInstallationUrl } from '../services/provenance/installation.js';
import signingService from '../services/provenance/signing/SigningService.js';
import {
  verifyContent,
  verifyDetectionReport
} from '../services/provenance/detection/DetectionService.js';
import detectionLog from '../services/provenance/detection/DetectionLog.js';
import {
  TRUSTMARK_PAYLOAD_BITS,
  TRUSTMARK_SOFT_BINDING_ALG,
  TRUSTMARK_VARIANT,
  TRUSTMARK_VERSION
} from '../services/provenance/image/ImageMarker.js';
import { C2PA_WRITABLE_TYPES } from '../services/provenance/signing/c2pa.js';

const COMPONENT = 'ProvenanceRoutes';
const MAX_TEXT_CHARS = 1_000_000;

function maxUploadBytes() {
  const mb = Number(configCache.getPlatform()?.requestBodyLimitMB) || 50;
  return Math.min(mb, 100) * 1024 * 1024;
}

function isAdmin(req) {
  try {
    return !isAdminAuthRequired(req);
  } catch {
    return false;
  }
}

function isSignedIn(req) {
  return Boolean(req.user && req.user.id && req.user.id !== 'anonymous');
}

function isExpert(req, cfg) {
  if (!isSignedIn(req)) return false;
  return (cfg.detection.experts || []).some(e => e.userId === req.user.id);
}

/**
 * May this caller use the detector at all, and text watermark detection?
 */
export function detectionAccess(req, cfg = getAiTransparencyConfig()) {
  if (!isAiTransparencyActive() || !cfg.detection.enabled) {
    return { allowed: false, reason: 'disabled', canUseTextDetection: false };
  }
  const admin = isAdmin(req);
  const expert = isExpert(req, cfg);
  let allowed;
  if (cfg.detection.access === 'public') allowed = true;
  else if (cfg.detection.access === 'authenticated') allowed = isSignedIn(req);
  else allowed = admin || expert;
  return {
    allowed,
    reason: allowed ? null : isSignedIn(req) ? 'forbidden' : 'authentication-required',
    canUseTextDetection: allowed && (admin || expert)
  };
}

function techniquesInfo() {
  return [
    { id: 'c2pa', description: 'Signed C2PA manifest', formats: C2PA_WRITABLE_TYPES },
    {
      id: 'trustmark',
      description: 'Invisible image watermark, C2PA soft binding',
      variant: TRUSTMARK_VARIANT,
      version: TRUSTMARK_VERSION,
      payloadBits: TRUSTMARK_PAYLOAD_BITS,
      softBindingAlg: TRUSTMARK_SOFT_BINDING_ALG
    },
    {
      id: 'xmp',
      description: 'IPTC Iptc4xmpExt:DigitalSourceType',
      formats: ['image/png', 'image/jpeg', 'application/pdf']
    },
    {
      id: 'ihub-manifest',
      description: 'Signed iHub provenance manifest (JWS, x5c) with a hard binding to the file',
      formats: ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'json', 'jsonl']
    },
    {
      id: 'text-signpost',
      description: 'C2PA text manifest wrapper (C2PA 2.4 Appendix A.8) carrying a signed signpost',
      payload: 'ihub-text-signpost+jws'
    },
    {
      id: 'text-watermark',
      description: 'Generation-time watermark of self-hosted models (vLLM Gumbel-max)',
      access: 'approved experts'
    }
  ];
}

export default function registerProvenanceRoutes(app) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes(), files: 1 }
  });

  // Rate limiter rebuilt when the configured window/limit changes.
  let limiterKey = null;
  let limiter = null;
  const detectionLimiter = (req, res, next) => {
    const { windowMinutes, limit } = getAiTransparencyConfig().detection.rateLimit;
    const key = `${windowMinutes}:${limit}`;
    if (key !== limiterKey) {
      limiterKey = key;
      limiter = rateLimit({
        windowMs: Math.max(1, windowMinutes) * 60 * 1000,
        limit: Math.max(1, limit),
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many verification requests, please try again later.' }
      });
    }
    return limiter(req, res, next);
  };

  /**
   * @swagger
   * /.well-known/ai-provenance:
   *   get:
   *     summary: AI provenance signpost of this installation
   *     description: Detector endpoint, supported marking techniques and trust anchor (EU AI Act Art. 50, CoP Measure 3.4).
   *     tags: [Well-Known]
   */
  app.get('/.well-known/ai-provenance', async (req, res) => {
    try {
      const cfg = getAiTransparencyConfig();
      const base = getInstallationUrl(req);
      const anchor = await signingService.getPublishedAnchor();
      // Reports are signed only when there is a usable signer right now.
      const signer = await signingService.getActiveSigner().catch(() => null);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({
        version: 1,
        issuer: {
          system: 'iHub Apps',
          provider: cfg.provider.legalEntity || null,
          installationId: getInstallationId(),
          installationUrl: base || null
        },
        detector: {
          enabled: isAiTransparencyActive() && cfg.detection.enabled,
          access: cfg.detection.access,
          endpoint: `${base}/api/provenance/verify`,
          ui: `${base}/verify`,
          methods: [
            'POST multipart/form-data (field "file")',
            'POST application/json {"text": "..."}'
          ],
          reportVerification: `${base}/api/provenance/report/verify`,
          signedReports: Boolean(signer),
          retention: 'none'
        },
        techniques: techniquesInfo(),
        trustAnchors: anchor ? [anchor] : [],
        trustAnchorUrl: `${base}/api/provenance/trust-anchor.pem`,
        specification:
          'https://github.com/intrafind/ihub-apps/blob/main/docs/eu-ai-act-detection-api.md'
      });
    } catch (error) {
      sendInternalError(res, error, 'build AI provenance signpost');
    }
  });

  app.get(buildServerPath('/api/provenance/trust-anchor.pem'), async (_req, res) => {
    try {
      const pem = await signingService.getPublishedAnchor();
      if (!pem) return sendNotFound(res, 'Trust anchor');
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(pem);
    } catch (error) {
      return sendInternalError(res, error, 'read trust anchor');
    }
  });

  app.get(buildServerPath('/api/provenance/info'), (req, res) => {
    const cfg = getAiTransparencyConfig();
    const access = detectionAccess(req, cfg);
    res.json({
      enabled: isAiTransparencyActive() && cfg.detection.enabled,
      access: cfg.detection.access,
      canVerify: access.allowed,
      reason: access.reason,
      canUseTextDetection: access.canUseTextDetection,
      maxUploadMB: Math.round(maxUploadBytes() / 1024 / 1024),
      techniques: techniquesInfo().map(t => t.id)
    });
  });

  /**
   * @swagger
   * /api/provenance/verify:
   *   post:
   *     summary: Check content for AI markings (EU AI Act Art. 50 detection)
   *     description: |
   *       Upload a file (multipart field `file`) or send `{ "text": "..." }`. Returns which
   *       technique found a mark and a signed report. Submitted content is not stored.
   *     tags: [Provenance]
   */
  app.post(
    buildServerPath('/api/provenance/verify'),
    detectionLimiter,
    (req, res, next) => {
      const access = detectionAccess(req);
      if (!access.allowed) {
        const status =
          access.reason === 'disabled'
            ? 404
            : access.reason === 'authentication-required'
              ? 401
              : 403;
        return sendErrorResponse(
          res,
          status,
          access.reason === 'disabled'
            ? 'Detection is not available'
            : 'Not allowed to use the detector'
        );
      }
      req.detectionAccess = access;
      if (req.is('multipart/form-data')) {
        return upload.single('file')(req, res, err => {
          if (err) {
            return sendBadRequest(
              res,
              err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : err.message
            );
          }
          return next();
        });
      }
      return next();
    },
    async (req, res) => {
      const started = Date.now();
      try {
        let input;
        if (req.file?.buffer) {
          input = { buffer: req.file.buffer, mimeType: req.file.mimetype };
        } else if (typeof req.body?.text === 'string' && req.body.text.length > 0) {
          if (req.body.text.length > MAX_TEXT_CHARS)
            return sendBadRequest(res, 'The text is too long');
          input = { text: req.body.text };
        } else {
          return sendBadRequest(res, 'Upload a file (field "file") or send { "text": "..." }');
        }
        const outcome = await verifyContent(input, {
          canUseTextDetection: req.detectionAccess.canUseTextDetection
        });
        // Zero retention: drop the reference to the upload right away.
        if (req.file) req.file.buffer = null;
        detectionLog
          .add({
            requester: isSignedIn(req) ? { type: 'user', id: req.user.id } : { type: 'anonymous' },
            contentHash: outcome.result.content.sha256,
            kind: outcome.result.content.kind,
            mimeType: outcome.result.content.mimeType,
            size: outcome.result.content.size,
            verdict: outcome.result.verdict,
            techniques: outcome.result.techniques.filter(t => t.found).map(t => t.technique),
            durationMs: Date.now() - started
          })
          .catch(() => {});
        res.setHeader('Cache-Control', 'no-store');
        return res.json(outcome);
      } catch (error) {
        logger.error('Verification failed', { component: COMPONENT, error: error.message });
        return sendInternalError(res, error, 'verify content');
      }
    }
  );

  /**
   * Text with a signed signpost for the clipboard (when the admin switched
   * the clipboard signpost on, platform- or app-wide).
   */
  app.post(buildServerPath('/api/provenance/signpost'), authRequired, async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text || text.length > MAX_TEXT_CHARS) {
      return sendBadRequest(res, 'Send { "text": "..." }');
    }
    try {
      const cfg = getAiTransparencyConfig();
      const app = req.body?.appId
        ? (configCache.getApps(true)?.data || []).find(a => a.id === req.body.appId)
        : null;
      if (!isAiTransparencyActive() || !signpostEnabled('clipboard', cfg, app)) {
        return res.json({ text, signed: false });
      }
      const record = await provenanceStore.findByContent(text);
      const signed = await applyTextSignpost(text, {
        contentId: record?.contentId,
        verification: record ? 'verified' : 'asserted'
      });
      return res.json({ text: signed, signed: signed !== text });
    } catch (error) {
      return sendInternalError(res, error, 'sign clipboard text');
    }
  });

  app.post(buildServerPath('/api/provenance/report/verify'), detectionLimiter, async (req, res) => {
    const report = req.body?.report;
    if (typeof report !== 'string' || report.split('.').length !== 3) {
      return sendBadRequest(res, 'Send { "report": "<signed report>" }');
    }
    try {
      return res.json(await verifyDetectionReport(report));
    } catch (error) {
      return sendInternalError(res, error, 'verify detection report');
    }
  });
}
