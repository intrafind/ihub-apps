// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Is this text ours?" for text with no matching record (#3331).
 *
 * Runs after the hash lookup. Candidates are the distinct detectors configured
 * on `by: "ihub"` models; every key (active first, then retired) goes to each.
 * iHub decides from `p_value` itself, never from the detector's
 * `is_watermarked`, with a Bonferroni correction over (keys x detectors), and
 * ignores any `key_id` it did not send.
 *
 * Wording: a result never says "not watermarked" or "human-written". A negative
 * is "not detected" (evidence of nothing) or "too short to tell".
 *
 * @module services/provenance/watermark/detect
 */
import { isEuAiActEnabled } from '../../euAiAct/conformity.js';
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { getWatermarkKeyStore } from './WatermarkKeyStore.js';
import { callDetector } from './DetectorClient.js';
import { watermarkSettings } from './watermarkSettings.js';

const COMPONENT = 'WatermarkDetect';
const CONCURRENCY = 3;

export const WATERMARK_STATUS = Object.freeze({
  DETECTED: 'detected',
  NOT_DETECTED: 'not_detected',
  TOO_SHORT: 'too_short',
  UNAVAILABLE: 'unavailable',
  NOT_CONFIGURED: 'not_configured'
});

/**
 * The static detector settings of a model (no network, no keys), or null.
 *
 * @param {Object} model
 */
export function detectorConfigOf(model) {
  const marking = model?.contentMarking?.text;
  if (marking?.by !== 'ihub') return null;
  return {
    modelId: model.id,
    detectorUrl: marking.detectorUrl || null,
    credentialRef: marking.detectorCredentialRef || null,
    tokenizer: marking.tokenizer || model.modelId || model.id,
    algorithm: marking.algorithm || 'gumbel',
    prf: marking.prf || 'philox',
    contextWidth: marking.contextWidth ?? 4,
    scheme: marking.scheme || 'vllm-gumbel'
  };
}

/** Every enabled `by: "ihub"` model's detector settings. */
export function listDetectorConfigs({ includeDisabled = false } = {}) {
  const models = configCache.getModels(includeDisabled)?.data || [];
  return models.map(detectorConfigOf).filter(Boolean);
}

/** Distinct detectors by what the call depends on. */
export function distinctDetectors(configs) {
  const seen = new Map();
  for (const config of configs) {
    if (!config.detectorUrl) continue;
    const id = JSON.stringify([
      config.detectorUrl,
      config.credentialRef,
      config.tokenizer,
      config.algorithm,
      config.prf,
      config.contextWidth
    ]);
    if (!seen.has(id)) seen.set(id, config);
  }
  return [...seen.values()];
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Decide from the detector results (pure; exported for the tests).
 *
 * @param {Array<{keys: Array, numScoredTokens: number, results: Array<{keyId: string, pValue: number}>}>} outcomes
 * @param {{alpha: number, minScoredTokens: number}} settings
 */
export function decide(outcomes, { alpha, minScoredTokens }) {
  const tests = outcomes.reduce((sum, outcome) => sum + outcome.keys.length, 0);
  const threshold = alpha / Math.max(1, tests);
  let best = null;
  let maxScored = 0;
  for (const outcome of outcomes) {
    maxScored = Math.max(maxScored, outcome.numScoredTokens);
    const sent = new Set(outcome.keys);
    for (const result of outcome.results) {
      if (!sent.has(result.keyId)) continue; // a key id we did not send
      if (!best || result.pValue < best.pValue) {
        best = { ...result, scoredTokens: outcome.numScoredTokens, detector: outcome.detector };
      }
    }
  }
  const base = { keysChecked: outcomes[0]?.keys.length ?? 0, detectorsChecked: outcomes.length };
  if (best && best.pValue < threshold) {
    // A small p-value is valid at any length, so a short positive stays a positive.
    return {
      status: WATERMARK_STATUS.DETECTED,
      scheme: best.detector.scheme,
      technique: 'gumbel-max',
      keyId: best.keyId,
      pValue: best.pValue,
      scoredTokens: best.scoredTokens,
      ...base
    };
  }
  const status =
    maxScored < minScoredTokens ? WATERMARK_STATUS.TOO_SHORT : WATERMARK_STATUS.NOT_DETECTED;
  return {
    status,
    scheme: outcomes[0]?.detector.scheme,
    ...(best ? { pValue: best.pValue } : {}),
    scoredTokens: maxScored,
    ...base
  };
}

/**
 * Run the detector(s) over a text.
 *
 * @param {string} text - Sent as given: normalization changes tokens.
 * @param {{modelId?: string}} [options]
 * @returns {Promise<Object>} The additive `watermark` member of the verify response.
 *   Never throws for a detector problem: that is `unavailable`.
 */
export async function detectWatermark(text, { modelId } = {}) {
  // EU AI Act master switch off: nothing is sent to a detector (defence for callers
  // other than the gated `_verify` route).
  if (!isEuAiActEnabled()) return { status: WATERMARK_STATUS.NOT_CONFIGURED };
  const settings = watermarkSettings();
  let configs = listDetectorConfigs();
  if (modelId) configs = configs.filter(config => config.modelId === modelId);
  const detectors = distinctDetectors(configs);
  if (detectors.length === 0) return { status: WATERMARK_STATUS.NOT_CONFIGURED };

  let keys;
  try {
    keys = await getWatermarkKeyStore().getKeysForDetection();
  } catch (error) {
    logger.error('Could not read watermark keys for detection', {
      component: COMPONENT,
      error: error.message
    });
    return { status: WATERMARK_STATUS.UNAVAILABLE };
  }
  if (keys.length === 0) return { status: WATERMARK_STATUS.NOT_CONFIGURED };

  const outcomes = [];
  let failures = 0;
  await mapLimit(detectors, CONCURRENCY, async detector => {
    try {
      const answer = await callDetector({
        url: detector.detectorUrl,
        credentialRef: detector.credentialRef,
        text,
        keys: keys.map(({ keyId, key }) => ({ keyId, key })),
        tokenizer: detector.tokenizer,
        algorithm: detector.algorithm,
        prf: detector.prf,
        contextWidth: detector.contextWidth,
        timeoutMs: settings.detectorTimeoutMs
      });
      outcomes.push({
        detector,
        keys: keys.map(entry => entry.keyId),
        numScoredTokens: answer.numScoredTokens,
        results: answer.results
      });
    } catch (error) {
      failures += 1;
      logger.warn('Watermark detector unavailable', {
        component: COMPONENT,
        code: error?.code,
        reason: error?.details?.reason
      });
    }
  });
  if (outcomes.length === 0) {
    return { status: failures ? WATERMARK_STATUS.UNAVAILABLE : WATERMARK_STATUS.NOT_CONFIGURED };
  }
  return decide(outcomes, settings);
}
