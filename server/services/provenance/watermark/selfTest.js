// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin checks of a model's watermark chain (#3331).
 *
 * - {@link pingDetector}: reaches the detector with a throwaway random key and
 *   a fixed sentence. Proves URL, TLS, token and response contract without
 *   sending a real key.
 * - {@link runSelfTest}: generates about 350 words through the model, detects
 *   them with all keys and says whether iHub and vLLM agree on the key. A model
 *   whose image holds the key (`keyHolder: "model"`) is detected at its own
 *   endpoint or the Model Gateway; then the test says whether the watermark was
 *   found, and with which key file.
 *
 * The connectivity check sends the fixed sentence only to a model's endpoint or
 * the gateway: they hold their keys.
 *
 * @module services/provenance/watermark/selfTest
 */
import { randomInt } from 'node:crypto';
import { ServiceError } from '../../../utils/ServiceError.js';
import { getWatermarkKeyStore } from './WatermarkKeyStore.js';
import { callDetector, callGatewayDetector, callModelDetector } from './DetectorClient.js';
import {
  askModelDetector,
  decide,
  decideFromGateway,
  detectorConfigOf,
  DETECTOR_API,
  evaluateChecks,
  WATERMARK_STATUS
} from './detect.js';
import { getApiKeyForModel } from '../../../utils.js';
import { watermarkSettings } from './watermarkSettings.js';

/** Outcomes of {@link runSelfTest}. */
export const SELF_TEST_DIAGNOSIS = Object.freeze({
  KEYS_MATCH: 'keys_match',
  MATCHES_RETIRED_KEY: 'matches_retired_key',
  NO_WATERMARK_FOUND: 'no_watermark_found',
  TOO_SHORT: 'too_short',
  DETECTOR_UNREACHABLE: 'detector_unreachable',
  NOT_APPLIED: 'not_applied',
  NO_KEYS: 'no_keys',
  // keyHolder "model": the image's detector found the watermark (iHub holds no key to compare).
  WATERMARK_FOUND: 'watermark_found'
});

const PING_TEXT = 'The quick brown fox jumps over the lazy dog while the river runs quietly by.';
const SELF_TEST_PROMPT =
  'Write a flowing essay of about 350 words on how rivers shape the landscapes they cross. ' +
  'Use plain prose without lists or headings.';
export const SELF_TEST_MAX_TOKENS = 400;

function requireDetector(model) {
  const config = detectorConfigOf(model);
  if (!config) {
    throw new ServiceError(
      'WATERMARK_DETECTOR_NOT_CONFIGURED',
      'This model is not marked by iHub (contentMarking.text.by is not "ihub")'
    );
  }
  if (!config.detectorUrl) {
    throw new ServiceError(
      'WATERMARK_DETECTOR_NOT_CONFIGURED',
      config.api === DETECTOR_API.MODEL
        ? 'The detector URL cannot be derived from the model URL; set detectorUrl'
        : 'This model has no detector URL'
    );
  }
  return config;
}

/**
 * @param {Object} model
 * @returns {Promise<{reachable: boolean, authenticated: boolean, contractValid: boolean, latencyMs: number, error?: string}>}
 * @throws {ServiceError} WATERMARK_DETECTOR_NOT_CONFIGURED
 */
export async function pingDetector(
  model,
  { call = callDetector, callModel = callModelDetector, callGateway = callGatewayDetector } = {}
) {
  const config = requireDetector(model);
  const started = Date.now();
  const timeoutMs = watermarkSettings().detectorTimeoutMs;
  try {
    let answer;
    if (config.api === DETECTOR_API.MODEL) {
      answer = await callModel({
        url: config.detectorUrl,
        apiKey: await getApiKeyForModel(config.modelId),
        text: PING_TEXT,
        timeoutMs
      });
    } else if (config.api === DETECTOR_API.GATEWAY) {
      answer = await callGateway({
        url: config.detectorUrl,
        credentialRef: config.credentialRef,
        text: PING_TEXT,
        timeoutMs
      });
    } else {
      answer = await call({
        url: config.detectorUrl,
        credentialRef: config.credentialRef,
        text: PING_TEXT,
        // A random key: nothing real leaves iHub for a connectivity check.
        keys: [{ keyId: 'probe', key: randomInt(1, 2 ** 48) }],
        tokenizer: config.tokenizer,
        algorithm: config.algorithm,
        prf: config.prf,
        contextWidth: config.contextWidth,
        timeoutMs
      });
    }
    return {
      reachable: true,
      authenticated: true,
      contractValid: true,
      latencyMs: answer.latencyMs ?? Date.now() - started
    };
  } catch (error) {
    if (error?.code === 'WATERMARK_DETECTOR_NOT_CONFIGURED') throw error;
    const reason = error?.details?.reason;
    const result = {
      reachable: false,
      authenticated: false,
      contractValid: false,
      latencyMs: Date.now() - started,
      error: reason || 'network'
    };
    if (reason === 'unauthorized') return { ...result, reachable: true };
    if (reason === 'bad_response' || reason === 'too_large' || reason === 'http_error') {
      return { ...result, reachable: true, authenticated: true };
    }
    return result;
  }
}

/**
 * Generate through the model and detect with all keys.
 *
 * @param {Object} model - A `by: "ihub"` model with a detector
 * @param {Object} deps
 * @param {{complete: Function}} deps.llmClient
 * @param {Object} [deps.user] - For the run telemetry
 * @returns {Promise<{ok: boolean, diagnosis: string, status: string, matchedKeyId?: string, scoredTokens: number, pValue?: number}>}
 */
