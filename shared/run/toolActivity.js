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
 *    document read or a plain call, and where it looked (the web, a project,
 *    iFinder, a connected system), is the server's decision (`activityKind`,
 *    `activityOrigin` on `tool/started`, see server `utils/toolDisplay.js`):
 *    nothing here infers it from the tool id. Clarifications (`ask_user`) and
 *    chat-launched workflows are left out: each has its own UI.
 *  - `tool/progress{skill.activation}` frames: one `skill` row per distinct
 *    skill (`foldSkillItems`), placed among the tool calls by time at its first
 *    activation, saying who brought it in (the user with `/name`, the app, the
 *    model, or an earlier message of the chat; the earliest and most explicit
 *    route wins). The `activate_skill` call itself is not a row.
 *  - `context/compacted` frames: one `compaction` row per compaction, placed
 *    by time — earlier results the server condensed into notes (or shortened,
 *    `lossy`) to free context. The notes are the server's (`digest`).
 *  - provider-run web search (Google Search grounding, Anthropic web search):
 *    the queries the provider reports on the grounding metadata
 *    (`webSearchQueries`). Its sources are listed in the sources panel.
 *  - `fetch.*` progress frames: the page a search is reading right now.
 *  - `run.argStreams` (`tool/progress` phases `args` and `args.ended`): a call
 *    whose arguments the model is still writing. It is merged with its
 *    `run.tools` entry by call id, so one call is one row from `preparing`
 *    through `running` to `completed` / `error`, and the row keeps the place
 *    where it first appeared. What the call is (`activityKind`, `outputKind`,
 *    the title) is the server's decision here as well.
 *  - `run.waiting` (`tool/progress` phase `model.waiting`): the model call has
 *    shown nothing for a while. It is `idle` on the result, so a turn with no
 *    row at all can still say what it is doing.
 *
 * Each item also lists what the call asked for (`details`, see
 * `toolDetails`) and, when it failed, why (`error`).
 *
 * Row `status`: `preparing` (arguments being written, or finished and waiting
 * for the call to start: `ready`), `awaiting` (an approval is pending for it),
 * `running`, `completed`, `error` (failed: the tool failed, or the call was
 * `dropped`, `invalid` or `truncated`, see `errorCode`) and `stopped`.
 *
 * @module shared/run/toolActivity
 */

import { SKILL_ACTIVATORS } from '../runEvents.js';
import { ARGS_OUTCOMES, FAILED_ARGS_OUTCOMES } from './argProgress.js';
import { normalizePlaces } from './places.js';

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

/**
 * Longest argument value shown in full; longer ones are cut. The rest of the
 * value is never kept: a call's arguments can carry a whole document (the
 * markdown of a PDF, the slides of a deck), which the chat does not show.
 */
const DETAIL_VALUE_CHARS = 160;
/** Most values listed for one argument; the rest are counted as `more`. */
const DETAIL_MAX_VALUES = 12;

/** A value as one line of text, or null when it has none. */
function valueText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) || null;
  } catch {
    return null;
  }
}

function cutText(text) {
  return text.length > DETAIL_VALUE_CHARS ? `${text.slice(0, DETAIL_VALUE_CHARS)}…` : text;
}

/**
 * What a call asked for, beyond what its row already shows: every argument
 * the model passed, in its order, e.g. an iFinder search's `filter`, `sort`,
 * `maxResults` and `returnFacets`, or the `facet` a facet lookup enumerated.
 * An array argument keeps one value per distinct element as it is shown, so
 * each filter reads on its own and two long values that read the same once cut
 * are one value.
 *
 * @param {Object} args - the call's arguments
 * @param {string[]} shown - argument names the row already shows
 * @returns {Array<{name: string, values: Array<{text: string}>, more: number}>}
 */
