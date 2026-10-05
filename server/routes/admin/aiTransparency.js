/**
 * Admin API of the EU AI Act page (`/admin/eu-ai-act`, issue #2566 and the
 * admin parts of #2564, #2565, #2568, #2572, #2573, #2577).
 *
 * Every record an admin makes here — a disclosure opt-out, an exemption, an
 * unmarked-model acknowledgement, a dismissed warning, an expert approval —
 * is stamped by the server (who, when, installation URL/id, iHub version),
 * needs a reason, and goes to the audit log. Key material never leaves in
 * plaintext except the explicit, audited "reveal vLLM config" and the
 * passphrase-encrypted key bundle.
 *
 * @module routes/admin/aiTransparency
 */
import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendInternalError,
  sendNotFound
} from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { logAudit } from '../../services/AuditLogService.js';
import { EXEMPTION_TYPES, resolveAiTransparency } from '../../../shared/aiTransparency.js';
import { aiTransparencyPlatformSchema } from '../../validators/aiTransparencySchema.js';
import { actorOf, getInstallationInfo } from '../../services/provenance/installation.js';
import { buildAcknowledgement, stampOf } from '../../services/provenance/records.js';
import {
  evaluateCompliance,
  isDismissibleWarning
} from '../../services/provenance/ComplianceService.js';
import signingService, { SigningError } from '../../services/provenance/signing/SigningService.js';
import { parsePemCertificates } from '../../services/provenance/signing/x509.js';
import keyGroupService, {
  KeyGroupError
} from '../../services/provenance/watermark/KeyGroupService.js';
import detectionLog from '../../services/provenance/detection/DetectionLog.js';
import {
  runMarkingBenchmark,
  latestBenchmark
} from '../../services/provenance/benchmark/MarkingBenchmark.js';
import { buildComplianceReport } from '../../services/provenance/report/ComplianceReport.js';

const PLATFORM_FILE = 'config/platform.json';
const reasonSchema = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(2000);

/** Sections of `platform.aiTransparency` the settings form may change. */
const EDITABLE_SECTIONS = [
  'provider',
  'editorialResponsibility',
  'termsOfService',
  'interactionDisclosure',
  'labels',
  'images',
  'text',
  'provenance',
  'exports',
  'signing',
  'detection',
  'installationUrl'
];

function sendServiceError(res, error, operation) {
  if (error instanceof SigningError || error instanceof KeyGroupError) {
    return sendErrorResponse(res, error.status || 400, error.message, {
      details: error.details || undefined
    });
  }
  return sendInternalError(res, error, operation);
}

async function readPlatform() {
  const platform = await configStore.readJson(PLATFORM_FILE);
  if (!platform) throw new Error('Unable to read config/platform.json');
  return platform;
}

async function writePlatform(platform) {
  await configStore.writeJson(PLATFORM_FILE, platform);
  await configCache.refreshCacheEntry(PLATFORM_FILE);
}

function deepMergeSection(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? deepMergeSection(out[key], value)
        : value;
  }
  return out;
}

async function updateAppRecord(appId, mutate) {
  const relPath = await configStore.resolveIdToPath('apps', appId, { createIfMissing: false });
  if (!relPath) return null;
  const app = await configStore.readJson(relPath);
  if (!app) return null;
  mutate(app);
  if (app.aiTransparency && Object.keys(app.aiTransparency).length === 0) delete app.aiTransparency;
  await configStore.writeJson(relPath, app);
  await configCache.refreshAppsCache();
  return app;
}

async function updateModelRecord(modelId, mutate) {
  const relPath = await configStore.resolveIdToPath('models', modelId, { createIfMissing: false });
  if (!relPath) return null;
  const model = await configStore.readJson(relPath);
  if (!model) return null;
  mutate(model);
  await configStore.writeJson(relPath, model);
  await configCache.refreshModelsCache();
  return model;
}

