/**
 * Citation helpers shared across the agent workflow executors.
 *
 * The citations ledger (`state.data._citations`) is an append-only list of
 * `{ url, title, snippet, toolId, taskId, query, capturedAt }` records produced
 * by search/extract tools. Two problems motivated these helpers:
 *
 *  1. Multiplicative duplication. `childInitial` copies the parent's `_citations`
 *     into each review round's child sub-workflow, and the planner bubble-up
 *     CONCATENATES the child's citations (= that copy + any new ones) back onto
 *     the parent — so the whole ledger is duplicated every round (observed: a
 *     URL stored 2^rounds times). Dedup at bubble-up collapses this.
 *  2. Trivial URL variants (trailing slash, `www.`, http/https, `#fragment`,
 *     tracking query params) of the SAME resource were kept as separate
 *     citations. Normalizing the dedup KEY collapses them while preserving the
 *     original URL for display.
 *
 * @module services/workflow/citationUtils
 */

// Query params that never identify a distinct resource — drop them from the key.
const TRACKING_PARAM = /^(utm_|fbclid|gclid|gbraid|wbraid|mc_|ref$|ref_|spm$|igshid$|si$)/i;

/**
 * Produce a normalized dedup KEY for a citation URL. The key is NOT meant for
 * display — it deliberately lowercases the host, drops `www.`, the fragment,
 * tracking params, the trailing slash, and folds http/https together so that
 * variants of the same resource map to one key. Real, identifying query params
 * are preserved (and sorted for stability). Different paths are never merged.
 *
 * @param {string} url
 * @returns {string} normalized key, or '' when the input isn't a usable string
 */
export function normalizeCitationUrl(url) {
  if (typeof url !== 'string') return '';
  const raw = url.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const qs = u.searchParams.toString();
    const port = u.port ? `:${u.port}` : '';
    // Fold protocol so http/https variants share a key.
    return `${host}${port}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    // Not a parseable absolute URL — apply a light textual normalization.
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/[#?].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

/**
 * De-duplicate a citations array by normalized URL, keeping the FIRST occurrence
 * (so the earliest-captured title/snippet and the stable ordering are
 * preserved). Entries without a string `url` are dropped.
 *
 * @param {Array<Object>} citations
 * @returns {Array<Object>} deduped list in first-seen order
 */
export function dedupeCitations(citations) {
  if (!Array.isArray(citations)) return [];
  const seen = new Set();
  const out = [];
  for (const c of citations) {
    if (!c || typeof c.url !== 'string') continue;
    const key = normalizeCitationUrl(c.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
