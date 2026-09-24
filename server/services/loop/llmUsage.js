/**
 * Token-usage normalization shared by LLMClient, AgentLoop and the ledger.
 *
 * Every adapter reports usage a little differently (camelCase under
 * `metadata.usage`, snake_case provider bodies, Bedrock's top-level `usage`,
 * Anthropic's split delivery across `message_start` / `message_delta`). The
 * canonical shape everywhere downstream is the ledger `usageSchema`:
 * `{ promptTokens, completionTokens, totalTokens, cacheReadTokens?,
 *    cacheWriteTokens?, reasoningTokens?, webSearchRequests?, source }`.
 *
 * `promptTokens` is the whole input with cached tokens included and
 * `completionTokens` the whole output with reasoning included, whatever the
 * provider (the converters add Anthropic's and Bedrock's separately reported
 * cache counts back in). `cacheReadTokens` and `cacheWriteTokens` are subsets
 * of `promptTokens`; `reasoningTokens` is a subset of `completionTokens`.
 *
 * @module services/loop/llmUsage
 */

/** Counters only present when the provider reported them. */
export const OPTIONAL_COUNTERS = Object.freeze([
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'webSearchRequests'
]);

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
 *   cacheReadTokens?:number, cacheWriteTokens?:number, reasoningTokens?:number,
 *   webSearchRequests?:number, source:string}|null}
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
    raw.cacheReadInputTokens,
    raw.cachedContentTokenCount,
    raw.prompt_tokens_details?.cached_tokens,
    raw.input_tokens_details?.cached_tokens
  );
  const cacheWriteTokens = num(
    raw.cacheWriteTokens,
    raw.cache_creation_input_tokens,
    raw.cacheWriteInputTokens
  );
  const reasoningTokens = num(
    raw.reasoningTokens,
    raw.thoughtsTokenCount,
    raw.completion_tokens_details?.reasoning_tokens,
    raw.output_tokens_details?.reasoning_tokens
  );
  // Provider-run searches billed on top of tokens (Anthropic web search).
  const webSearchRequests = num(
    raw.webSearchRequests,
    raw.web_search_requests,
    raw.server_tool_use?.web_search_requests
  );

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined &&
    webSearchRequests === undefined
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
  if (webSearchRequests !== undefined) out.webSearchRequests = webSearchRequests;
  return out;
}

/**
 * Merge usage reported across streaming chunks. Non-zero incoming values win
 * (handles Anthropic's `message_start` prompt count + `message_delta` output
 * count, and Google's cumulative per-chunk counters). The optional counters
 * (cache read/write, reasoning, web searches) are cumulative within one
 * response, so the highest value reported wins and a frame that omits one
 * never erases it.
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
  for (const key of OPTIONAL_COUNTERS) {
    if (existing[key] !== undefined || incoming[key] !== undefined) {
      // Cumulative within one response: the later frame is authoritative, never lower.
      merged[key] = Math.max(existing[key] || 0, incoming[key] || 0);
    }
  }
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
  for (const key of OPTIONAL_COUNTERS) {
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
 * OpenAI-compatible wire view: `{ prompt_tokens, completion_tokens, total_tokens }`,
 * plus OpenAI's `prompt_tokens_details.cached_tokens` and
 * `completion_tokens_details.reasoning_tokens` when those were reported.
 * @param {Object|null} usage
 * @returns {{prompt_tokens:number, completion_tokens:number, total_tokens:number,
 *   prompt_tokens_details?:{cached_tokens:number},
 *   completion_tokens_details?:{reasoning_tokens:number}}}
 */
export function usageToOpenAI(usage) {
  const out = {
    prompt_tokens: usage?.promptTokens || 0,
    completion_tokens: usage?.completionTokens || 0,
    total_tokens: usage?.totalTokens || 0
  };
  if (usage?.cacheReadTokens !== undefined) {
    out.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens };
  }
  if (usage?.reasoningTokens !== undefined) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
}
