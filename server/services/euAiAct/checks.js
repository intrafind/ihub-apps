// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The checks of the EU AI Act overview page (#3329), as pure functions of a
 * plain context so each is testable without config files or a network.
 *
 * The server decides what a state means and how it is labelled; the client
 * only renders `level`, `messageKey` (+ `params`) and the English `message`
 * fallback. "ok" means "configured as designed", not "legally compliant".
 *
 * Levels: `ok` < `warn` < `error`. Only the watermark chain of a model marked
 * "ihub" can be an `error` (we would claim a mark we do not deliver); a missing
 * hint, a missing statement or an optional feature that is off is a `warn`.
 *
 * @module services/euAiAct/checks
 */
import { SELF_TEST_STATE } from './selfTestStore.js';

export const LEVEL = Object.freeze({ OK: 'ok', WARN: 'warn', ERROR: 'error' });
const RANK = { ok: 0, warn: 1, error: 2 };

const KEY = 'admin.euAiAct.checks';
const FIX = 'admin.euAiAct.fix';

/** Worst level of a list (ok for an empty list). */
export function worstLevel(levels) {
  return levels.reduce((worst, level) => (RANK[level] > RANK[worst] ? level : worst), LEVEL.OK);
}

function check(id, level, messageKey, message, extra = {}) {
  const { scope = 'platform', modelId, params = {}, fix = null } = extra;
  const result = { id, scope, level, messageKey: `${KEY}.${messageKey}`, message, params, fix };
  if (modelId) result.modelId = modelId;
  return result;
}

const fixModel = modelId => ({
  href: `/admin/models/${encodeURIComponent(modelId)}`,
  labelKey: `${FIX}.openModel`
});
const FIX_ADVANCED = { href: '/admin/advanced', labelKey: `${FIX}.openAdvanced` };
const FIX_KEYS = { href: '/admin/eu-ai-act#watermark-keys', labelKey: `${FIX}.openKeys` };

/** The marking of a model for one kind, normalised. */
export function markingOf(model, kind) {
  const marking = model?.contentMarking?.[kind];
  return marking && ['none', 'provider', 'ihub'].includes(marking.by) ? marking : { by: 'none' };
}

/** Which marking kinds apply to a model (what it can generate). */
export function kindsOf(model) {
  // Read-aloud audio is neither recorded nor marked by iHub, so there is nothing to check.
  if (model.modelType === 'transcription' || model.modelType === 'tts') return [];
  const kinds = ['text'];
  if (model.supportsImageGeneration) kinds.push('image');
  return kinds;
}

/**
 * Platform-level checks.
 *
 * @param {Object} ctx
 * @param {Object} ctx.platform
 * @param {{enabled: boolean, enforce: boolean, requiredVersion: number}} ctx.acknowledgements
 * @param {{storeRecords: boolean, retentionDays: number}} ctx.provenance
 */
