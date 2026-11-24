// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Is this text ours?" for text with no matching record (#3331).
 *
 * Runs after the hash lookup. Candidates are the distinct detectors of the
 * `by: "ihub"` models, of three kinds:
 *
 * - `ihub` (`keyHolder: "ihub"`, iHub's key store): every key (active first,
 *   then retired) goes to a detector of iHub's contract. iHub decides from
 *   `p_value` itself, never from the detector's `is_watermarked`, with a
 *   Bonferroni correction over (keys x detectors), and ignores any `key_id` it
 *   did not send.
 * - `model` (`keyHolder: "model"`): the text goes to the detection endpoint
 *   built into each model's if-vllm image, which holds the keys and answers with
 *   an uncorrected p-value per key file and algorithm. iHub decides as an iFinder
 *   Model Gateway does ({@link evaluateChecks}).
 * - `gateway` (`keyHolder: "model"` with `provenance.watermark.gatewayUrl` set):
 *   the text goes once to the installation's Model Gateway, and iHub takes its
 *   verdict ({@link decideFromGateway}).
 *
 * With several kinds configured, any detection wins ({@link combineVerdicts});
 * the false-alarm rate is then at most the sum of their alphas. Without a
 * detection, a detector that did not answer makes the result "unavailable"
 * rather than "not detected", as for the gateway's `UNCLEAR`.
 *
 * Wording: a result never says "not watermarked" or "human-written". A negative
 * is "not detected" (evidence of nothing) or "too short to tell".
 *
 * @module services/provenance/watermark/detect
 */
import { isEuAiActEnabled } from '../../euAiAct/conformity.js';
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { getApiKeyForModel } from '../../../utils.js';
import { getWatermarkKeyStore } from './WatermarkKeyStore.js';
import { callDetector, callGatewayDetector, callModelDetector } from './DetectorClient.js';
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

/** Where a model's watermark is detected; see the module comment. */
export const DETECTOR_API = Object.freeze({
  IHUB: 'ihub',
  MODEL: 'model',
  GATEWAY: 'gateway'
});

/** Path of the detection endpoint in iFinder's if-vllm image. */
export const MODEL_DETECT_PATH = '/watermark/v1/detect';

/** A path without its trailing slashes (a loop: no backtracking regex). */
function trimTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/**
 * The detection endpoint of a model's if-vllm image: the server of its chat URL,
 * with any path before `/v1` kept (a reverse proxy prefix), plus
 * {@link MODEL_DETECT_PATH}. Null when the model has no usable URL.
 *
 * @param {Object} model
 * @returns {string|null}
 */
export function modelDetectorUrl(model) {
  let url;
  try {
    url = new URL(model?.url);
  } catch {
    return null;
  }
  const index = url.pathname.search(/\/v1(\/|$)/);
  const prefix = trimTrailingSlashes(index >= 0 ? url.pathname.slice(0, index) : '');
  return `${url.origin}${prefix}${MODEL_DETECT_PATH}`;
}

/**
 * The static detector settings of a model (no network, no keys), or null.
 *
 * @param {Object} model
 * @param {Object} [settings] - {@link watermarkSettings}
 */
export function detectorConfigOf(model, settings = watermarkSettings()) {
  const marking = model?.contentMarking?.text;
  if (marking?.by !== 'ihub') return null;
  const base = {
    modelId: model.id,
    keyHolder: marking.keyHolder === 'model' ? 'model' : 'ihub',
    scheme: marking.scheme || 'vllm-gumbel'
  };
  if (base.keyHolder === 'model') {
    if (settings.gatewayUrl) {
      return {
        ...base,
        api: DETECTOR_API.GATEWAY,
        detectorUrl: settings.gatewayUrl,
        credentialRef: settings.gatewayCredentialRef
      };
    }
    // The image checks the model's own API key; it is read at call time.
    return {
      ...base,
      api: DETECTOR_API.MODEL,
      detectorUrl: marking.detectorUrl || modelDetectorUrl(model),
      credentialRef: null
    };
  }
  return {
    ...base,
    api: DETECTOR_API.IHUB,
    detectorUrl: marking.detectorUrl || null,
    credentialRef: marking.detectorCredentialRef || null,
    tokenizer: marking.tokenizer || model.modelId || model.id,
    algorithm: marking.algorithm || 'gumbel',
    prf: marking.prf || 'philox',
    contextWidth: marking.contextWidth ?? 4
  };
}

/** Every enabled `by: "ihub"` model's detector settings. */
export function listDetectorConfigs({ includeDisabled = false, settings } = {}) {
  const models = configCache.getModels(includeDisabled)?.data || [];
  const effective = settings || watermarkSettings();
  return models.map(model => detectorConfigOf(model, effective)).filter(Boolean);
}

