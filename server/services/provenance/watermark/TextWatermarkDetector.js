/**
 * Text watermark detection through a detector service (issue #2572/#2573).
 *
 * Detecting vLLM's Gumbel-max watermark needs the key and the model's
 * tokenizer, not the GPU. iHub keeps the keys (per key group) and calls a
 * small detector service that runs vLLM's detection primitives CPU-only — a
 * reference implementation ships in `docker/watermark-detector/`. The
 * contract (documented in `docs/eu-ai-act.md`):
 *
 *     POST <detectorUrl>
 *     { "text": "...", "tokenizer": "<HF model id>", "algorithm": "gumbel",
 *       "key": <int>, "context_width": 4 }
 *     → { "p_value": 1e-9, "score": 312.4, "num_tokens": 240, "is_watermarked": true }
 *
 * Every key version of the group is tried (newest first), so text marked
 * with a rotated-out key still verifies. The submitted text is sent to the
 * detector and not stored anywhere (CoP 2.1.3).
 *
 * @module services/provenance/watermark/TextWatermarkDetector
 */
import configCache from '../../../configCache.js';
import { normalizeContentMarking } from '../../../../shared/aiTransparency.js';
import keyGroupService from './KeyGroupService.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'TextWatermarkDetector';
/** p-value below which text counts as watermarked (1 % FPR per test, Bonferroni-corrected). */
export const DEFAULT_P_THRESHOLD = 0.01;
const TIMEOUT_MS = 15000;

/**
 * Models that watermark with a given key group.
 * @param {string} keyGroupId
 */
function modelsForKeyGroup(keyGroupId) {
  const list = configCache.getModels(true)?.data || [];
  return list.filter(m => {
    const marking = normalizeContentMarking(m);
    return marking.text.kind === 'scheme' && marking.text.keyGroup === keyGroupId;
  });
}

async function callDetector(url, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`detector answered HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run text watermark detection across every configured key group.
 *
 * @param {string} text
 * @param {Object} [opts]
 * @param {string[]} [opts.keyGroups] - restrict to these groups
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{checked: boolean, detected: boolean, results: Object[], errors: string[]}>}
 */
export async function detectTextWatermark(text, { keyGroups, fetchImpl = globalThis.fetch } = {}) {
  const groups = (await keyGroupService.list()).filter(
    g => g.detectorUrl && (!keyGroups || keyGroups.includes(g.id))
  );
  const results = [];
  const errors = [];
  if (!groups.length) return { checked: false, detected: false, results, errors };
  for (const group of groups) {
    const material = await keyGroupService.detectionKeys(group.id);
    const tokenizers = [
      ...new Set(
        modelsForKeyGroup(group.id)
          .map(m => m.modelId)
          .filter(Boolean)
      )
    ];
    if (!tokenizers.length) tokenizers.push(null);
    const tests = material.keys.length * tokenizers.length;
    const threshold = DEFAULT_P_THRESHOLD / Math.max(1, tests);
    for (const { version, key } of material.keys) {
      for (const tokenizer of tokenizers) {
        try {
          const answer = await callDetector(
            group.detectorUrl,
            {
              text,
              tokenizer,
              algorithm: group.algorithm,
              key: Number.isSafeInteger(Number(key)) ? Number(key) : key,
              context_width: group.contextWidth
            },
            fetchImpl
          );
          const pValue = Number(answer?.p_value);
          const detected = Number.isFinite(pValue)
            ? pValue < threshold
            : answer?.is_watermarked === true;
          results.push({
            keyGroup: group.id,
            keyVersion: version,
            tokenizer,
            pValue: Number.isFinite(pValue) ? pValue : null,
            score: Number.isFinite(Number(answer?.score)) ? Number(answer.score) : null,
            tokens: Number.isFinite(Number(answer?.num_tokens)) ? Number(answer.num_tokens) : null,
            threshold,
            detected
          });
          if (detected) return { checked: true, detected: true, results, errors };
        } catch (error) {
          logger.warn('Text watermark detector call failed', {
            component: COMPONENT,
            keyGroup: group.id,
            error: error.message
          });
          errors.push(`${group.id}: ${error.message}`);
        }
      }
    }
  }
  return { checked: results.length > 0, detected: false, results, errors };
}