export function platformChecks({ platform, acknowledgements, provenance }) {
  const out = [];
  out.push(
    check(
      'guardrail.active',
      LEVEL.OK,
      'guardrail.ok',
      'The AI disclosure rule is part of every system prompt and cannot be switched off.'
    )
  );

  const noticeOn = platform?.aiDisclosure?.firstTurnNotice?.enabled !== false;
  out.push(
    noticeOn
      ? check('notice.enabled', LEVEL.OK, 'notice.ok', 'The first-message notice is on.', {
          fix: FIX_ADVANCED
        })
      : check('notice.enabled', LEVEL.WARN, 'notice.off', 'The first-message notice is off.', {
          fix: FIX_ADVANCED
        })
  );

  if (!acknowledgements.enabled) {
    out.push(
      check(
        'ack.enabled',
        LEVEL.WARN,
        'ack.off',
        'The AI-use acknowledgement is off. It is optional, but it is the evidence that people were told.',
        { fix: FIX_ADVANCED }
      )
    );
  } else {
    out.push(
      check(
        'ack.enabled',
        LEVEL.OK,
        'ack.on',
        'The AI-use acknowledgement is on (version {{requiredVersion}}).',
        {
          params: { requiredVersion: acknowledgements.requiredVersion }
        }
      )
    );
    out.push(
      acknowledgements.enforce
        ? check(
            'ack.enforcement',
            LEVEL.OK,
            'ack.enforced',
            'Messages without a confirmation are refused.'
          )
        : check(
            'ack.enforcement',
            LEVEL.WARN,
            'ack.notEnforced',
            'Enforcement is off: users are asked, but not blocked.',
            { fix: FIX_ADVANCED }
          )
    );
  }

  if (provenance.storeRecords === false) {
    out.push(
      check(
        'provenance.records',
        LEVEL.WARN,
        'provenance.recordsOff',
        'Provenance records are not stored, so "did this exact output come from here?" cannot be answered.'
      )
    );
  } else if (provenance.retentionDays > 0) {
    out.push(
      check(
        'provenance.records',
        LEVEL.OK,
        'provenance.retention',
        'Provenance records are kept {{days}} days.',
        { params: { days: provenance.retentionDays } }
      )
    );
  } else {
    out.push(
      check(
        'provenance.records',
        LEVEL.OK,
        'provenance.retentionForever',
        'Provenance records are kept without a time limit.'
      )
    );
  }
  return out;
}

function nameOf(model) {
  const name = model.name;
  if (name && typeof name === 'object') return name.en || Object.values(name)[0] || model.id;
  return name || model.id;
}

/**
 * The checks of one enabled model.
 *
 * @param {Object} model
 * @param {Object} ctx
 * @param {string|null} ctx.activeKeyId
 * @param {Object|undefined} ctx.probe - Result of the detector probe
 * @param {{ok: boolean, reason?: string}|undefined} ctx.urlPolicy
 * @param {{state: string}} ctx.selfTest - See `selfTestSummary`
 */