/**
 * Distinct detectors by what the call depends on: models on one vLLM server share
 * its endpoint, and every model held by the image shares the gateway.
 */
export function distinctDetectors(configs) {
  const seen = new Map();
  for (const config of configs) {
    if (!config.detectorUrl) continue;
    const id = JSON.stringify([
      config.api,
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
 * Decide from the results of detectors of iHub's contract (pure; exported for
 * the tests).
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

/** A stable text of a parameters object, for comparing checks. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value ?? null);
  return `{${Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

/** Buckets per unit of `ln p` for comparing checks, as the Model Gateway's `SchemeEvaluator`. */
const LOG_P_VALUE_BUCKETS_PER_UNIT = 1e6;

/** The bucket of `ln p`; a p-value of 0 (underflow) has a bucket of its own. */
function logPValueBucket(pValue) {
  return pValue === 0 ? 'zero' : Math.round(Math.log(pValue) * LOG_P_VALUE_BUCKETS_PER_UNIT);
}

/**
 * Decide from the uncorrected checks of if-vllm images' detection endpoints
 * (pure; exported for the tests) with the rule of an iFinder Model Gateway's
 * `SchemeEvaluator` (RAG-1190), applied with iHub's thresholds:
 *
 * - A check several detectors report with the same result counts once: same
 *   tokenizer, algorithm, parameters and number of scored tokens, and `ln p`
 *   equal after rounding to 1e-6 (hardware differences). The key file name and
 *   the vLLM version are not part of it: one key can carry two names, and
 *   different keys give different results anyway. A detector that reports no
 *   tokenizer shares no check with another one.
 * - Bonferroni: the strongest check's p-value times the number of distinct
 *   checks (at most 1) must be below `alpha`. Of equal p-values the first
 *   detector's check wins.
 * - Otherwise "too short" when a check scored fewer than `minScoredTokens`
 *   tokens, "unavailable" when a detector did not answer or answered without
 *   results (the gateway's `UNCLEAR`), else "not detected".
 *
 * @param {Array<{detector: Object, checks?: Array<{keyLabel: string, algorithm: string,
 *   parameters?: Object, pValue: number, numScoredTokens: number}>, tokenizer?: string,
 *   vllmVersion?: string}>} outcomes - One per detector; without `checks` it did not answer
 * @param {{alpha: number, minScoredTokens: number}} settings
 */
export function evaluateChecks(outcomes, { alpha, minScoredTokens }) {
  const distinct = new Map();
  for (const outcome of outcomes) {
    for (const check of outcome.checks || []) {
      const id = stableJson([
        outcome.tokenizer
          ? { tokenizer: outcome.tokenizer }
          : { detector: outcome.detector.detectorUrl },
        check.algorithm,
        check.parameters || {},
        logPValueBucket(check.pValue),
        check.numScoredTokens
      ]);
      if (!distinct.has(id)) distinct.set(id, { ...check, detector: outcome.detector });
    }
  }
  const checks = [...distinct.values()];
  const tests = checks.length;
  const best = checks.reduce(
    (min, check) => (!min || check.pValue < min.pValue ? check : min),
    null
  );
  const base = {
    scheme: outcomes[0]?.detector.scheme,
    checksMade: tests,
    detectorsChecked: outcomes.filter(outcome => outcome.checks?.length).length
  };
  const pValue = best ? Math.min(1, tests * best.pValue) : undefined;
  if (best && pValue < alpha) {
    return {
      ...base,
      status: WATERMARK_STATUS.DETECTED,
      technique: 'gumbel-max',
      keyLabel: best.keyLabel,
      algorithm: best.algorithm,
      pValue,
      scoredTokens: best.numScoredTokens
    };
  }
  const scoredTokens = checks.reduce((max, check) => Math.max(max, check.numScoredTokens), 0);
  let status = WATERMARK_STATUS.NOT_DETECTED;
  if (checks.some(check => check.numScoredTokens < minScoredTokens)) {
    status = WATERMARK_STATUS.TOO_SHORT;
  } else if (outcomes.some(outcome => !outcome.checks?.length)) {
    status = WATERMARK_STATUS.UNAVAILABLE;
  }
  return { ...base, status, scoredTokens, ...(best ? { pValue } : {}) };
}

/**
 * Turn an iFinder Model Gateway answer into iHub's result (pure; exported for the
 * tests and the self-test). The gateway's p-value is already corrected for the
 * checks it made.
 *
 * - `DETECTED`: `keyLabel` is the key file of the strongest detected result.
 * - `UNCLEAR`: `too_short` when a check scored too few tokens, otherwise
 *   (only detectors that did not answer) `unavailable`.
 * - `NOT_DETECTED`: `not_detected`.
 * - `checksMade`: the sum of the schemes' `evaluation.tests`, absent when the
 *   gateway does not report them.
 *
 * @param {Object} answer - {@link callGatewayDetector}'s result
 * @param {{detector: Object}} context
 */
export function decideFromGateway(answer, { detector }) {
  const gateway = {
    verdict: answer.verdict,
    alpha: answer.alpha,
    textSha256: answer.textSha256,
    detectedAt: answer.detectedAt,
    gatewayVersion: answer.gatewayVersion
  };
  const byPValue = (a, b) => a.pValue - b.pValue;
  const results = answer.schemes
    .map(scheme => scheme.strongestResult)
    .filter(Boolean)
    .sort(byPValue);
  const scoredTokens = results.reduce((max, result) => Math.max(max, result.numScoredTokens), 0);
  const counted = answer.schemes.filter(scheme => Number.isInteger(scheme.tests));
  const checksMade = counted.length
    ? counted.reduce((sum, scheme) => sum + scheme.tests, 0)
    : undefined;
  const base = {
    scheme: detector.scheme,
    scoredTokens,
    detectorsChecked: 1,
    ...(checksMade === undefined ? {} : { checksMade }),
    gateway
  };
  if (answer.verdict === 'DETECTED') {
    const detected =
      answer.schemes
        .filter(scheme => scheme.verdict === 'DETECTED' && scheme.strongestResult)
        .map(scheme => scheme.strongestResult)
        .sort(byPValue)[0] || results[0];
    return {
      ...base,
      status: WATERMARK_STATUS.DETECTED,
      technique: 'gumbel-max',
      ...(detected
        ? {
            keyLabel: detected.keyLabel,
            algorithm: detected.algorithm,
            pValue: detected.pValue,
            scoredTokens: detected.numScoredTokens
          }
        : {})
    };
  }
  let status = WATERMARK_STATUS.NOT_DETECTED;
  if (answer.verdict === 'UNCLEAR') {
    const reasons = new Set(answer.schemes.flatMap(scheme => scheme.unclearReasons));
    status = reasons.has('TOO_FEW_SCORED_TOKENS')
      ? WATERMARK_STATUS.TOO_SHORT
      : WATERMARK_STATUS.UNAVAILABLE;
  }
  return { ...base, status, ...(results[0] ? { pValue: results[0].pValue } : {}) };
}

/** Which result wins when several kinds of detector answered. */
const STATUS_RANK = [
  WATERMARK_STATUS.DETECTED,
  WATERMARK_STATUS.TOO_SHORT,
  WATERMARK_STATUS.UNAVAILABLE,
  WATERMARK_STATUS.NOT_DETECTED
];

/**
 * One result from the results of several kinds of detector: a detection wins
 * (the smallest p-value among them), then "too short", then "unavailable", then
 * "not detected": a route that could not decide keeps a negative open. The
 * counts add up.
 *
 * @param {Object[]} verdicts
 */
export function combineVerdicts(verdicts) {
  if (verdicts.length === 1) return verdicts[0];
  const rank = verdict => STATUS_RANK.indexOf(verdict.status);
  const [winner] = [...verdicts].sort(
    (a, b) => rank(a) - rank(b) || (a.pValue ?? 1) - (b.pValue ?? 1)
  );
  return {
    ...winner,
    keysChecked: verdicts.reduce((sum, verdict) => sum + (verdict.keysChecked ?? 0), 0),
    detectorsChecked: verdicts.reduce((sum, verdict) => sum + (verdict.detectorsChecked ?? 0), 0)
  };
}

function logUnavailable(api, error) {
  logger.warn('Watermark detector unavailable', {
    component: COMPONENT,
    api,
    code: error?.code,
    reason: error?.details?.reason
  });
}

/** Detectors of iHub's contract, which need the key values. */
async function runIhubDetectors(text, detectors, settings) {
  if (detectors.length === 0) return { verdicts: [], failures: 0 };
  let keys;
  try {
    keys = await getWatermarkKeyStore().getKeysForDetection();
  } catch (error) {
    logger.error('Could not read watermark keys for detection', {
      component: COMPONENT,
      error: error.message
    });
    return { verdicts: [], failures: 1 };
  }
  if (keys.length === 0) return { verdicts: [], failures: 0 };

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
      logUnavailable(DETECTOR_API.IHUB, error);
    }
  });
  return {
    verdicts: outcomes.length ? [{ ...decide(outcomes, settings), source: DETECTOR_API.IHUB }] : [],
    failures
  };
}

