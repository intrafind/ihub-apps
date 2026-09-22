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
 *    `webSources`. Clarifications (`ask_user`), chat-launched workflows and
 *    skill activation are left out: each has its own UI.
 *  - provider-run web search (Google Search grounding, Anthropic web search):
 *    the queries the provider reports on the grounding metadata
 *    (`webSearchQueries`). Its sources are listed by `GroundingSources`.
 *  - `fetch.*` progress frames: the page a search is reading right now.
 *
 * @module features/chat/toolActivity
 */

/** Tool ids with their own chat UI. */
const HIDDEN_TOOL_IDS = new Set(['activate_skill', 'ask_user']);

/**
 * Same heuristic as the server's `isCitationProducingTool`: search tools,
 * the page extractor and configured source lookups.
 * @param {string} toolId
 * @returns {'search'|'fetch'|'tool'}
 */
export function toolKind(toolId) {
  const id = String(toolId || '').toLowerCase();
  if (id === 'webcontentextractor') return 'fetch';
  if (id.includes('search') || id.startsWith('source_')) return 'search';
  return 'tool';
}

function queryOf(args) {
  if (!args || typeof args !== 'object') return null;
  const query = args.query ?? args.q ?? args.searchQuery ?? args.searchTerm;
  return typeof query === 'string' && query.trim() ? query.trim() : null;
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
    items.push({
      id: tool.callId,
      kind,
      toolId: tool.toolId,
      name: tool.name || tool.toolId,
      status,
      query: kind === 'search' ? queryOf(tool.args) : null,
      url: kind === 'fetch' ? urlOf(tool.args) : null,
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
      toolId: 'webSearch',
      name: 'webSearch',
      // The provider reports no end of its search; once the answer streams,
      // the search is behind it.
      status: finished || run.text ? 'completed' : 'running',
      queries: nativeQueries,
      sources: [],
      error: null,
      durationMs: null
    });
  }

  if (!items.length) return null;

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
