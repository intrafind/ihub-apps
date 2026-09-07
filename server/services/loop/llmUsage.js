/**
 * Token-usage normalization shared by LLMClient, AgentLoop and the ledger.
 *
 * Every adapter reports usage a little differently (camelCase under
 * `metadata.usage`, snake_case provider bodies, Bedrock's top-level `usage`,
 * Anthropic's split delivery across `message_start` / `message_delta`). The
 * canonical shape everywhere downstream is the ledger `usageSchema`:
 * `{ promptTokens, completionTokens, totalTokens, cacheReadTokens?,
 *    cacheWriteTokens?, reasoningTokens?, source }`.
 *
 * @module services/loop/llmUsage
 */

function num(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return Math.round(c);
  }
  return undefined;
}

/**
 * Normalize any provider/adapter usage object into the canonical shape.
 * Returns `null` when the object carries no numeric token counts at all.
 *
 * @param {Object|null|undefined} raw
 * @param {'provider'|'estimate'|'mixed'} [source='provider']
 * @returns {{promptTokens:number, completionTokens:number, totalTokens:number,
 *   cacheReadTokens?:number, cacheWriteTokens?:number, reasoningTokens?:number, source:string}|null}
 */
export function normalizeUsage(raw, source = 'provider') {
  if (!raw || typeof raw !== 'object') return null;
  const promptTokens = num(
    raw.promptTokens,
    raw.prompt_tokens,
    raw.input_tokens,
    raw.inputTokens,
    raw.promptTokenCount,
    raw.input
  );
  const completionTokens = num(
    raw.completionTokens,
    raw.completion_tokens,
    raw.output_tokens,
    raw.outputTokens,
    raw.candidatesTokenCount,
    raw.output
  );
  let totalTokens = num(raw.totalTokens, raw.total_tokens, raw.totalTokenCount, raw.total);
  const cacheReadTokens = num(
    raw.cacheReadTokens,
    raw.cache_read_input_tokens,
    raw.cachedContentTokenCount,
    raw.prompt_tokens_details?.cached_tokens,
    raw.input_tokens_details?.cached_tokens
  );
  const cacheWriteTokens = num(raw.cacheWriteTokens, raw.cache_creation_input_tokens);
  const reasoningTokens = num(
    raw.reasoningTokens,
    raw.thoughtsTokenCount,
    raw.completion_tokens_details?.reasoning_tokens,
    raw.output_tokens_details?.reasoning_tokens
  );

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null;
  }
  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  if (totalTokens === undefined || totalTokens < p + c) totalTokens = p + c;

  const out = { promptTokens: p, completionTokens: c, totalTokens, source: raw.source || source };
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  return out;
}

/**
 * Merge usage reported across streaming chunks. Non-zero incoming values win
 * (handles Anthropic's `message_start` prompt count + `message_delta` output
 * count, and Google's cumulative per-chunk counters).
 *
 * @param {Object|null} existing - already normalized
 * @param {Object|null} incoming - already normalized
 * @returns {Object|null}
 */
export function mergeUsage(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return { ...incoming };
  const merged = {
    ...existing,
    ...incoming,
    promptTokens: incoming.promptTokens || existing.promptTokens,
    completionTokens: incoming.completionTokens || existing.completionTokens
  };
  const total = Math.max(
    incoming.totalTokens || 0,
    existing.totalTokens || 0,
    merged.promptTokens + merged.completionTokens
  );
  merged.totalTokens = total;
  if (existing.source && incoming.source && existing.source !== incoming.source) {
    merged.source = 'mixed';
  }
  return merged;
}

/**
 * Add two usage objects (run-level accumulation across calls).
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {Object|null}
 */
export function addUsage(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out = {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
    source: a.source === b.source ? a.source || 'provider' : 'mixed'
  };
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] || 0) + (b[key] || 0);
  }
  return out;
}

/**
 * Workflow step-log / run-budget view: `{ input, output, total }`.
 * @param {Object|null} usage
 * @returns {{input:number, output:number, total:number}|null}
 */
export function usageToBudget(usage) {
  if (!usage) return null;
  const input = usage.promptTokens || 0;
  const output = usage.completionTokens || 0;
  if (!input && !output) return null;
  return { input, output, total: usage.totalTokens || input + output };
}

/**
 * OpenAI-compatible wire view: `{ prompt_tokens, completion_tokens, total_tokens }`.
 * @param {Object|null} usage
 * @returns {{prompt_tokens:number, completion_tokens:number, total_tokens:number}}
 */
export function usageToOpenAI(usage) {
  return {
    prompt_tokens: usage?.promptTokens || 0,
    completion_tokens: usage?.completionTokens || 0,
    total_tokens: usage?.totalTokens || 0
  };
}
