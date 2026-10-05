/**
 * The per-request watermark setting sent to a self-hosted vLLM server
 * (vLLM RFC #53916: `SamplingParams.watermarking`). Derived **only** from the
 * model configuration — never from the request — so a caller cannot switch
 * marking off (concept §8.1 hook 3).
 *
 * The engine-level `--watermark-config` is what embeds the mark; the
 * per-request flag is only sent when the model opts in
 * (`contentMarking.textWatermark.perRequest: true`), because servers that
 * predate the RFC reject unknown fields.
 *
 * @module services/provenance/watermark/requestParams
 */
import { normalizeContentMarking } from '../../../../shared/aiTransparency.js';

/**
 * Body fields to merge into an OpenAI-compatible chat request.
 * @param {Object} model - model config
 * @returns {Object} `{ watermarking: true }` or `{}`
 */
export function watermarkRequestFields(model) {
  const { text } = normalizeContentMarking(model);
  if (text.kind === 'scheme' && text.scheme === 'vllm-gumbel' && text.perRequest) {
    return { watermarking: true };
  }
  return {};
}
