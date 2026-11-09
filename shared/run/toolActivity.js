// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a chat turn did before it answered — the searches it ran, the pages
 * those searches found and read, and the other tools it called — as one list
 * the chat shows beside the answer.
 *
 *   buildToolActivity(run) → { items, reading } | null
 *
 * Sources of the list:
 *  - `run.tools` (`tool/started` / `tool/completed`): every server-executed
 *    tool call, with the sources it reported (`sources/added` with its
 *    callId, see `shared/sources`). Whether a call is a search, a page or
 *    document read or a plain call, and whether it looked at the web or the
 *    organisation's documents, is the server's decision (`activityKind`,
 *    `activityScope` on `tool/started`, see server `utils/toolDisplay.js`):
 *    nothing here infers it from the tool id. Clarifications (`ask_user`) and
 *    chat-launched workflows are left out: each has its own UI.
 *  - `tool/progress{skill.activation}` frames: one `skill` row per activation,
 *    placed among the tool calls by time, saying who activated the skill (the
 *    user with `/name`, or the model). The `activate_skill` call itself is not a
 *    row, so a skill the model loads twice shows twice here but only once in
 *    `run.skills`, the set the message header lists.
 *  - provider-run web search (Google Search grounding, Anthropic web search):
 *    the queries the provider reports on the grounding metadata
 *    (`webSearchQueries`). Its sources are listed in the sources panel.
 *  - `fetch.*` progress frames: the page a search is reading right now.
 *
 * Each item also lists what the call asked for (`details`, see
 * `toolDetails`) and, when it failed, why (`error`).
 *
 * @module shared/run/toolActivity
 */

/**
 * Tool ids with their own chat UI. `activate_skill` is shown as a `skill` row
 * built from its `skill.activation` frame, which also covers a skill the user
 * activated and a call that was refused (no frame, so no row).
 */
const HIDDEN_TOOL_IDS = new Set(['activate_skill', 'ask_user']);

function queryOf(args) {
  if (!args || typeof args !== 'object') return null;
  const query = args.query ?? args.q ?? args.searchQuery ?? args.searchTerm;
  return typeof query === 'string' && query.trim() ? query.trim() : null;
}

function documentIdOf(args) {
  const id = args && typeof args === 'object' ? args.documentId : null;
  return typeof id === 'string' && id ? id : null;
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
      const id = source.ref?.id;
      if (id) known.set(id, { ...known.get(id), ...source });
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
      source.ref && read.has(source.ref.id) ? { ...source, read: { ok: true } } : source
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
 * One row per `skill.activation` frame of the run, in the order they arrived,
 * with the time of the frame for placing the row among the tool calls.
 */
function skillRows(run) {
  const rows = [];
  for (const [index, entry] of (run.progress || []).entries()) {
    if (entry.kind !== 'tool/progress' || entry.phase !== 'skill.activation') continue;
    const name = entry.data?.skillName || entry.message;
    if (!name) continue;
    rows.push({
      at: Date.parse(entry.at),
      item: {
        id: `skill-${Number.isInteger(entry.seq) ? entry.seq : index}`,
        kind: 'skill',
        toolId: 'activate_skill',
        name,
        skillId: typeof entry.data?.skillId === 'string' ? entry.data.skillId : null,
        activatedBy:
          entry.data?.activatedBy === 'user' || entry.data?.activatedBy === 'model'
            ? entry.data.activatedBy
            : null,
        status: 'completed',
        scope: null,
        details: [],
        sources: [],
        error: null,
        durationMs: null
      }
    });
  }
  return rows;
}

/**
 * Put the skill rows among the tool rows by time: each before the first tool
 * call that started at or after the skill was activated (the user's `/name` precedes
 * every call of the turn; a model activation follows its own `activate_skill`
 * call, which has no row). A row with no usable time goes last.
 */
function mergeSkillRows(toolRows, skills) {
  const rows = [...toolRows];
  for (const skill of skills) {
    const index = Number.isNaN(skill.at)
      ? -1
      : rows.findIndex(row => !Number.isNaN(row.at) && row.at >= skill.at);
    if (index < 0) rows.push(skill);
    else rows.splice(index, 0, skill);
  }
  return rows;
}

/**
 * @param {Object|null} run - RunState from the run reducer
 * @returns {{items: Array<Object>, reading: string|null}|null} null when the turn used no tools
 */
export function buildToolActivity(run) {
  if (!run) return null;
  const finished = ['completed', 'aborted', 'error', 'budget_exhausted'].includes(run.status);
  const toolRows = [];

  for (const tool of run.tools || []) {
    if ((tool.execution && tool.execution !== 'server') || HIDDEN_TOOL_IDS.has(tool.toolId)) {
      continue;
    }
    // The server decides the row (`utils/toolDisplay`); a call it said nothing
    // about is a plain call.
    const kind = ['search', 'fetch'].includes(tool.activityKind) ? tool.activityKind : 'tool';
    // A call the turn never saw finish (stopped, failed elsewhere) is not
    // still running once the turn is over.
    const status = tool.status === 'running' && finished ? 'stopped' : tool.status;
    const query = kind === 'search' ? queryOf(tool.args) : null;
    const url = kind === 'fetch' ? urlOf(tool.args) : null;
    const documentId = kind === 'fetch' ? documentIdOf(tool.args) : null;
    toolRows.push({
      at: Date.parse(tool.startedAt),
      item: {
        id: tool.callId,
        kind,
        toolId: tool.toolId,
        // The action as the user reads it ("Search people"), else the id the model used.
        name: tool.title || tool.name || tool.toolId,
        titled: Boolean(tool.title),
        // The integration, MCP server or agent it ran against ("Munich AD").
        integration: tool.integration || null,
        status,
        // The model is still writing the call: how much of it so far.
        writtenChars: tool.preparing && status === 'running' ? tool.writtenChars || 0 : 0,
        scope: kind === 'tool' ? null : tool.activityScope === 'documents' ? 'documents' : 'web',
        query,
        url,
        documentId,
        details: toolDetails(tool.args, shownArgs(tool.args, { query, url, documentId })),
        sources: Array.isArray(tool.sources) ? tool.sources : [],
        error: tool.error?.message || null,
        // A page read the per-turn cap (`websearch.maxPageReads`) refused.
        limitReached: kind === 'fetch' && tool.result?.limitReached === true,
        durationMs: tool.durationMs ?? null
      }
    });
  }
  const items = mergeSkillRows(toolRows, skillRows(run)).map(row => row.item);

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
