// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The server-owned decision to watermark one text request (#3331).
 *
 * Pure: the adapter hands in the model, its resolved sampling, the request
 * options and the active key id. Nothing here reads anything a client sent;
 * the only inputs are the model config and the server's own key snapshot.
 *
 * @module services/provenance/watermark/watermarkPlan
 */
import { VLLM_PROVIDERS } from '../../../validators/modelConfigSchema.js';

/** vLLM treats a temperature below this as greedy (`_SAMPLING_EPS`; from memory, unverified). */
export const GREEDY_TEMPERATURE = 1e-5;

/** Reasons a requested watermark is not claimed. */
export const WATERMARK_REASONS = Object.freeze({
  GREEDY: 'greedy',
  STRUCTURED_OUTPUT: 'structured_output',
  NO_ACTIVE_KEY: 'no_active_key'
});

/**
 * Whether the effective sampling is greedy (cannot be watermarked). A model
 * with no `sampling.temperature` is not greedy as far as iHub can tell: vLLM
 * then uses the model's own `generation_config.json`, which iHub cannot see.
 *
 * @param {{temperature?: number, topK?: number}} sampling
 */
export function isGreedy(sampling = {}) {
  return (
    (Number.isFinite(sampling.temperature) && sampling.temperature <= GREEDY_TEMPERATURE) ||
    sampling.topK === 1
  );
}

/**
 * @param {Object} model - Model config
 * @param {{temperature?: number, topK?: number}} sampling - `adapter.resolveSampling(model)`
 * @param {Object} [options] - Adapter options (`responseSchema`, `responseFormat`)
 * @param {string|null} [activeKeyId]
 * @returns {null | {by: 'ihub', scheme: string, applied: boolean, keyId?: string, reason?: string}}
 *   null when the model is not marked by iHub: nothing is added to the request.
 */
export function planTextWatermark(model, sampling, options = {}, activeKeyId = null) {
  const marking = model?.contentMarking?.text;
  if (marking?.by !== 'ihub') return null;
  // The schema rejects this; the check keeps a hand-edited file from ever
  // sending `watermarking` to a hosted API that would answer 400.
  if (!VLLM_PROVIDERS.includes(model.provider)) return null;
  const plan = { by: 'ihub', scheme: marking.scheme || 'vllm-gumbel', applied: false };
  if (isGreedy(sampling)) {
    plan.reason = WATERMARK_REASONS.GREEDY;
  } else if (options.responseSchema || options.responseFormat === 'json') {
    plan.reason = WATERMARK_REASONS.STRUCTURED_OUTPUT;
  } else if (!activeKeyId) {
    plan.reason = WATERMARK_REASONS.NO_ACTIVE_KEY;
  } else {
    plan.applied = true;
    plan.keyId = activeKeyId;
  }
  return plan;
}

/**
 * Combine the plans of the text-producing steps of one turn: the turn is
 * `applied` only when every step was.
 *
 * @param {Array<Object|null|undefined>} plans
 * @returns {Object|null}
 */
export function combinePlans(plans) {
  const list = plans.filter(Boolean);
  if (list.length === 0) return null;
  const failed = list.find(plan => !plan.applied);
  return failed || list[list.length - 1];
}
