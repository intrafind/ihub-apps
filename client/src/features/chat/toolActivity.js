/**
 * What a chat turn did before it answered — the searches it ran, the pages
 * those searches found and read, and the other tools it called — as one list
 * the chat shows beside the answer.
 *
 *   buildToolActivity(run) → { items, reading } | null
 *
 * Sources of the list:
 *  - `run.tools` (`tool/started` / `tool/completed`): every server-executed
 *    tool call, with the pages a search or fetch tool reported on
 *    `webSources`. A search is scoped to the web or to the organisation's
 *    documents (iFinder, configured sources), see `searchScope`. Clarifications (`ask_user`), chat-launched workflows and
 *    skill activation are left out: each has its own UI.
 *  - provider-run web search (Google Search grounding, Anthropic web search):
 *    the queries the provider reports on the grounding metadata
 *    (`webSearchQueries`). Its sources are listed by `GroundingSources`.
 *  - `fetch.*` progress frames: the page a search is reading right now.
 *
 * Each item also lists what the call asked for (`details`, see
 * `toolDetails`) and, when it failed, why (`error`).
 *
 * @module features/chat/toolActivity
 */

/** Tool ids with their own chat UI. */
const HIDDEN_TOOL_IDS = new Set(['activate_skill', 'ask_user']);

/**
 * Same heuristic as the server's `isCitationProducingTool`: search tools,
 * the page extractor and configured source lookups; reading an iFinder
 * document is a fetch too.
 * @param {string} toolId
 * @returns {'search'|'fetch'|'tool'}
 */
export function toolKind(toolId) {
  const id = String(toolId || '').toLowerCase();
  if (id === 'webcontentextractor' || id === 'ifinder_getcontent') return 'fetch';
  if (id.includes('search') || id.startsWith('source_')) return 'search';
  return 'tool';
}

/**
 * Where a search or fetch tool looks: the organisation's own documents
 * (iFinder, a configured source) or the public web. Only the latter is a web
 * search.
 * @param {string} toolId
 * @returns {'documents'|'web'}
 */
export function searchScope(toolId) {
  const id = String(toolId || '').toLowerCase();
  return id.startsWith('ifinder') || id.startsWith('source_') ? 'documents' : 'web';
}

function queryOf(args) {
  if (!args || typeof args !== 'object') return null;
  const query = args.query ?? args.q ?? args.searchQuery ?? args.searchTerm;
  return typeof query === 'string' && query.trim() ? query.trim() : null;
}

function documentIdOf(args) {
  const id = args && typeof args === 'object' ? args.documentId : null;
  return typeof id === 'string' && id ? id : null;
}

/** Key of a source: its URL, or its iFinder document id when it has no link. */
export function sourceKey(source) {
  return source.documentId ? `doc:${source.documentId}` : source.url;
}

/**
 * iFinder documents across the turn: which document each `iFinder_getContent`
 * read (title and link, from its own result or from the search hit that found
 * it), and the search hits marked read once their document was read.
 */
function resolveDocuments(items) {
  const known = new Map();
  for (const item of items) {
    for (const source of item.sources) {
      if (!source.documentId) continue;
      known.set(source.documentId, { ...known.get(source.documentId), ...source });
    }
  }
  const read = new Set();
  for (const item of items) {
    if (item.kind !== 'fetch' || !item.documentId) continue;
    const doc = known.get(item.documentId);
    item.url = item.url || doc?.url || null;
    item.title = doc?.title || null;
    if (item.status === 'completed') read.add(item.documentId);
  }
  if (!read.size) return;
  for (const item of items) {
    if (item.kind !== 'search') continue;
    item.sources = item.sources.map(source =>
      source.documentId && read.has(source.documentId) ? { ...source, read: true } : source
    );
  }
}

/** Longest argument value shown in full; longer ones are cut, the full text kept for a tooltip. */
const DETAIL_VALUE_CHARS = 160;
/** Most values listed for one argument; the rest are counted as `more`. */
const DETAIL_MAX_VALUES = 12;

function detailValue(value) {
  let text;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  if (!text) return null;
  return text.length > DETAIL_VALUE_CHARS
    ? { text: `${text.slice(0, DETAIL_VALUE_CHARS)}…`, full: text }
    : { text };
}

/**
 * What a call asked for, beyond what its row already shows: every argument
 * the model passed, in its order, e.g. an iFinder search's `filter`, `sort`,
 * `maxResults` and `returnFacets`, or the `facet` a facet lookup enumerated.
 * An array argument keeps one value per distinct element, so each filter
 * reads on its own.
 *
 * @param {Object} args - the call's arguments
 * @param {string[]} shown - argument names the row already shows
 * @returns {Array<{name: string, values: Array<{text: string, full?: string}>, more: number}>}
 */
