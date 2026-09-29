/**
 * Conformance status of this installation (concept §8.6, issue #2566).
 *
 * Produces the EU AI Act page's checklist, the model compliance matrix, the
 * app list and the start-page warnings. Dismissing a warning needs a
 * justification; it hides the warning from the banner but never changes the
 * checklist, and it only holds for the state it was made for (`stateHash`):
 * enable another unmarked model and the warning is back.
 *
 * Only model, certificate and app (temperature 0) warnings are dismissible.
 * "Signing disabled" and "no detection available" are not.
 *
 * @module services/provenance/ComplianceService
 */
import crypto from 'node:crypto';
import configCache from '../../configCache.js';
import {
  DISMISSIBLE_WARNING_PREFIXES,
  isImageModel,
  normalizeContentMarking
} from '../../../shared/aiTransparency.js';
import { getAiTransparencyConfig, isAiTransparencyActive } from './config.js';
import { getInstallationInfo, isRecordForThisInstallation } from './installation.js';
import { validAcknowledgement, validDisclosureOptOut, validExemption } from './markingPolicy.js';
import signingService from './signing/SigningService.js';
import keyGroupService from './watermark/KeyGroupService.js';
import { imageMarkerStatus } from './image/ImageMarker.js';

const CERT_WARN_DAYS = 30;

function stateHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function isDismissibleWarning(id) {
  return DISMISSIBLE_WARNING_PREFIXES.some(prefix => String(id).startsWith(prefix));
}

function textStatusOf(marking) {
  switch (marking.text.kind) {
    case 'scheme':
      return 'marked-vllm';
    case 'upstream':
      return 'marked-upstream';
    case 'not-applicable':
      return 'not-applicable';
    default:
      return 'not-marked';
  }
}

/**
 * One row of the model compliance matrix.
 */
function evaluateModel(model, { cfg, imageLayers, keyGroupIds }) {
  const marking = normalizeContentMarking(model);
  const issues = [];
  const text = { ...marking.text, status: textStatusOf(marking) };
  if (text.status === 'not-marked') issues.push('text-unmarked');
  if (marking.text.kind === 'scheme' && !keyGroupIds.has(marking.text.keyGroup)) {
    text.keyGroupMissing = true;
    issues.push('key-group-missing');
  }
  let image = null;
  if (isImageModel(model)) {
    const c2pa = cfg.images.c2pa && imageLayers.c2pa;
    const watermark = cfg.images.watermark === 'trustmark' && imageLayers.watermark;
    image = {
      c2pa,
      watermark,
      upstream: marking.image.kind === 'upstream' ? marking.image.vendor : null,
      status: c2pa && watermark ? 'marked' : c2pa || watermark ? 'partial' : 'not-marked'
    };
    if (image.status !== 'marked') issues.push('image-unmarked');
  }
  const acknowledgement = validAcknowledgement(model);
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    enabled: model.enabled !== false,
    modelType: model.modelType || 'chat',
    text,
    image,
    notes: marking.notes,
    acknowledgement,
    // An acknowledged unmarked model stays non-conforming (CoP 1.1.2).
    conforming: issues.length === 0,
    issues
  };
}

function appModelIds(app, models) {
  const ids = new Set();
  if (app.preferredModel) ids.add(app.preferredModel);
  for (const id of app.allowedModels || []) ids.add(id);
  if (ids.size === 0) for (const m of models) if (m.enabled !== false && m.default) ids.add(m.id);
  return ids;
}

function evaluateApp(app, { cfg, models }) {
  const optOut = validDisclosureOptOut(app);
  const exemption = validExemption(app);
  const issues = [];
  const modelIds = appModelIds(app, models);
  const watermarkingModels = models.filter(
    m => modelIds.has(m.id) && normalizeContentMarking(m).text.kind === 'scheme'
  );
  const temperatureZero =
    app.preferredTemperature === 0 && watermarkingModels.length > 0 && !exemption;
  if (temperatureZero) issues.push('temperature-zero');
  return {
    id: app.id,
    name: app.name,
    enabled: app.enabled !== false,
    disclosure: cfg.interactionDisclosure.enabled && !optOut ? 'on' : 'off',
    optOut,
    exemption,
    sensitive: app.aiTransparency?.sensitive || null,
    preferredTemperature: app.preferredTemperature ?? null,
    temperatureZero,
    foreignRecords: Boolean(
      (app.aiTransparency?.disclosureOptOut && !optOut) ||
        (app.aiTransparency?.exemption && !exemption)
    ),
    issues
  };
}