export function toolDetails(args, shown = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const details = [];
  for (const [name, value] of Object.entries(args)) {
    if (shown.includes(name) || value === null || value === undefined) continue;
    const seen = new Set();
    const values = [];
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = valueText(item);
      if (!text) continue;
      const shown = cutText(text);
      if (seen.has(shown)) continue;
      seen.add(shown);
      values.push({ text: shown });
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
const ROW_ARG_NAMES = new Set(Object.values(ROW_ARGS).flat());
/** Most elements of an array argument sent; enough for the values a row lists. */
const PREVIEW_MAX_ELEMENTS = 100;

function previewValue(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cutText(value);
  const text = valueText(value);
  if (text === null) return undefined;
  return text.length > DETAIL_VALUE_CHARS ? cutText(text) : value;
}

/**
 * A call's arguments as the chat needs them (`tool/started`), not as the model
 * wrote them: what the row shows (query, link, document id) whole — a link is
 * opened from the row, so it is never cut — every other
 * value cut to what {@link toolDetails} lists. A long value — the markdown of a
 * PDF, the slides of a deck, the HTML of a web artifact — is cut to its first
 * {@link DETAIL_VALUE_CHARS} characters, so the browser is never sent a
 * document it will not show. {@link toolDetails} of the preview lists the same
 * values as of the arguments themselves; only an array argument with more
 * than {@link PREVIEW_MAX_ELEMENTS} elements counts fewer as `more`.
 *
 * @param {unknown} args - the arguments the model passed
 * @returns {unknown} the preview; a value that is not an object is cut like an argument
 */
export function previewToolArgs(args) {
  if (args === null || args === undefined) return args;
  if (typeof args !== 'object' || Array.isArray(args)) return previewValue(args);
  const out = {};
  for (const [name, value] of Object.entries(args)) {
    if (ROW_ARG_NAMES.has(name) && typeof value === 'string') {
      out[name] = value;
    } else if (Array.isArray(value)) {
      out[name] = value
        .slice(0, PREVIEW_MAX_ELEMENTS)
        .map(previewValue)
        .filter(item => item !== undefined);
    } else {
      const preview = previewValue(value);
      if (preview !== undefined) out[name] = preview;
    }
  }
  return out;
}

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
  let metadata = stepGrounding;
  if (!stepGrounding.length) metadata = run.grounding ? [run.grounding] : [];
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
        activatedBy: SKILL_ACTIVATORS.includes(entry.data?.activatedBy)
          ? entry.data.activatedBy
          : null,
        status: 'completed',
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
 * One row per compaction of the run (`context/compacted`, #3819): earlier
 * results condensed into notes, or shortened when that was not possible
 * (`lossy`). What happened, how many results and of which kind, and the
 * notes themselves are the server's; nothing is worked out here.
 */
function compactionRows(run, finished) {
  const rows = [];
  for (const entry of run.compactions || []) {
    if (!entry?.compactionId) continue;
    let status = entry.status === 'completed' ? 'completed' : 'running';
    // A turn that ended while the notes were being written never got them.
    if (status === 'running' && finished) status = 'stopped';
    rows.push({
      at: Date.parse(entry.at),
      item: {
        id: `compaction-${entry.compactionId}`,
        kind: 'compaction',
        toolId: null,
        name: '',
        status,
        trigger: entry.trigger || 'proactive',
        strategy: entry.strategy || null,
        lossy: entry.lossy === true,
        fallbackReason: entry.fallbackReason || null,
        wrapUp: entry.wrapUp === true,
        itemsSummarised: Number.isInteger(entry.itemsSummarised) ? entry.itemsSummarised : 0,
        kinds: entry.kinds || null,
        tokensBefore: Number.isInteger(entry.tokensBefore) ? entry.tokensBefore : null,
        tokensAfter: Number.isInteger(entry.tokensAfter) ? entry.tokensAfter : null,
        facts: Number.isInteger(entry.facts) ? entry.facts : null,
        digest: typeof entry.digest === 'string' ? entry.digest : null,
        digestTruncated: entry.digestTruncated === true,
        step: Number.isInteger(entry.step) ? entry.step : null,
        details: [],
        sources: [],
        error: null,
        durationMs: Number.isInteger(entry.durationMs) ? entry.durationMs : null
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
  // Skills arrive in order, so each goes after the one before it: skills
  // announced together (every skill in force when the turn starts) keep their order.
  let from = 0;
  for (const skill of skills) {
    let index = -1;
    if (!Number.isNaN(skill.at)) {
      for (let i = from; i < rows.length; i++) {
        if (!Number.isNaN(rows[i].at) && rows[i].at >= skill.at) {
          index = i;
          break;
        }
      }
    }
    if (index < 0) {
      rows.push(skill);
      from = rows.length;
    } else {
      rows.splice(index, 0, skill);
      from = index + 1;
    }
  }
  return rows;
}

/**
 * One row per distinct skill, at its first position: a skill the model loads
 * twice, or one that came in by two routes (`/name`, then the model), is one
 * row saying the earliest and most explicit route (`SKILL_ACTIVATORS`: user,
 * app, model, chat). Rows of stored chats may repeat a skill; this folds those
 * too. Every other row is kept as it is.
 *
 * @param {Array<Object>} items - rows of `buildToolActivity`
 * @returns {Array<Object>}
 */
export function foldSkillItems(items) {
  const first = new Map();
  const out = [];
  for (const item of items) {
    if (item.kind !== 'skill') {
      out.push(item);
      continue;
    }
    const key = item.skillId || item.name;
    const known = first.get(key);
    if (!known) {
      const copy = { ...item };
      first.set(key, copy);
      out.push(copy);
      continue;
    }
    const rank = by => (SKILL_ACTIVATORS.includes(by) ? SKILL_ACTIVATORS.indexOf(by) : Infinity);
    if (rank(item.activatedBy) < rank(known.activatedBy)) known.activatedBy = item.activatedBy;
  }
  return out;
}

/**
 * The activity of an answer saved before skills were rows of it: its
 * `activeSkills` (the set the header chip used to show) become name-only skill
 * rows, first in the list, so the skill is still shown once, in the activity
 * block, with the reason when the record names who brought it in. An activity
 * that has skill rows already is left as it is.
 *
 * @param {{items?: Object[], reading?: string|null}|null|undefined} activity
 * @param {Array<{name?: string, id?: string, activatedBy?: string}>|undefined} activeSkills
 * @returns {Object|null|undefined} the activity, with skill rows added when it had none
 */
export function withStoredSkills(activity, activeSkills) {
  const skills = Array.isArray(activeSkills) ? activeSkills.filter(skill => skill?.name) : [];
  if (!skills.length) return activity;
  const items = activity?.items || [];
  if (items.some(item => item.kind === 'skill')) return activity;
  const rows = skills.map((skill, index) => ({
    id: `skill-stored-${index}`,
    kind: 'skill',
    toolId: 'activate_skill',
    name: skill.name,
    skillId: typeof skill.id === 'string' ? skill.id : null,
    activatedBy: SKILL_ACTIVATORS.includes(skill.activatedBy) ? skill.activatedBy : null,
    status: 'completed',
    details: [],
    sources: [],
    error: null,
    durationMs: null
  }));
  return { reading: null, ...activity, items: foldSkillItems([...rows, ...items]) };
}

/** Whether an interaction of the run waits for the user to decide about this call. */
function hasPendingApproval(run, callId) {
  return Object.values(run.interactions || {}).some(
    interaction => interaction?.status === 'pending' && interaction.source?.toolCallId === callId
  );
}

/**
 * The status of a row. A call that started is what its tool record says; one
 * that did not is what its argument stream says.
 *
 * A call the turn never saw finish (stopped, failed elsewhere) is not still
 * running, and one that never got to run is not still being prepared, once the
 * turn is over.
 */
function statusOf(run, tool, stream, finished) {
  if (tool) return tool.status === 'running' && finished ? 'stopped' : tool.status;
  const outcome = stream.ended?.outcome;
  if (FAILED_ARGS_OUTCOMES.has(outcome)) return 'error';
  if (outcome === ARGS_OUTCOMES.ABORTED) return 'stopped';
  if (outcome === ARGS_OUTCOMES.READY && hasPendingApproval(run, stream.callId)) return 'awaiting';
  return finished ? 'stopped' : 'preparing';
}

/** The fields a row takes from its argument stream (none for a call that never announced itself). */
function streamFields(stream, status) {
  const outcome = stream.ended?.outcome;
  return {
    // What the server called the thing the call makes (`utils/toolDisplay`), or null.
    outputKind: stream.outputKind,
    // 2 or more when the same tool was announced before in this turn.
    occurrence: stream.occurrence,
    argBytes: stream.argBytes,
    // Server clock reading of the newest frame, the client clock when it came
    // in, and the reading at which the size last grew: the stopwatch and the
    // stall caption are derived from these (features/chat/activityTiming.js).
    elapsedMs: stream.elapsedMs,
    receivedAt: stream.receivedAt,
    grewAtMs: stream.grewAtMs,
    // The first moment a row for it could have been painted, and the moment
    // the arguments ended; the client holds the first paint back briefly.
    firstReceivedAt: stream.firstReceivedAt,
    endedReceivedAt: stream.ended?.receivedAt ?? null,
    // The arguments were complete when the stream ended; with the call not
    // started yet, the row is `ready`. A call stopped after that was not run,
    // one stopped before it was not finished.
    argsComplete: outcome === ARGS_OUTCOMES.READY,
    ready: status === 'preparing' && outcome === ARGS_OUTCOMES.READY,
    errorCode: FAILED_ARGS_OUTCOMES.has(outcome) ? outcome : null
  };
}

/**
 * One row per call, in the order the calls first appeared: a call that
 * announced its arguments takes the place of its first `args` frame, one that
 * did not takes the place of its `tool/started`. `tool/started` moves a call to
 * the end of `run.tools`, so the place of an announced call comes from the
 * number of calls that had started when it was announced.
 *
 * @returns {Array<{tool: Object|null, stream: Object|null}>}
 */
function callsInOrder(run) {
  const streams = (run.argOrder || []).map(id => run.argStreams[id]).filter(Boolean);
  const tools = run.tools || [];
  const placed = new Set();
  const calls = [];
  const place = (stream, tool) => {
    const callId = stream?.callId ?? tool.callId;
    if (placed.has(callId)) return;
    placed.add(callId);
    calls.push({ stream, tool });
  };
  const toolOf = new Map(tools.map(tool => [tool.callId, tool]));
  const placeStreamsUpTo = count => {
    for (const stream of streams) {
      if (stream.afterTools <= count) place(stream, toolOf.get(stream.callId) || null);
    }
  };
  tools.forEach((tool, index) => {
    placeStreamsUpTo(index);
    place(run.argStreams?.[tool.callId] || null, tool);
  });
  placeStreamsUpTo(Infinity);
  return calls;
}

/**
 * The row of one call, with the time it first appeared (for placing skill
 * rows among the calls); null for a call with its own UI or one the server
 * runs elsewhere (clarifications, workflows launched from the chat).
 */
function callRow(run, { tool, stream }, finished) {
  const toolId = tool?.toolId ?? stream.toolId;
  if ((tool?.execution && tool.execution !== 'server') || HIDDEN_TOOL_IDS.has(toolId)) {
    return null;
  }
  // The server decides the row (`utils/toolDisplay`); a call it said nothing
  // about is a plain call.
  const activityKind = tool?.activityKind || stream?.activityKind;
  const kind = ['search', 'fetch'].includes(activityKind) ? activityKind : 'tool';
  const status = statusOf(run, tool, stream, finished);
  const args = tool?.args;
  const query = kind === 'search' ? queryOf(args) : null;
  const url = kind === 'fetch' ? urlOf(args) : null;
  const documentId = kind === 'fetch' ? documentIdOf(args) : null;
  const title = tool?.title || stream?.title || null;
  return {
    // A call that announced itself appeared when its first frame did.
    at: Date.parse(stream?.firstSeenAt ?? tool?.startedAt),
    item: {
      id: tool?.callId ?? stream.callId,
      kind,
      toolId,
      // The action as the user reads it ("Search people"), else the id the model used.
      name: title || tool?.name || stream?.name || toolId,
      titled: Boolean(title),
      // The integration, MCP server or agent it ran against ("Munich AD").
      integration: tool?.integration || stream?.integration || null,
      status,
      // Where the server says the call looked (`activityOrigin`): never worked
      // out here from the tool id or the provider. null = not said.
      origin: tool?.activityOrigin || stream?.activityOrigin || null,
      // The server says the hits are on the open web: a share keeps them.
      publicHits: tool?.publicHits === true ? true : undefined,
      // What the server declared the call came to: the hits of a search (0
      // included), whether a read delivered text (`opened`, `empty`). null =
      // not declared, never worked out from `sources`.
      resultCount: kind === 'search' ? (tool?.resultCount ?? null) : null,
      readOutcome: kind === 'fetch' ? (tool?.readOutcome ?? null) : null,
      // Where the server says the call looked (a project, a search profile), by
      // name: never worked out here. Empty = not said.
      places: kind === 'search' || kind === 'fetch' ? normalizePlaces(tool?.places) : [],
      query,
      url,
      documentId,
      details: toolDetails(args, shownArgs(args, { query, url, documentId })),
      sources: Array.isArray(tool?.sources) ? tool.sources : [],
      error: tool?.error?.message || null,
      // A page read the per-turn cap (`websearch.maxPageReads`) refused.
      limitReached: kind === 'fetch' && tool?.result?.limitReached === true,
      durationMs: tool?.durationMs ?? null,
      // Whether the call itself started (the row has its arguments).
      started: Boolean(tool),
      ...(stream ? streamFields(stream, status) : {})
    }
  };
}

/** The row of a provider-run web search (no tool call of ours), or null without queries. */
function nativeSearchRow(run, finished) {
  const queries = nativeSearchQueries(run);
  if (!queries.length) return null;
  return {
    id: 'native-web-search',
    kind: 'search',
    native: true,
    // The provider's own search is the web: the grounding frame says so.
    origin: 'web',
    resultCount: null,
    readOutcome: null,
    places: [],
    toolId: 'webSearch',
    name: 'webSearch',
    // The provider reports no end of its search; once the answer streams,
    // the search is behind it.
    status: finished || run.text ? 'completed' : 'running',
    queries,
    details: [],
    sources: [],
    error: null,
    durationMs: null
  };
}

/**
 * The idle line: the model call has shown nothing for a while. Only a turn
 * that is still going can be silent. `reasoning` is the server's statement,
 * never inferred here.
 */
function idleOf(run, finished) {
  if (finished || run.status !== 'running') return null;
  // Before the turn starts: the outdated project documents it waits for (#3622).
  if (run.knowledgeRefresh && !run.waiting) {
    return {
      kind: 'refreshing',
      total: run.knowledgeRefresh.total,
      done: run.knowledgeRefresh.done,
      elapsedMs: 0,
      receivedAt: run.knowledgeRefresh.receivedAt,
      step: null
    };
  }
  if (!run.waiting) return null;
  return {
    kind: run.waiting.reasoning ? 'thinking' : 'waiting',
    elapsedMs: run.waiting.elapsedMs,
    receivedAt: run.waiting.receivedAt,
    step: run.waiting.step
  };
}

/**
 * The page being fetched right now: the newest fetch frame, while a search or
 * fetch is still in flight.
 */
function readingOf(run, items, finished) {
  if (finished || !items.some(item => item.status === 'running' && item.kind !== 'tool')) {
    return null;
  }
  const progress = run.progress || [];
  for (let i = progress.length - 1; i >= 0; i--) {
    const entry = progress[i];
    if (entry.kind === 'tool/progress' && String(entry.phase || '').startsWith('fetch.')) {
      return typeof entry.data?.url === 'string' ? entry.data.url : null;
    }
  }
  return null;
}

/**
 * @param {Object|null} run - RunState from the run reducer
 * @returns {{items: Array<Object>, reading: string|null, idle?: Object, answering?: boolean}|null}
 *   null when the turn used no tools and has no idle line. `idle`
 *   (`{kind: 'thinking'|'waiting'|'refreshing', elapsedMs, receivedAt, step}`,
 *   with `total` and `done` for `refreshing`) and
 *   `answering` are only on a turn that is still going: the model has been
 *   silent for a while, and answer text has started.
 */
export function buildToolActivity(run) {
  if (!run) return null;
  const finished = ['completed', 'aborted', 'error', 'budget_exhausted'].includes(run.status);
  const toolRows = callsInOrder(run)
    .map(call => callRow(run, call, finished))
    .filter(Boolean);
  const placed = mergeSkillRows(
    mergeSkillRows(toolRows, skillRows(run)),
    compactionRows(run, finished)
  );
  const items = foldSkillItems(placed.map(row => row.item));
  const native = nativeSearchRow(run, finished);
  if (native) items.push(native);

  const idle = idleOf(run, finished);
  if (!items.length) return idle ? { items, reading: null, idle } : null;
  resolveDocuments(items);

  return {
    items,
    reading: readingOf(run, items, finished),
    ...(idle ? { idle } : {}),
    ...(!finished && run.text ? { answering: true } : {})
  };
}