export default function registerAdminAiTransparencyRoutes(app) {
  const base = '/api/admin/ai-transparency';
  const route = path => buildServerPath(`${base}${path}`);

  // ── Status ─────────────────────────────────────────────────────────────

  /** Full conformance status for the EU AI Act page. */
  app.get(route('/status'), adminAuth, async (req, res) => {
    try {
      res.json(await evaluateCompliance({ req }));
    } catch (error) {
      sendInternalError(res, error, 'evaluate EU AI Act compliance');
    }
  });

  /** The start-page / admin-overview banner: undismissed warnings only. */
  app.get(route('/banner'), adminAuth, async (req, res) => {
    try {
      const status = await evaluateCompliance({ req });
      res.json({
        conforming: status.conforming,
        featureActive: status.featureActive,
        warnings: status.activeWarnings.map(({ id, severity, message, params, dismissible }) => ({
          id,
          severity,
          message,
          params,
          dismissible
        })),
        dismissedCount: status.warnings.length - status.activeWarnings.length
      });
    } catch (error) {
      sendInternalError(res, error, 'build EU AI Act banner');
    }
  });

  // ── Settings ───────────────────────────────────────────────────────────

  app.get(route('/settings'), adminAuth, async (req, res) => {
    try {
      const platform = await readPlatform();
      res.json({
        settings: resolveAiTransparency(platform.aiTransparency),
        installation: getInstallationInfo(req)
      });
    } catch (error) {
      sendInternalError(res, error, 'read EU AI Act settings');
    }
  });

  app.put(route('/settings'), adminAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(body).filter(k => !EDITABLE_SECTIONS.includes(k));
    if (unknown.length) return sendBadRequest(res, `Not editable here: ${unknown.join(', ')}`);
    try {
      const platform = await readPlatform();
      const current = platform.aiTransparency || {};
      const next = { ...current };
      const changed = [];
      for (const key of EDITABLE_SECTIONS) {
        if (!(key in body)) continue;
        let value = body[key];
        if (key === 'detection' && value && typeof value === 'object') {
          // Experts are approved one by one (audited), zero retention is fixed.
          const { experts: _experts, zeroRetention: _z, ...rest } = value;
          value = rest;
        }
        const merged =
          typeof value === 'object' && value !== null
            ? deepMergeSection(current[key], value)
            : value;
        if (JSON.stringify(merged) !== JSON.stringify(current[key])) {
          next[key] = merged;
          changed.push(key);
        }
      }
      for (const pem of next.signing?.trustedAnchors || []) {
        if (typeof pem !== 'string' || parsePemCertificates(pem).length === 0) {
          return sendBadRequest(res, 'Every trusted anchor must be a PEM certificate');
        }
      }
      const parsed = aiTransparencyPlatformSchema.safeParse(next);
      if (!parsed.success) {
        return sendBadRequest(
          res,
          `Invalid settings: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        );
      }
      if (changed.length) {
        platform.aiTransparency = next;
        await writePlatform(platform);
        logAudit({
          req,
          action: 'update',
          resource: 'ai-transparency',
          resourceId: 'settings',
          summary: `Updated EU AI Act settings: ${changed.join(', ')}`
        });
      }
      res.json({ settings: resolveAiTransparency(next), changed });
    } catch (error) {
      sendInternalError(res, error, 'save EU AI Act settings');
    }
  });

  // ── Dismissals ─────────────────────────────────────────────────────────

  app.post(route('/dismissals'), adminAuth, async (req, res) => {
    const parsed = z
      .object({ warningId: z.string().min(1).max(200), reason: reasonSchema })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    const { warningId, reason } = parsed.data;
    if (!isDismissibleWarning(warningId)) {
      return sendBadRequest(res, 'This warning cannot be dismissed');
    }
    try {
      const status = await evaluateCompliance({ req });
      const warning = status.warnings.find(w => w.id === warningId);
      if (!warning) return sendNotFound(res, 'No such warning is active');
      const stamp = stampOf(req);
      const record = {
        warningId,
        stateHash: warning.stateHash,
        reason,
        dismissedBy: stamp.by,
        dismissedByName: stamp.byName,
        dismissedAt: stamp.at,
        installationUrl: stamp.installationUrl,
        installationId: stamp.installationId,
        ihubVersion: stamp.ihubVersion,
        message: warning.message
      };
      const platform = await readPlatform();
      const section = platform.aiTransparency || {};
      section.dismissals = [
        ...(section.dismissals || []).filter(d => d.warningId !== warningId),
        record
      ];
      platform.aiTransparency = section;
      await writePlatform(platform);
      logAudit({
        req,
        action: 'update',
        resource: 'ai-transparency-warning',
        resourceId: warningId,
        summary: `Dismissed EU AI Act warning "${warning.message}": ${reason}`
      });
      res.json({ dismissal: record });
    } catch (error) {
      sendInternalError(res, error, 'dismiss EU AI Act warning');
    }
  });

  app.delete(route('/dismissals/:warningId'), adminAuth, async (req, res) => {
    try {
      const platform = await readPlatform();
      const section = platform.aiTransparency || {};
      const before = (section.dismissals || []).length;
      section.dismissals = (section.dismissals || []).filter(
        d => d.warningId !== req.params.warningId
      );
      if (section.dismissals.length === before) return sendNotFound(res, 'No such dismissal');
      platform.aiTransparency = section;
      await writePlatform(platform);
      logAudit({
        req,
        action: 'delete',
        resource: 'ai-transparency-warning',
        resourceId: req.params.warningId,
        summary: `Restored EU AI Act warning ${req.params.warningId}`
      });
      res.json({ success: true });
    } catch (error) {
      sendInternalError(res, error, 'restore EU AI Act warning');
    }
  });

  // ── Apps: disclosure opt-out and exemptions ───────────────────────────

  app.put(route('/apps/:appId/disclosure-opt-out'), adminAuth, async (req, res) => {
    const parsed = z
      .object({ reason: reasonSchema })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const stamp = stampOf(req);
      const record = {
        disabledBy: stamp.by,
        disabledByName: stamp.byName,
        disabledAt: stamp.at,
        reason: parsed.data.reason,
        installationUrl: stamp.installationUrl,
        installationId: stamp.installationId,
        ihubVersion: stamp.ihubVersion
      };
      const updated = await updateAppRecord(req.params.appId, appConfig => {
        appConfig.aiTransparency = {
          ...(appConfig.aiTransparency || {}),
          disclosureOptOut: record
        };
      });
      if (!updated) return sendNotFound(res, 'App not found');
      logAudit({
        req,
        action: 'update',
        resource: 'app',
        resourceId: req.params.appId,
        summary: `Switched off the Art. 50(1) AI disclosure: ${parsed.data.reason}`
      });
      res.json({ disclosureOptOut: record });
    } catch (error) {
      sendInternalError(res, error, 'record disclosure opt-out');
    }
  });

  app.delete(route('/apps/:appId/disclosure-opt-out'), adminAuth, async (req, res) => {
    try {
      const updated = await updateAppRecord(req.params.appId, appConfig => {
        if (appConfig.aiTransparency) delete appConfig.aiTransparency.disclosureOptOut;
      });
      if (!updated) return sendNotFound(res, 'App not found');
      logAudit({
        req,
        action: 'update',
        resource: 'app',
        resourceId: req.params.appId,
        summary: 'Switched the Art. 50(1) AI disclosure back on'
      });
      res.json({ success: true });
    } catch (error) {
      sendInternalError(res, error, 'remove disclosure opt-out');
    }
  });

  app.put(route('/apps/:appId/exemption'), adminAuth, async (req, res) => {
    const parsed = z
      .object({ type: z.enum(EXEMPTION_TYPES), justification: reasonSchema })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const stamp = stampOf(req);
      const record = {
        type: parsed.data.type,
        justification: parsed.data.justification,
        declaredBy: stamp.by,
        declaredByName: stamp.byName,
        declaredAt: stamp.at,
        installationUrl: stamp.installationUrl,
        installationId: stamp.installationId,
        ihubVersion: stamp.ihubVersion
      };
      const updated = await updateAppRecord(req.params.appId, appConfig => {
        appConfig.aiTransparency = { ...(appConfig.aiTransparency || {}), exemption: record };
      });
      if (!updated) return sendNotFound(res, 'App not found');
      logAudit({
        req,
        action: 'update',
        resource: 'app',
        resourceId: req.params.appId,
        summary: `Declared Art. 50(2) exemption "${record.type}": ${record.justification}`
      });
      res.json({ exemption: record });
    } catch (error) {
      sendInternalError(res, error, 'declare exemption');
    }
  });

  app.delete(route('/apps/:appId/exemption'), adminAuth, async (req, res) => {
    try {
      const updated = await updateAppRecord(req.params.appId, appConfig => {
        if (appConfig.aiTransparency) delete appConfig.aiTransparency.exemption;
      });
      if (!updated) return sendNotFound(res, 'App not found');
      logAudit({
        req,
        action: 'update',
        resource: 'app',
        resourceId: req.params.appId,
        summary: 'Withdrew the Art. 50(2) exemption'
      });
      res.json({ success: true });
    } catch (error) {
      sendInternalError(res, error, 'withdraw exemption');
    }
  });

  // ── Models: unmarked-model acknowledgement ─────────────────────────────

  app.put(route('/models/:modelId/acknowledgement'), adminAuth, async (req, res) => {
    const parsed = z
      .object({ justification: reasonSchema })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const record = buildAcknowledgement(req, parsed.data.justification);
      const updated = await updateModelRecord(req.params.modelId, model => {
        model.contentMarking = {
          ...(model.contentMarking || { textWatermark: 'none' }),
          acknowledgement: record
        };
      });
      if (!updated) return sendNotFound(res, 'Model not found');
      logAudit({
        req,
        action: 'update',
        resource: 'model',
        resourceId: req.params.modelId,
        summary: `Acknowledged unmarked model output: ${record.justification}`
      });
      res.json({ acknowledgement: record });
    } catch (error) {
      sendInternalError(res, error, 'record model acknowledgement');
    }
  });

  app.delete(route('/models/:modelId/acknowledgement'), adminAuth, async (req, res) => {
    try {
      const updated = await updateModelRecord(req.params.modelId, model => {
        if (model.contentMarking) delete model.contentMarking.acknowledgement;
      });
      if (!updated) return sendNotFound(res, 'Model not found');
      logAudit({
        req,
        action: 'update',
        resource: 'model',
        resourceId: req.params.modelId,
        summary: 'Withdrew the unmarked-model acknowledgement'
      });
      res.json({ success: true });
    } catch (error) {
      sendInternalError(res, error, 'withdraw model acknowledgement');
    }
  });

  // ── Certificates ───────────────────────────────────────────────────────

  app.get(route('/certificates'), adminAuth, async (_req, res) => {
    try {
      res.json(await signingService.status());
    } catch (error) {
      sendInternalError(res, error, 'read signing status');
    }
  });

  app.get(route('/certificates/trust-anchor.pem'), adminAuth, async (_req, res) => {
    try {
      const pem = await signingService.getPublishedAnchor();
      if (!pem) return sendNotFound(res, 'No signing certificate');
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', 'attachment; filename="ihub-trust-anchor.pem"');
      res.send(pem);
    } catch (error) {
      sendInternalError(res, error, 'export trust anchor');
    }
  });

  app.post(route('/certificates/rotate'), adminAuth, async (req, res) => {
    try {
      const result = await signingService.rotateAuto({ actor: actorOf(req).id });
      logAudit({
        req,
        action: 'create',
        resource: 'ai-signing-certificate',
        resourceId: result.certificate.id,
        summary: `Issued a new installation signing certificate (${result.certificate.subject}); the previous one is detect-only`
      });
      res.json(result);
    } catch (error) {
      sendServiceError(res, error, 'rotate signing certificate');
    }
  });

  app.post(route('/certificates/custom'), adminAuth, async (req, res) => {
    const body = req.body || {};
    try {
      const result = await signingService.installCustom(
        {
          chainPem: typeof body.chainPem === 'string' ? body.chainPem : undefined,
          keyPem: typeof body.keyPem === 'string' ? body.keyPem : undefined,
          pkcs12Base64: typeof body.pkcs12Base64 === 'string' ? body.pkcs12Base64 : undefined,
          password: typeof body.password === 'string' ? body.password : undefined
        },
        { actor: actorOf(req).id }
      );
      logAudit({
        req,
        action: 'import',
        resource: 'ai-signing-certificate',
        resourceId: result.certificate.id,
        summary: `Installed a custom signing certificate (${result.certificate.subject}, until ${result.certificate.notAfter})`
      });
      res.json(result);
    } catch (error) {
      logAudit({
        req,
        action: 'import',
        resource: 'ai-signing-certificate',
        resourceId: 'custom',
        result: 'failure',
        summary: `Custom signing certificate rejected: ${error.message}`
      });
      sendServiceError(res, error, 'install custom certificate');
    }
  });

  app.post(route('/certificates/csr'), adminAuth, async (req, res) => {
    const parsed = z
      .object({
        commonName: z.string().max(200).optional(),
        organization: z.string().max(200).optional(),
        email: z.string().email().optional().or(z.literal(''))
      })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const certificate = await signingService.createCsr(parsed.data, { actor: actorOf(req).id });
      logAudit({
        req,
        action: 'create',
        resource: 'ai-signing-certificate',
        resourceId: certificate.id,
        summary: `Generated a signing key and CSR (${certificate.subject})`
      });
      res.json({ certificate });
    } catch (error) {
      sendServiceError(res, error, 'create CSR');
    }
  });

  app.post(route('/certificates/:id/complete'), adminAuth, async (req, res) => {
    const chainPem = req.body?.chainPem;
    if (typeof chainPem !== 'string' || !chainPem.includes('BEGIN CERTIFICATE')) {
      return sendBadRequest(res, 'Paste the issued certificate (PEM), with its chain');
    }
    try {
      const result = await signingService.completeCsr(req.params.id, chainPem, {
        actor: actorOf(req).id
      });
      logAudit({
        req,
        action: 'import',
        resource: 'ai-signing-certificate',
        resourceId: req.params.id,
        summary: `Installed the certificate issued for the CSR (${result.certificate.subject})`
      });
      res.json(result);
    } catch (error) {
      sendServiceError(res, error, 'complete CSR');
    }
  });

  app.post(route('/certificates/:id/activate'), adminAuth, async (req, res) => {
    try {
      const certificate = await signingService.activate(req.params.id);
      logAudit({
        req,
        action: 'update',
        resource: 'ai-signing-certificate',
        resourceId: req.params.id,
        summary: `Switched back to signing certificate ${certificate.subject}`
      });
      res.json({ certificate });
    } catch (error) {
      sendServiceError(res, error, 'activate certificate');
    }
  });

  app.delete(route('/certificates/:id'), adminAuth, async (req, res) => {
    try {
      const removed = await signingService.removePending(req.params.id);
      if (!removed) return sendBadRequest(res, 'Only a pending certificate request can be removed');
      logAudit({
        req,
        action: 'delete',
        resource: 'ai-signing-certificate',
        resourceId: req.params.id,
        summary: 'Removed a pending certificate request'
      });
      res.json({ success: true });
    } catch (error) {
      sendServiceError(res, error, 'remove certificate request');
    }
  });

  // ── Text watermark key groups ──────────────────────────────────────────

  app.get(route('/key-groups'), adminAuth, async (_req, res) => {
    try {
      res.json({ keyGroups: await keyGroupService.list() });
    } catch (error) {
      sendInternalError(res, error, 'list key groups');
    }
  });

  app.post(route('/key-groups'), adminAuth, async (req, res) => {
    const parsed = z
      .object({
        id: z.string().regex(/^[a-z0-9._-]{1,64}$/),
        name: z.string().max(200).optional(),
        detectorUrl: z.string().url().optional().or(z.literal('')),
        contextWidth: z.number().int().min(1).max(64).optional()
      })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const group = await keyGroupService.create(parsed.data);
      logAudit({
        req,
        action: 'create',
        resource: 'ai-watermark-key-group',
        resourceId: group.id,
        summary: `Created watermark key group ${group.id}`
      });
      res.status(201).json({ keyGroup: group });
    } catch (error) {
      sendServiceError(res, error, 'create key group');
    }
  });

  app.put(route('/key-groups/:id'), adminAuth, async (req, res) => {
    const parsed = z
      .object({
        name: z.string().max(200).optional(),
        detectorUrl: z.string().url().optional().or(z.literal('')),
        contextWidth: z.number().int().min(1).max(64).optional()
      })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const group = await keyGroupService.update(req.params.id, parsed.data);
      logAudit({
        req,
        action: 'update',
        resource: 'ai-watermark-key-group',
        resourceId: group.id,
        summary: `Updated watermark key group ${group.id}`
      });
      res.json({ keyGroup: group });
    } catch (error) {
      sendServiceError(res, error, 'update key group');
    }
  });

  app.post(route('/key-groups/:id/rotate'), adminAuth, async (req, res) => {
    try {
      const group = await keyGroupService.rotate(req.params.id);
      logAudit({
        req,
        action: 'update',
        resource: 'ai-watermark-key-group',
        resourceId: group.id,
        summary: `Rotated watermark key group ${group.id} to version ${group.activeVersion}`
      });
      res.json({ keyGroup: group });
    } catch (error) {
      sendServiceError(res, error, 'rotate key group');
    }
  });

  app.delete(route('/key-groups/:id'), adminAuth, async (req, res) => {
    try {
      await keyGroupService.remove(req.params.id);
      logAudit({
        req,
        action: 'delete',
        resource: 'ai-watermark-key-group',
        resourceId: req.params.id,
        summary: `Deleted watermark key group ${req.params.id}`
      });
      res.json({ success: true });
    } catch (error) {
      sendServiceError(res, error, 'delete key group');
    }
  });

  /** Reveals the active key as the vLLM `--watermark-config`. Audited. */
  app.post(route('/key-groups/:id/vllm-config'), adminAuth, async (req, res) => {
    try {
      const config = await keyGroupService.vllmConfig(req.params.id);
      logAudit({
        req,
        action: 'export',
        resource: 'ai-watermark-key-group',
        resourceId: req.params.id,
        summary: `Revealed the vLLM watermark config of key group ${req.params.id} (version ${config.version})`
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(config);
    } catch (error) {
      sendServiceError(res, error, 'reveal vLLM config');
    }
  });

  app.post(route('/key-groups/export'), adminAuth, async (req, res) => {
    const parsed = z
      .object({ ids: z.array(z.string()).min(1), passphrase: z.string().min(12) })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success)
      return sendBadRequest(res, 'Select key groups and a passphrase of at least 12 characters');
    try {
      const bundle = await keyGroupService.exportBundle(parsed.data.ids, parsed.data.passphrase);
      logAudit({
        req,
        action: 'export',
        resource: 'ai-watermark-key-group',
        resourceId: parsed.data.ids.join(','),
        summary: `Exported an encrypted key bundle (${parsed.data.ids.join(', ')})`
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(bundle);
    } catch (error) {
      sendServiceError(res, error, 'export key bundle');
    }
  });

  app.post(route('/key-groups/import'), adminAuth, async (req, res) => {
    const { bundle, passphrase } = req.body || {};
    try {
      const imported = await keyGroupService.importBundle(bundle, passphrase);
      logAudit({
        req,
        action: 'import',
        resource: 'ai-watermark-key-group',
        resourceId: imported.map(g => g.id).join(','),
        summary: `Imported watermark key groups: ${imported.map(g => g.id).join(', ') || 'none'}`
      });
      res.json({ keyGroups: imported });
    } catch (error) {
      logAudit({
        req,
        action: 'import',
        resource: 'ai-watermark-key-group',
        resourceId: 'bundle',
        result: 'failure',
        summary: `Key bundle import failed: ${error.message}`
      });
      sendServiceError(res, error, 'import key bundle');
    }
  });

  // ── Detection administration ───────────────────────────────────────────

  app.get(route('/detection/log'), adminAuth, async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      res.json({ entries: await detectionLog.list({ limit }) });
    } catch (error) {
      sendInternalError(res, error, 'read detection log');
    }
  });

  app.post(route('/detection/experts'), adminAuth, async (req, res) => {
    const parsed = z
      .object({
        userId: z.string().min(1).max(200),
        name: z.string().max(200).optional(),
        reason: reasonSchema
      })
      .strict()
      .safeParse(req.body || {});
    if (!parsed.success) return sendBadRequest(res, parsed.error.issues[0].message);
    try {
      const stamp = stampOf(req);
      const expert = {
        userId: parsed.data.userId,
        name: parsed.data.name || parsed.data.userId,
        reason: parsed.data.reason,
        approvedBy: stamp.by,
        approvedByName: stamp.byName,
        approvedAt: stamp.at,
        installationId: stamp.installationId
      };
      const platform = await readPlatform();
      const section = platform.aiTransparency || {};
      section.detection = { ...(section.detection || {}) };
      section.detection.experts = [
        ...(section.detection.experts || []).filter(e => e.userId !== expert.userId),
        expert
      ];
      platform.aiTransparency = section;
      await writePlatform(platform);
      logAudit({
        req,
        action: 'create',
        resource: 'ai-detection-expert',
        resourceId: expert.userId,
        summary: `Approved text-watermark detection access for ${expert.name}: ${expert.reason}`
      });
      res.json({ expert });
    } catch (error) {
      sendInternalError(res, error, 'approve detection expert');
    }
  });

  app.delete(route('/detection/experts/:userId'), adminAuth, async (req, res) => {
    try {
      const platform = await readPlatform();
      const section = platform.aiTransparency || {};
      const experts = section.detection?.experts || [];
      const next = experts.filter(e => e.userId !== req.params.userId);
      if (next.length === experts.length) return sendNotFound(res, 'No such expert');
      section.detection = { ...(section.detection || {}), experts: next };
      platform.aiTransparency = section;
      await writePlatform(platform);
      logAudit({
        req,
        action: 'delete',
        resource: 'ai-detection-expert',
        resourceId: req.params.userId,
        summary: `Revoked text-watermark detection access for ${req.params.userId}`
      });
      res.json({ success: true });
    } catch (error) {
      sendInternalError(res, error, 'revoke detection expert');
    }
  });

  // ── Robustness benchmark / self-test ───────────────────────────────────

  app.get(route('/benchmark'), adminAuth, async (_req, res) => {
    try {
      res.json({ report: await latestBenchmark() });
    } catch (error) {
      sendInternalError(res, error, 'read benchmark report');
    }
  });

  app.post(route('/benchmark'), adminAuth, async (req, res) => {
    try {
      const quick = req.body?.quick !== false;
      const report = await runMarkingBenchmark({ quick, trigger: 'admin' });
      logAudit({
        req,
        action: 'create',
        resource: 'ai-marking-benchmark',
        resourceId: report.id,
        summary: `Ran the marking ${quick ? 'self-test' : 'benchmark'}: ${report.summary.passed}/${report.summary.total} passed`
      });
      res.json({ report });
    } catch (error) {
      sendInternalError(res, error, 'run marking benchmark');
    }
  });

  // ── Compliance report ──────────────────────────────────────────────────

  app.get(route('/report.pdf'), adminAuth, async (req, res) => {
    try {
      const { buffer, filename } = await buildComplianceReport({ req });
      logAudit({
        req,
        action: 'export',
        resource: 'ai-compliance-report',
        resourceId: filename,
        summary: 'Exported the signed EU AI Act compliance report'
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (error) {
      sendInternalError(res, error, 'build compliance report');
    }
  });
}