export async function runSelfTest(
  model,
  {
    llmClient,
    user,
    call = callDetector,
    callModel = callModelDetector,
    callGateway = callGatewayDetector
  }
) {
  const config = requireDetector(model);
  const modelHeld = config.keyHolder === 'model';
  // The image holds the keys of a "model" key holder: iHub's key store plays no part.
  const keys = modelHeld ? [] : await getWatermarkKeyStore().getKeysForDetection();
  const empty = { ok: false, scoredTokens: 0, status: WATERMARK_STATUS.NOT_CONFIGURED };
  if (!modelHeld && keys.length === 0) return { ...empty, diagnosis: SELF_TEST_DIAGNOSIS.NO_KEYS };

  // Sampling at temperature 1 whatever the model sets: a greedy model cannot be marked,
  // and the test is about the key, not about the model's own sampling.
  const probeModel = { ...model, sampling: { temperature: 1 } };
  const generated = await llmClient.complete({
    model: probeModel,
    messages: [{ role: 'user', content: SELF_TEST_PROMPT }],
    options: { maxTokens: SELF_TEST_MAX_TOKENS },
    retries: 0,
    telemetry: { kind: 'diagnostic', purpose: 'watermark-self-test', user }
  });
  const plan = generated.marking?.text;
  if (!plan?.applied) {
    return { ...empty, diagnosis: SELF_TEST_DIAGNOSIS.NOT_APPLIED, reason: plan?.reason };
  }

  const settings = watermarkSettings();
  if (modelHeld) {
    return modelHeldSelfTest({
      config,
      text: generated.content || '',
      settings,
      callModel,
      callGateway
    });
  }
  let answer;
  try {
    answer = await call({
      url: config.detectorUrl,
      credentialRef: config.credentialRef,
      // The raw answer: any post-processing would lower the score.
      text: generated.content || '',
      keys: keys.map(({ keyId, key }) => ({ keyId, key })),
      tokenizer: config.tokenizer,
      algorithm: config.algorithm,
      prf: config.prf,
      contextWidth: config.contextWidth,
      timeoutMs: settings.detectorTimeoutMs
    });
  } catch (error) {
    if (error?.code === 'WATERMARK_DETECTOR_NOT_CONFIGURED') throw error;
    return { ...empty, diagnosis: SELF_TEST_DIAGNOSIS.DETECTOR_UNREACHABLE };
  }
  const verdict = decide(
    [
      {
        detector: config,
        keys: keys.map(entry => entry.keyId),
        numScoredTokens: answer.numScoredTokens,
        results: answer.results
      }
    ],
    settings
  );
  const base = {
    status: verdict.status,
    scoredTokens: verdict.scoredTokens,
    ...(verdict.pValue !== undefined ? { pValue: verdict.pValue } : {})
  };
  if (verdict.status === WATERMARK_STATUS.DETECTED) {
    const active = keys.find(entry => entry.status === 'active');
    const matchesActive = verdict.keyId === active?.keyId;
    return {
      ...base,
      ok: matchesActive,
      diagnosis: matchesActive
        ? SELF_TEST_DIAGNOSIS.KEYS_MATCH
        : SELF_TEST_DIAGNOSIS.MATCHES_RETIRED_KEY,
      matchedKeyId: verdict.keyId
    };
  }
  return {
    ...base,
    ok: false,
    diagnosis:
      verdict.status === WATERMARK_STATUS.TOO_SHORT
        ? SELF_TEST_DIAGNOSIS.TOO_SHORT
        : SELF_TEST_DIAGNOSIS.NO_WATERMARK_FOUND
  };
}

/** The self-test of a model whose image holds the key, after the generation. */
async function modelHeldSelfTest({ config, text, settings, callModel, callGateway }) {
  const unreachable = {
    ok: false,
    scoredTokens: 0,
    status: WATERMARK_STATUS.UNAVAILABLE,
    diagnosis: SELF_TEST_DIAGNOSIS.DETECTOR_UNREACHABLE
  };
  let verdict;
  if (config.api === DETECTOR_API.GATEWAY) {
    let answer;
    try {
      // The raw answer: any post-processing would lower the score.
      answer = await callGateway({
        url: config.detectorUrl,
        credentialRef: config.credentialRef,
        text,
        timeoutMs: settings.detectorTimeoutMs
      });
    } catch (error) {
      if (error?.code === 'WATERMARK_DETECTOR_NOT_CONFIGURED') throw error;
      return unreachable;
    }
    verdict = decideFromGateway(answer, { detector: config });
  } else {
    const outcome = await askModelDetector(config, text, {
      timeoutMs: settings.detectorTimeoutMs,
      call: callModel
    });
    if (!outcome.checks) return unreachable;
    verdict = evaluateChecks([outcome], settings);
  }
  const base = {
    status: verdict.status,
    scoredTokens: verdict.scoredTokens,
    ...(verdict.pValue !== undefined ? { pValue: verdict.pValue } : {})
  };
  if (verdict.status === WATERMARK_STATUS.DETECTED) {
    return {
      ...base,
      ok: true,
      diagnosis: SELF_TEST_DIAGNOSIS.WATERMARK_FOUND,
      ...(verdict.keyLabel ? { matchedKeyLabel: verdict.keyLabel } : {})
    };
  }
  let diagnosis = SELF_TEST_DIAGNOSIS.NO_WATERMARK_FOUND;
  if (verdict.status === WATERMARK_STATUS.TOO_SHORT) diagnosis = SELF_TEST_DIAGNOSIS.TOO_SHORT;
  if (verdict.status === WATERMARK_STATUS.UNAVAILABLE) {
    diagnosis = SELF_TEST_DIAGNOSIS.DETECTOR_UNREACHABLE;
  }
  return { ...base, ok: false, diagnosis };
}