/**
 * One if-vllm image's detection endpoint, as an outcome for {@link evaluateChecks}:
 * without `checks` when it did not answer.
 *
 * @throws {ServiceError} WATERMARK_DETECTOR_NOT_CONFIGURED (a misconfiguration, not an outage)
 */
export async function askModelDetector(detector, text, { timeoutMs, call = callModelDetector }) {
  try {
    const answer = await call({
      url: detector.detectorUrl,
      apiKey: await getApiKeyForModel(detector.modelId),
      text,
      timeoutMs
    });
    // An image that answers without a result is unavailable, as for the gateway.
    if (answer.checks.length === 0) return { detector, error: new Error('no results') };
    return {
      detector,
      checks: answer.checks,
      tokenizer: answer.tokenizer,
      vllmVersion: answer.vllmVersion
    };
  } catch (error) {
    if (error?.code === 'WATERMARK_DETECTOR_NOT_CONFIGURED') throw error;
    logUnavailable(DETECTOR_API.MODEL, error);
    return { detector, error };
  }
}

/** The detection endpoints of the if-vllm images (keyHolder "model", no gateway). */
async function runModelDetectors(text, detectors, settings) {
  if (detectors.length === 0) return { verdicts: [], failures: 0 };
  const outcomes = await mapLimit(detectors, CONCURRENCY, async detector => {
    try {
      return await askModelDetector(detector, text, { timeoutMs: settings.detectorTimeoutMs });
    } catch (error) {
      logUnavailable(DETECTOR_API.MODEL, error);
      return { detector, error };
    }
  });
  const answered = outcomes.filter(outcome => outcome.checks?.length).length;
  return {
    verdicts: answered
      ? [{ ...evaluateChecks(outcomes, settings), source: DETECTOR_API.MODEL }]
      : [],
    failures: outcomes.length - answered
  };
}