function item(id, status, detail, fix, extra = {}) {
  return { id, status, detail, fix, ...extra };
}

/**
 * Evaluate the installation.
 * @param {{req?: import('express').Request}} [opts]
 */
export async function evaluateCompliance({ req } = {}) {
  const cfg = getAiTransparencyConfig();
  const featureActive = isAiTransparencyActive();
  const installation = getInstallationInfo(req);
  const allModels = configCache.getModels(true)?.data || [];
  const allApps = configCache.getApps(true)?.data || [];
  const signing = await signingService.status();
  const keyGroups = await keyGroupService.list();
  const keyGroupIds = new Set(keyGroups.map(g => g.id));
  const imageStatus = await imageMarkerStatus();
  const signingUsable = signing.enabled && signing.c2paAvailable && Boolean(signing.active);
  const imageLayers = { c2pa: signingUsable, watermark: imageStatus.watermarkAvailable };

  const models = allModels.map(m => evaluateModel(m, { cfg, imageLayers, keyGroupIds }));
  const apps = allApps.map(a => evaluateApp(a, { cfg, models: allModels }));
  const enabledModels = models.filter(m => m.enabled);
  const enabledChatModels = enabledModels.filter(m => m.modelType !== 'transcription');
  const unmarkedModels = enabledChatModels.filter(m => m.issues.includes('text-unmarked'));
  const enabledImageModels = enabledModels.filter(m => m.image);

  const warnings = [];
  const warn = (id, severity, message, state, params = {}) =>
    warnings.push({
      id,
      severity,
      message,
      params,
      stateHash: stateHash(state),
      dismissible: isDismissibleWarning(id)
    });

  const checklist = [];

  // Feature flag
  checklist.push(
    item(
      'feature',
      featureActive ? 'ok' : 'error',
      featureActive ? 'AI transparency features are on' : 'The aiTransparency feature is switched off',
      '/admin/features'
    )
  );
  if (!featureActive) warn('feature:disabled', 'error', 'AI transparency features are switched off', false);

  // 50(1) disclosure
  const optOuts = apps.filter(a => a.optOut);
  checklist.push(
    item(
      'disclosure',
      cfg.interactionDisclosure.enabled ? 'ok' : 'error',
      cfg.interactionDisclosure.enabled
        ? optOuts.length
          ? `On for all apps except ${optOuts.length} documented opt-out(s)`
          : 'On for all apps'
        : 'The interaction disclosure is switched off for all apps',
      '/admin/eu-ai-act?tab=settings',
      { count: optOuts.length }
    )
  );
  if (!cfg.interactionDisclosure.enabled) {
    warn('disclosure:disabled', 'error', 'The Art. 50(1) interaction disclosure is switched off', false);
  }

  // Signing certificate
  let signingStatus = 'ok';
  let signingDetail = '';
  if (!signing.enabled) {
    signingStatus = 'error';
    signingDetail = 'Signing is disabled';
    warn('signing:disabled', 'error', 'Signing is disabled: generated content carries no signed metadata', false);
  } else if (!signing.c2paAvailable) {
    signingStatus = 'error';
    signingDetail = 'The C2PA library is not available on this platform';
    warn('signing:unavailable', 'error', 'C2PA signing is not available on this platform', false);
  } else if (!signing.active) {
    signingStatus = 'error';
    signingDetail = 'No signing certificate';
    warn('certificate:missing', 'error', 'There is no signing certificate', false);
  } else if (signing.active.expired) {
    signingStatus = 'error';
    signingDetail = `The signing certificate expired on ${signing.active.notAfter}`;
    warn('certificate:expired', 'error', 'The signing certificate has expired', signing.active.fingerprint);
  } else if (signing.active.expiresInDays < CERT_WARN_DAYS) {
    signingStatus = 'warning';
    signingDetail = `The signing certificate expires in ${signing.active.expiresInDays} days`;
    warn(
      'certificate:expiring',
      'warning',
      `The signing certificate expires in ${signing.active.expiresInDays} days`,
      signing.active.fingerprint,
      { days: signing.active.expiresInDays }
    );
  } else {
    signingDetail = `${signing.active.source} certificate, valid until ${signing.active.notAfter.slice(0, 10)}`;
  }
  checklist.push(
    item('signing', signingStatus, signingDetail, '/admin/eu-ai-act?tab=certificates', {
      timestamping: signing.timestamping
    })
  );

  // Image marking
  let imageItemStatus = 'ok';
  const imageProblems = [];
  if (!cfg.images.c2pa) imageProblems.push('C2PA manifests are switched off');
  else if (!signingUsable) imageProblems.push('C2PA manifests cannot be signed');
  if (cfg.images.watermark !== 'trustmark') imageProblems.push('the invisible watermark is switched off');
  else if (!imageStatus.watermarkAvailable) {
    imageProblems.push(`the TrustMark watermark is unavailable (${imageStatus.watermarkError || 'models missing'})`);
  }
  if (imageProblems.length) imageItemStatus = enabledImageModels.length ? 'error' : 'warning';
  checklist.push(
    item(
      'imageMarking',
      imageItemStatus,
      imageProblems.length
        ? `Images: ${imageProblems.join('; ')}`
        : 'Generated images get a signed C2PA manifest and a TrustMark watermark',
      '/admin/eu-ai-act?tab=settings',
      { imageModels: enabledImageModels.length }
    )
  );
  if (imageProblems.length && enabledImageModels.length) {
    warn('images:unmarked', 'error', `Generated images are not fully marked: ${imageProblems.join('; ')}`, false);
  }

  // Server-side exports
  const exportsOk = cfg.exports.sign && signingUsable;
  checklist.push(
    item(
      'exports',
      exportsOk ? 'ok' : 'error',
      exportsOk
        ? 'Exports are generated on the server with signed metadata and a visible label'
        : cfg.exports.sign
          ? 'Exports cannot be signed (signing unavailable)'
          : 'Export signing is switched off',
      '/admin/eu-ai-act?tab=settings'
    )
  );

  // Detection
  checklist.push(
    item(
      'detection',
      cfg.detection.enabled ? 'ok' : 'error',
      cfg.detection.enabled
        ? `/verify is available (${cfg.detection.access} access)`
        : 'No detection available',
      '/admin/eu-ai-act?tab=detection',
      { access: cfg.detection.access }
    )
  );
  if (!cfg.detection.enabled) {
    warn('detection:disabled', 'error', 'No detection is available (/verify is switched off)', false);
  }

  // Text watermarking per model
  const missingGroups = enabledChatModels.filter(m => m.text.keyGroupMissing);
  checklist.push(
    item(
      'textWatermarking',
      unmarkedModels.length || missingGroups.length ? 'error' : 'ok',
      unmarkedModels.length
        ? `${unmarkedModels.length} enabled model(s) do not mark free-form text over ${cfg.text.watermarkMinTokens} tokens`
        : missingGroups.length
          ? `${missingGroups.length} model(s) refer to a missing key group`
          : 'Every enabled model marks free-form text',
      '/admin/eu-ai-act?tab=models',
      { unmarked: unmarkedModels.map(m => m.id) }
    )
  );
  for (const m of unmarkedModels) {
    warn(
      `model:${m.id}:unmarked`,
      'error',
      `Model "${m.id}" does not mark free-form text`,
      { id: m.id, text: m.text, enabled: m.enabled },
      { modelId: m.id }
    );
  }
  for (const m of missingGroups) {
    warn(
      `model:${m.id}:key-group`,
      'error',
      `Model "${m.id}" refers to key group "${m.text.keyGroup}", which does not exist`,
      { id: m.id, keyGroup: m.text.keyGroup },
      { modelId: m.id, keyGroup: m.text.keyGroup }
    );
  }
  for (const a of apps.filter(x => x.enabled && x.temperatureZero)) {
    warn(
      `app:${a.id}:temperature-zero`,
      'error',
      `App "${a.id}" runs a watermarking model at temperature 0, which embeds no watermark`,
      { id: a.id, t: a.preferredTemperature },
      { appId: a.id }
    );
  }

  // Signpost
  checklist.push(
    item(
      'signpost',
      'ok',
      `Text signpost: ${cfg.text.signpost.exports ? 'on' : 'off'} for text exports, ${cfg.text.signpost.clipboard ? 'on' : 'off'} for clipboard`,
      '/admin/eu-ai-act?tab=settings'
    )
  );

  // Provider details
  const providerOk = Boolean(cfg.provider.legalEntity && cfg.provider.contact);
  checklist.push(
    item(
      'provider',
      providerOk ? 'ok' : 'error',
      providerOk ? `${cfg.provider.legalEntity} (${cfg.provider.role})` : 'Provider legal entity and contact are missing',
      '/admin/eu-ai-act?tab=settings'
    )
  );
  if (!providerOk) warn('provider:missing', 'error', 'Provider details (legal entity, contact) are missing', false);

  // Editorial responsibility (50(4) deployers)
  const editorialOk = Boolean(cfg.editorialResponsibility.contact);
  checklist.push(
    item(
      'editorial',
      editorialOk ? 'ok' : 'warning',
      editorialOk ? cfg.editorialResponsibility.contact : 'No editorial-responsibility contact recorded',
      '/admin/eu-ai-act?tab=settings'
    )
  );

  // Terms of service
  checklist.push(
    item(
      'termsOfService',
      cfg.termsOfService.markRemovalClause ? 'ok' : 'error',
      cfg.termsOfService.markRemovalClause
        ? 'The terms of service prohibit removing AI markings'
        : 'The terms of service do not (yet) prohibit removing AI markings',
      '/admin/eu-ai-act?tab=settings'
    )
  );
  if (!cfg.termsOfService.markRemovalClause) {
    warn('tos:missing', 'error', 'The terms of service lack the clause prohibiting removal of AI markings', false);
  }

  // Provenance records
  checklist.push(
    item(
      'provenanceRecords',
      cfg.provenance.enabled ? 'ok' : 'warning',
      cfg.provenance.enabled
        ? `Kept ${cfg.provenance.retentionDays > 0 ? `for ${cfg.provenance.retentionDays} days` : 'until deleted'}`
        : 'Provenance records are off: exports of unstored chats cannot be verified',
      '/admin/eu-ai-act?tab=settings'
    )
  );

  // Dismissals
  const dismissals = (cfg.dismissals || []).filter(isRecordForThisInstallation);
  for (const w of warnings) {
    const match = dismissals.find(d => d.warningId === w.id && d.stateHash === w.stateHash);
    w.dismissal = w.dismissible && match ? match : null;
  }

  const conforming = checklist.every(c => c.status !== 'error');
  return {
    generatedAt: new Date().toISOString(),
    installation,
    featureActive,
    conforming,
    checklist,
    models,
    apps,
    warnings,
    activeWarnings: warnings.filter(w => !w.dismissal),
    records: {
      optOuts: apps.filter(a => a.optOut).map(a => ({ appId: a.id, ...a.optOut })),
      exemptions: apps.filter(a => a.exemption).map(a => ({ appId: a.id, ...a.exemption })),
      acknowledgements: models
        .filter(m => m.acknowledgement)
        .map(m => ({ modelId: m.id, ...m.acknowledgement })),
      dismissals
    },
    signing,
    keyGroups,
    images: imageStatus,
    settings: {
      detection: { enabled: cfg.detection.enabled, access: cfg.detection.access },
      signpost: cfg.text.signpost,
      strictMode: cfg.text.strictMode
    }
  };
}