export function toolDetails(args, shown = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const details = [];
  for (const [name, value] of Object.entries(args)) {
    if (shown.includes(name) || value === null || value === undefined) continue;
    const values = [];
    for (const item of Array.isArray(value) ? value : [value]) {
      const detail = detailValue(item);
      if (
        detail &&
        !values.some(seen => (seen.full ?? seen.text) === (detail.full ?? detail.text))
      ) {
        values.push(detail);
      }
    }
    if (values.length) {
      details.push({
        name,
        values: values.slice(0, DETAIL_MAX_VALUES),
        more: Math.max(0, values.length - DETAIL_MAX_VALUES)
      });
    }
  }
  return details;
}

/** Argument names each value the row shows can come from — see `queryOf`, `urlOf`, `documentIdOf`. */
const ROW_ARGS = {
  query: ['query', 'q', 'searchQuery', 'searchTerm'],
  url: ['url', 'uri', 'link'],
  documentId: ['documentId']
};

/** Names of the arguments whose value the row already shows. */
function shownArgs(args, row) {
  if (!args || typeof args !== 'object') return [];
  return Object.entries(ROW_ARGS).flatMap(([field, names]) =>
    row[field]
      ? names.filter(name => typeof args[name] === 'string' && args[name].trim() === row[field])
      : []
  );
}

function urlOf(args) {
  if (!args || typeof args !== 'object') return null;
  const url = args.url ?? args.uri ?? args.link;
  return typeof url === 'string' && url ? url : null;
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Queries of a provider-run web search. Completed steps carry the merged
 * grounding metadata of the step; while streaming, the progress frames the
 * reducer merged stand in. Google repeats the list on every chunk, so the
 * queries are deduplicated.
 */
function nativeSearchQueries(run) {
  const stepGrounding = Object.values(run.steps || {})
    .map(step => step.groundingMetadata)
    .filter(Boolean);
  const metadata = stepGrounding.length ? stepGrounding : run.grounding ? [run.grounding] : [];
  return uniqueStrings(
    metadata.flatMap(m => (Array.isArray(m?.webSearchQueries) ? m.webSearchQueries : []))
  );
}

/**
 * @param {Object|null} run - RunState from the run reducer
 * @returns {{items: Array<Object>, reading: string|null}|null} null when the turn used no tools
 */
export function buildToolActivity(run) {
  if (!run) return null;
  const finished = ['completed', 'aborted', 'error', 'budget_exhausted'].includes(run.status);
  const items = [];

  for (const tool of run.tools || []) {
    if ((tool.execution && tool.execution !== 'server') || HIDDEN_TOOL_IDS.has(tool.toolId)) {
      continue;
    }
    const kind = toolKind(tool.toolId);
    // A call the turn never saw finish (stopped, failed elsewhere) is not
    // still running once the turn is over.
    const status = tool.status === 'running' && finished ? 'stopped' : tool.status;
    const query = kind === 'search' ? queryOf(tool.args) : null;
    const url = kind === 'fetch' ? urlOf(tool.args) : null;
    const documentId = kind === 'fetch' ? documentIdOf(tool.args) : null;
    items.push({
      id: tool.callId,
      kind,
      toolId: tool.toolId,
      name: tool.name || tool.toolId,
      status,
      scope: kind === 'tool' ? null : searchScope(tool.toolId),
      query,
      url,
      documentId,
      details: toolDetails(tool.args, shownArgs(tool.args, { query, url, documentId })),
      sources: Array.isArray(tool.webSources) ? tool.webSources : [],
      error: tool.error?.message || null,
      durationMs: tool.durationMs ?? null
    });
  }

  const nativeQueries = nativeSearchQueries(run);
  if (nativeQueries.length) {
    items.push({
      id: 'native-web-search',
      kind: 'search',
      native: true,
      scope: 'web',
      toolId: 'webSearch',
      name: 'webSearch',
      // The provider reports no end of its search; once the answer streams,
      // the search is behind it.
      status: finished || run.text ? 'completed' : 'running',
      queries: nativeQueries,
      details: [],
      sources: [],
      error: null,
      durationMs: null
    });
  }

  if (!items.length) return null;
  resolveDocuments(items);

  // The page being fetched right now: the newest fetch frame, while a search
  // or fetch is still in flight.
  let reading = null;
  if (!finished && items.some(item => item.status === 'running' && item.kind !== 'tool')) {
    for (let i = (run.progress || []).length - 1; i >= 0; i--) {
      const entry = run.progress[i];
      if (entry.kind === 'tool/progress' && String(entry.phase || '').startsWith('fetch.')) {
        reading = typeof entry.data?.url === 'string' ? entry.data.url : null;
        break;
      }
    }
  }

  return { items, reading };
}
