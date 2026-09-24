/**
 * Prompt-cache metrics for the admin usage reports (issue #2508).
 *
 * Definitions, shared by every view:
 * - `promptTokens` is the whole input, cached tokens included, for every
 *   provider (the server normalizes Anthropic/Bedrock, which report the
 *   uncached part only).
 * - **Hit ratio** = cache-read tokens / prompt tokens.
 * - **Write-to-read ratio** = cache-write tokens / cache-read tokens. Above 1
 *   the cache is written more than it is read: on providers that charge extra
 *   for writes (Anthropic, Bedrock) that costs more than not caching at all.
 *
 * A key present in a cache map means the provider *reported* cache usage for
 * it (possibly zero); a missing key means it never did — shown as "not
 * reported", not as 0 %.
 */

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {number|undefined} cacheReadTokens
 * @param {number} promptTokens
 * @returns {number|null} 0..1, or null when there is nothing to divide
 */
export function cacheHitRatio(cacheReadTokens, promptTokens) {
  if (cacheReadTokens === undefined || cacheReadTokens === null) return null;
  if (!promptTokens || promptTokens <= 0) return null;
  return Math.min(1, Math.max(0, cacheReadTokens / promptTokens));
}

/**
 * @param {number|undefined} cacheWriteTokens
 * @param {number|undefined} cacheReadTokens
 * @returns {number|null} writes per read token, or null without reads/writes
 */
export function writeToReadRatio(cacheWriteTokens, cacheReadTokens) {
  if (!cacheWriteTokens) return null;
  if (!cacheReadTokens) return Infinity;
  return cacheWriteTokens / cacheReadTokens;
}

/**
 * Format a 0..1 ratio as a percentage; `—` for null.
 * @param {number|null} ratio
 * @param {string} [locale]
 */
export function formatRatio(ratio, locale) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: ratio > 0 && ratio < 0.1 ? 1 : 0
  }).format(ratio);
}

/**
 * Per-key cache rows for one dimension of the all-time usage aggregate
 * (`usage.json` → `tokens`).
 *
 * @param {Object} tokens - `usage.tokens`
 * @param {'perModel'|'perApp'|'perProvider'|'perUser'} dim
 * @returns {Array<{id:string, promptTokens:number, cacheReadTokens?:number,
 *   cacheWriteTokens?:number, hitRatio:number|null, reported:boolean}>}
 *   sorted by prompt tokens, largest first
 */
export function buildCacheRows(tokens, dim) {
  const prompt = tokens?.prompt?.[dim] || {};
  const read = tokens?.cacheRead?.[dim] || {};
  const write = tokens?.cacheWrite?.[dim] || {};
  const ids = new Set([...Object.keys(prompt), ...Object.keys(read), ...Object.keys(write)]);
  return [...ids]
    .map(id => {
      const reported = id in read || id in write;
      const row = {
        id,
        promptTokens: num(prompt[id]),
        hitRatio: null,
        reported
      };
      if (id in read) row.cacheReadTokens = num(read[id]);
      if (id in write) row.cacheWriteTokens = num(write[id]);
      if (reported) row.hitRatio = cacheHitRatio(row.cacheReadTokens ?? 0, row.promptTokens);
      return row;
    })
    .sort((a, b) => b.promptTokens - a.promptTokens);
}

/**
 * Headline numbers for the KPI tiles. The hit ratio only counts the prompt
 * tokens of models that report cache usage, so models (or history) without
 * any cache reporting don't dilute it.
 *
 * @param {Object} tokens - `usage.tokens`
 * @returns {{cacheReadTokens:number, cacheWriteTokens:number,
 *   reportedPromptTokens:number, hitRatio:number|null,
 *   writeToRead:number|null, reported:boolean}}
 */
export function summarizePromptCache(tokens) {
  const rows = buildCacheRows(tokens, 'perModel').filter(r => r.reported);
  const cacheReadTokens = num(tokens?.cacheRead?.total);
  const cacheWriteTokens = num(tokens?.cacheWrite?.total);
  const reportedPromptTokens = rows.reduce((sum, r) => sum + r.promptTokens, 0);
  const reported = rows.length > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0;
  return {
    cacheReadTokens,
    cacheWriteTokens,
    reportedPromptTokens,
    hitRatio: reported ? cacheHitRatio(cacheReadTokens, reportedPromptTokens) : null,
    writeToRead: writeToReadRatio(cacheWriteTokens, cacheReadTokens),
    reported
  };
}
