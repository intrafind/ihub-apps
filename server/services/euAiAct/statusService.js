// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The status of the EU AI Act overview page (#3329): the checks, a row per
 * model and the counters. Reads only; never a secret (no key, no token: only
 * whether one is set), never a generation.
 *
 * Mapping of the sibling APIs this reads (what was really built wins over the
 * brief's R1-R15):
 * - guardrail: on unless the EU AI Act master switch is off (`provenance/guardrail.js` has no other switch)
 * - notice: `platform.aiDisclosure.firstTurnNotice.enabled`
 * - acknowledgements: `aiAcknowledgementService.summary()`
 * - provenance: `provenanceSettings()`
 * - key: `getActiveKeyId()` (id snapshot, no key material)
 * - detector: `detectorConfigOf` + `checkDetectorUrl` + `probeDetector`
 *   (`pingDetector` of #3331, through `httpFetch`)
 * - self-test: the last stored result of `POST /api/admin/eu-ai-act/watermark-detectors/{id}/_self-test`
 *
 * @module services/euAiAct/statusService
 */
import configCache from '../../configCache.js';
import { getConformity } from './conformity.js';
import { summary as acknowledgementSummary } from '../aiAcknowledgement/aiAcknowledgementService.js';
import { provenanceSettings } from '../provenance/provenanceSettings.js';
import { getActiveKeyId } from '../provenance/watermark/activeKeySnapshot.js';
import { detectorConfigOf } from '../provenance/watermark/detect.js';
import { checkDetectorUrl } from '../provenance/watermark/detectorUrlPolicy.js';
import { LEVEL, kindsOf, markingOf, modelChecks, platformChecks, worstLevel } from './checks.js';
import { probeDetectors } from './detectorProbe.js';
import { readSelfTests, selfTestSummary } from './selfTestStore.js';

function localizedName(model) {
  const name = model.name;
  if (name && typeof name === 'object') return name;
  return { en: name || model.id };
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.refresh] - Re-probe the detectors now
 * @param {Object} [options.deps] - Test seams
 * @returns {Promise<Object>} The status document
 */
export async function buildStatus({ refresh = false, deps = {} } = {}) {
  const platform = deps.platform || configCache.getPlatform() || {};
  const allModels = (deps.models || configCache.getModels(true)?.data || []).filter(
    model => model && model.id
  );
  const enabled = allModels.filter(model => model.enabled !== false);
  const skippedDisabled = allModels.length - enabled.length;
  const activeKeyId = deps.activeKeyId !== undefined ? deps.activeKeyId : getActiveKeyId() || null;
  const acknowledgements = (deps.acknowledgementSummary || acknowledgementSummary)({ platform });
  const provenance = provenanceSettings(platform);
  const conformity = deps.conformity || getConformity();
  const acknowledgementsView = {
    enabled: acknowledgements.enabled,
    configuredEnabled: acknowledgements.configuredEnabled ?? acknowledgements.enabled,
    enforced: acknowledgements.enforce,
    requiredVersion: acknowledgements.requiredVersion,
    counts: {
      acknowledged: acknowledgements.acknowledged,
      pending: acknowledgements.pending,
      total: acknowledgements.total
    }
  };
  const provenanceView = {
    storeRecords: provenance.storeRecords,
    retentionDays: provenance.retentionDays,
    verifyAccess: provenance.verify.access,
    media: { maxVerifyBytes: provenance.media.maxVerifyBytes }
  };
  // EU AI Act master switch off: nothing is evaluated and no detector is probed (an
  // outbound connection that only serves the measure). The page shows the record.
  if (!conformity.enabled) {
    return {
      generatedAt: new Date().toISOString(),
      conformity,
      summary: {
        level: 'disabled',
        counts: { ok: 0, warn: 0, error: 0 },
        skippedDisabledModels: 0
      },
      checks: [],
      models: [],
      acknowledgements: { ...acknowledgementsView, enabled: false },
      provenance: provenanceView
    };
  }
  const selfTests = deps.selfTests || (await readSelfTests());

  const ihubModels = enabled.filter(model => markingOf(model, 'text').by === 'ihub');
  const probeable = ihubModels.filter(model => {
    const config = detectorConfigOf(model);
    return config?.detectorUrl && config?.credentialRef;
  });
  const urlPolicy = new Map();
  await Promise.all(
    probeable.map(async model => {
      const url = model.contentMarking.text.detectorUrl;
      urlPolicy.set(model.id, await (deps.checkUrl || checkDetectorUrl)(url));
    })
  );
  // A refused URL is never called.
  const allowed = probeable.filter(model => urlPolicy.get(model.id)?.ok !== false);
  const probes = await (deps.probe || probeDetectors)(allowed, { refresh });

  const checks = platformChecks({ platform, acknowledgements, provenance });
  const models = [];
  for (const model of enabled) {
    const selfTest = selfTestSummary(selfTests[model.id], activeKeyId);
    const probe = probes.get(model.id);
    checks.push(
      ...modelChecks(model, { activeKeyId, probe, urlPolicy: urlPolicy.get(model.id), selfTest })
    );
    const kinds = kindsOf(model);
    if (kinds.length === 0) continue;
    const text = markingOf(model, 'text');
    models.push({
      modelId: model.id,
      name: localizedName(model),
      marking: Object.fromEntries(
        kinds.map(kind => {
          const marking = markingOf(model, kind);
          return [
            kind,
            {
              by: marking.by,
              scheme: marking.scheme || null,
              hasStatement: Boolean(marking.statementRef)
            }
          ];
        })
      ),
      detector:
        text.by === 'ihub'
          ? {
              configured: Boolean(text.detectorUrl && text.detectorCredentialRef),
              hasCredential: Boolean(text.detectorCredentialRef),
              urlOk: urlPolicy.get(model.id)?.ok !== false,
              reachable: probe
                ? probe.reachable && probe.authenticated && probe.contractValid
                : null,
              latencyMs: probe?.latencyMs ?? null,
              checkedAt: probe?.checkedAt ?? null
            }
          : null,
      activeKeyId: text.by === 'ihub' ? activeKeyId : null,
      selfTest: text.by === 'ihub' ? selfTest : null
    });
  }

  const counts = { ok: 0, warn: 0, error: 0 };
  for (const item of checks) counts[item.level] += 1;
  return {
    generatedAt: new Date().toISOString(),
    conformity,
    summary: {
      level: worstLevel(checks.map(item => item.level)),
      counts,
      skippedDisabledModels: skippedDisabled
    },
    checks,
    models,
    acknowledgements: acknowledgementsView,
    provenance: provenanceView
  };
}

export { LEVEL };