/** The installation's Model Gateway (keyHolder "model" with a gateway URL). */
async function runGatewayDetectors(text, detectors, settings) {
  const verdicts = [];
  let failures = 0;
  await mapLimit(detectors, CONCURRENCY, async detector => {
    try {
      const answer = await callGatewayDetector({
        url: detector.detectorUrl,
        credentialRef: detector.credentialRef,
        text,
        timeoutMs: settings.detectorTimeoutMs
      });
      verdicts.push({ ...decideFromGateway(answer, { detector }), source: DETECTOR_API.GATEWAY });
    } catch (error) {
      failures += 1;
      logUnavailable(DETECTOR_API.GATEWAY, error);
    }
  });
  return { verdicts, failures };
}

/**
 * Run the detector(s) over a text.
 *
 * @param {string} text - Sent as given: normalization changes tokens.
 * @param {{modelId?: string}} [options]
 * @returns {Promise<Object>} The additive `watermark` member of the verify response.
 *   Never throws for a detector problem: that is `unavailable`. `source` names the
 *   route of the deciding verdict (`ihub`, `model` or `gateway`), so counts summed
 *   over several routes do not suggest another one.
 */
export async function detectWatermark(text, { modelId } = {}) {
  // EU AI Act master switch off: nothing is sent to a detector (defence for callers
  // other than the gated `_verify` route).
  if (!isEuAiActEnabled()) return { status: WATERMARK_STATUS.NOT_CONFIGURED };
  const settings = watermarkSettings();
  let configs = listDetectorConfigs({ settings });
  if (modelId) configs = configs.filter(config => config.modelId === modelId);
  const detectors = distinctDetectors(configs);
  if (detectors.length === 0) return { status: WATERMARK_STATUS.NOT_CONFIGURED };

  const of = api => detectors.filter(detector => detector.api === api);
  const runs = await Promise.all([
    runIhubDetectors(text, of(DETECTOR_API.IHUB), settings),
    runModelDetectors(text, of(DETECTOR_API.MODEL), settings),
    runGatewayDetectors(text, of(DETECTOR_API.GATEWAY), settings)
  ]);
  const verdicts = runs.flatMap(run => run.verdicts);
  const failures = runs.reduce((sum, run) => sum + run.failures, 0);
  if (verdicts.length === 0) {
    return { status: failures ? WATERMARK_STATUS.UNAVAILABLE : WATERMARK_STATUS.NOT_CONFIGURED };
  }
  const result = combineVerdicts(verdicts);
  // A route that failed altogether may have held the watermark: no "not detected" then.
  return failures && result.status === WATERMARK_STATUS.NOT_DETECTED
    ? { ...result, status: WATERMARK_STATUS.UNAVAILABLE }
    : result;
}