export function modelChecks(model, { activeKeyId, probe, urlPolicy, selfTest }) {
  const out = [];
  const modelId = model.id;
  const params = { model: nameOf(model), modelId };
  const base = { scope: 'model', modelId, fix: fixModel(modelId) };

  for (const kind of kindsOf(model)) {
    const marking = markingOf(model, kind);
    const id = `model.marking.${kind}`;
    const p = { ...params, kind };
    if (marking.by === 'ihub') {
      out.push(
        check(id, LEVEL.OK, 'model.markedByIhub', '{{model}}: marked by iHub.', {
          ...base,
          params: p
        })
      );
    } else if (marking.by === 'provider') {
      out.push(
        marking.statementRef
          ? check(
              id,
              LEVEL.OK,
              'model.markedByProvider',
              '{{model}} ({{kind}}): the provider marks the output; statement on file.',
              { ...base, params: p }
            )
          : check(
              id,
              LEVEL.WARN,
              'model.statementMissing',
              '{{model}} ({{kind}}): marked by the provider, but no statement is referenced.',
              { ...base, params: p }
            )
      );
    } else {
      out.push(
        check(
          id,
          LEVEL.WARN,
          'model.notMarked',
          '{{model}} ({{kind}}): output is not marked. This is a hint, nothing is blocked.',
          { ...base, params: p }
        )
      );
    }
  }

  if (markingOf(model, 'text').by !== 'ihub') return out;

  // The watermark chain: key, detector, self-test. Errors: we must not claim marking we do not deliver.
  out.push(
    activeKeyId
      ? check(
          'model.watermark.key',
          LEVEL.OK,
          'watermark.keyOk',
          '{{model}}: active key {{keyId}}.',
          {
            ...base,
            fix: null,
            params: { ...params, keyId: activeKeyId }
          }
        )
      : check(
          'model.watermark.key',
          LEVEL.ERROR,
          'watermark.noKey',
          '{{model}}: no active watermark key. Output is not marked.',
          {
            ...base,
            fix: FIX_KEYS,
            params
          }
        )
  );

  const marking = model.contentMarking.text;
  const detectorId = 'model.watermark.detector';
  if (!marking.detectorUrl || !marking.detectorCredentialRef) {
    out.push(
      check(
        detectorId,
        LEVEL.ERROR,
        'watermark.detectorMissing',
        '{{model}}: detector URL or credential is not set.',
        { ...base, params }
      )
    );
  } else if (urlPolicy && urlPolicy.ok === false) {
    out.push(
      check(
        detectorId,
        LEVEL.ERROR,
        'watermark.detectorUrlRefused',
        '{{model}}: the detector URL is not allowed: {{reason}}',
        {
          ...base,
          params: { ...params, reason: urlPolicy.reason }
        }
      )
    );
  } else if (!probe || probe.error === 'not_configured') {
    out.push(
      check(
        detectorId,
        LEVEL.ERROR,
        'watermark.detectorMissing',
        '{{model}}: detector URL or credential is not set.',
        { ...base, params }
      )
    );
  } else if (!probe.reachable) {
    out.push(
      check(
        detectorId,
        LEVEL.ERROR,
        'watermark.detectorUnreachable',
        '{{model}}: the detector did not answer ({{reason}}).',
        {
          ...base,
          params: { ...params, reason: probe.error || 'network', checkedAt: probe.checkedAt }
        }
      )
    );
  } else if (!probe.authenticated) {
    out.push(
      check(
        detectorId,
        LEVEL.ERROR,
        'watermark.detectorUnauthorized',
        '{{model}}: the detector rejected the credential.',
        { ...base, params }
      )
    );
  } else if (!probe.contractValid) {
    out.push(
      check(
        detectorId,
        LEVEL.ERROR,
        'watermark.detectorContract',
        '{{model}}: the detector answered, but not in the expected format.',
        { ...base, params }
      )
    );
  } else {
    out.push(
      check(
        detectorId,
        LEVEL.OK,
        'watermark.detectorOk',
        '{{model}}: the detector answered in {{latencyMs}} ms.',
        {
          ...base,
          fix: null,
          params: { ...params, latencyMs: probe.latencyMs, checkedAt: probe.checkedAt }
        }
      )
    );
  }

  const stId = 'model.watermark.selftest';
  const stFix = { href: '/admin/eu-ai-act#watermark-keys', labelKey: `${FIX}.runSelfTest` };
  const stBase = { ...base, fix: stFix, params };
  switch (selfTest?.state) {
    case SELF_TEST_STATE.PASSED:
      out.push(
        check(
          stId,
          LEVEL.OK,
          'watermark.selfTestPassed',
          '{{model}}: the self-test found the active key.',
          { ...stBase, fix: null }
        )
      );
      break;
    case SELF_TEST_STATE.FAILED:
      out.push(
        check(
          stId,
          LEVEL.ERROR,
          'watermark.selfTestFailed',
          '{{model}}: the last self-test failed. vLLM and iHub probably do not use the same key.',
          stBase
        )
      );
      break;
    case SELF_TEST_STATE.INCONCLUSIVE:
      out.push(
        check(
          stId,
          LEVEL.WARN,
          'watermark.selfTestInconclusive',
          '{{model}}: the last self-test was inconclusive (text too short). Run it again.',
          stBase
        )
      );
      break;
    case SELF_TEST_STATE.STALE:
      out.push(
        check(
          stId,
          LEVEL.WARN,
          'watermark.selfTestStale',
          '{{model}}: the key changed since the last self-test. Update vLLM, then run it again.',
          stBase
        )
      );
      break;
    default:
      out.push(
        check(
          stId,
          LEVEL.WARN,
          'watermark.selfTestNever',
          '{{model}}: the self-test has not been run.',
          stBase
        )
      );
  }
  return out;
}
