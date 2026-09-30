/**
 * What a chat turn did — the searches it ran, the documents and pages they
 * found, the other tools it called, the workflow steps it went through — kept
 * with the answer, so a user who comes back to the chat can see it.
 *
 * Live, the chat client folds a turn's SSE v2 frames into run state and shows
 * that activity beside the answer; none of it used to reach the store, so a
 * reopened chat showed the answer text and nothing of how it came about. This
 * module folds the same frames on the server, with the same reducer
 * (`shared/run/runReducer.js`) and the same projection
 * (`shared/run/runActivity.js`), and hands the result to the materializer,
 * which stores it on the answer as `activity`.
 *
 * Only runs someone asked to record are folded — the turns of a persisted chat
 * ({@link recordRunActivity}) and the workflow runs a tool starts inside them
 * (their `run/started` names the recorded run as parent). The tap sits on
 * `RunStreamEmitter.emit`, which every frame of a run passes through whether
 * or not a browser is connected, so a turn nobody watched is recorded too.
 *
 * The answer text, reasoning and pictures are not folded — the transcript
 * already stores them — and neither are the frames that only drive a live
 * spinner. What is folded is bounded again before it is stored
 * ({@link boundStoredActivity}): a chat document is read back whole every time
 * the chat opens.
 *
 * A run whose process died never reaches the materializer this way; its
 * activity is rebuilt from the ledger instead ({@link rebuildRunActivity}).
 *
 * @module services/chat/runActivity
 */
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import {
  createStreamState,
  reduceRunEvent,
  reduceRunEvents
} from '../../../shared/run/runReducer.js';
import { buildRunActivity } from '../../../shared/run/runActivity.js';
import { observeEmittedEnvelopes, projectLedgerEvent } from '../loop/RunStream.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'runActivity';

/**
 * Runs recorded at once. A recording is dropped when its answer is stored; the
 * cap only matters for turns that never end in this process, which the
 * oldest-first eviction then forgets.
 */
export const MAX_RECORDINGS = 2000;

/** Tool-progress phases that are provenance rather than a live spinner. */
const RECORDED_PROGRESS_PHASES = new Set(['search.status', 'skill.activation', 'grounding']);

/** Stored bounds — see {@link boundStoredActivity}. */
export const MAX_STORED_TOOL_ITEMS = 100;
export const MAX_STORED_ITEM_SOURCES = 50;
export const MAX_STORED_WORKFLOW_STEPS = 200;
export const MAX_STORED_LIST = 50;
export const MAX_STORED_ACTIVITY_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 2000;
const MAX_LABEL_CHARS = 500;
const MAX_DETAILS = 20;
const MAX_DETAIL_VALUES = 12;

/**
 * runId → `{ state, children }`: the folded frames of a recorded run and the
 * ids of the workflow runs started inside it.
 * @type {Map<string, {state: Object, children: Set<string>}>}
 */
const recordings = new Map();
/** child runId → the recorded run it belongs to. */
const parentOf = new Map();

let unsubscribe = null;

function ensureTap() {
  if (!unsubscribe) unsubscribe = observeEmittedEnvelopes(observeEnvelope);
}

/**
 * Start recording a run. Idempotent; a run is recorded until its activity is
 * taken or discarded.
 *
 * @param {string} runId
 */
export function recordRunActivity(runId) {
  if (typeof runId !== 'string' || !runId || recordings.has(runId)) return;
  ensureTap();
  recordings.set(runId, { state: createStreamState(runId), children: new Set() });
  while (recordings.size > MAX_RECORDINGS) forget(recordings.keys().next().value);
}

/** Whether a run is being recorded (tests / diagnostics). */
export function isRecordingRunActivity(runId) {
  return recordings.has(runId);
}

function forget(runId) {
  const recording = recordings.get(runId);
  if (!recording) return;
  for (const child of recording.children) parentOf.delete(child);
  recordings.delete(runId);
}

/**
 * The part of a frame the activity needs, or null to skip it. Text, reasoning
 * and pictures are the transcript's; the preview of a tool result and the data
 * of an MCP App view are large and not shown in the activity.
 */
function slim(envelope) {
  const { type, data } = envelope;
  switch (type) {
    case SSE_V2_EVENTS.STEP_DELTA:
      return null;
    case SSE_V2_EVENTS.STEP_COMPLETED: {
      if (!data?.groundingMetadata && !data?.sources) return null;
      return {
        ...envelope,
        data: {
          step: data.step,
          ...(data.groundingMetadata ? { groundingMetadata: data.groundingMetadata } : {}),
          ...(data.sources ? { sources: data.sources } : {})
        }
      };
    }
    case SSE_V2_EVENTS.TOOL_STARTED: {
      const { mcpApp: _view, ...rest } = data || {};
      return { ...envelope, data: rest };
    }
    case SSE_V2_EVENTS.TOOL_COMPLETED: {
      const {
        mcpApp: _view,
        resultPreview: _preview,
        scheduledTaskProposal: _proposal,
        authRequired: _auth,
        ...rest
      } = data || {};
      return { ...envelope, data: rest };
    }
    case SSE_V2_EVENTS.TOOL_PROGRESS:
      return RECORDED_PROGRESS_PHASES.has(data?.phase) ? envelope : null;
    case SSE_V2_EVENTS.PROGRESS_NODE:
      // A reconnecting client is sent the steps again (`replayChatWorkflowProgress`);
      // folding the replay would list every running step twice.
      return data?.progress?.replay ? null : envelope;
    case SSE_V2_EVENTS.META:
      return envelope;
    case SSE_V2_EVENTS.RUN_STARTED:
    case SSE_V2_EVENTS.RUN_ENDED:
    case SSE_V2_EVENTS.RUN_PAUSED:
    case SSE_V2_EVENTS.RUN_RESUMED:
      return envelope;
    default:
      return null;
  }
}

/**
 * The tap: fold one emitted frame into the recording it belongs to. Runs on
 * every frame of every stream, so anything unrecorded leaves at once.
 *
 * @param {Object} envelope - SSE v2 envelope as `RunStreamEmitter.emit` built it
 */
export function observeEnvelope(envelope) {
  if (recordings.size === 0 || !envelope || typeof envelope.runId !== 'string') return;
  const { runId, type, data } = envelope;
  let owner = recordings.has(runId) ? runId : parentOf.get(runId);
  if (!owner && type === SSE_V2_EVENTS.RUN_STARTED && recordings.has(data?.parentRunId)) {
    owner = data.parentRunId;
    parentOf.set(runId, owner);
    recordings.get(owner).children.add(runId);
  }
  if (!owner) return;
  const frame = slim(envelope);
  if (!frame) return;
  const recording = recordings.get(owner);
  try {
    recording.state = reduceRunEvent(recording.state, frame);
  } catch (error) {
    logger.warn('Run activity frame not recorded', {
      component: COMPONENT,
      runId,
      type,
      error: error.message
    });
  }
}

/**
 * The activity of a finished run, and the end of its recording. Null when the
 * run was not recorded or did nothing worth showing.
 *
 * @param {string} runId
 * @returns {Object|null}
 */
export function takeRunActivity(runId) {
  const recording = recordings.get(runId);
  if (!recording) return null;
  forget(runId);
  const run = recording.state.runs[runId];
  if (!run) return null;
  const children = [...recording.children]
    .map(childId => recording.state.runs[childId])
    .filter(Boolean);
  return buildRunActivity(finished(run), children.map(finished));
}

/** Stop recording without storing anything (a turn that will never be materialized). */
export function discardRunActivity(runId) {
  forget(runId);
}

/**
 * A run the materializer settles is over, whatever its last frame said: a
 * turn whose `run/ended` went out after this point, or never did, must not
 * read as still running in the stored activity.
 */
function finished(run) {
  return ['completed', 'aborted', 'error', 'budget_exhausted'].includes(run.status)
    ? run
    : { ...run, status: 'aborted' };
}

/**
 * Rebuild a run's activity from its ledger — for a turn whose process died
 * before the answer was stored, so nothing recorded it. The ledger holds the
 * tool calls, their results and the grounding of each step; the live-only
 * frames (iAssistant search status, workflow steps) are not in it.
 *
 * @param {Object} runLog - the RunLog (`readEvents(runId)`)
 * @param {string} runId
 * @returns {Promise<Object|null>}
 */
export async function rebuildRunActivity(runLog, runId) {
  try {
    const events = await runLog.readEvents(runId);
    const frames = events
      .flatMap(ev => projectLedgerEvent(ev))
      .map(slim)
      .filter(Boolean);
    if (frames.length === 0) return null;
    const state = reduceRunEvents(createStreamState(runId), frames);
    const run = state.runs[runId];
    return run ? buildRunActivity(finished(run)) : null;
  } catch (error) {
    logger.warn('Run activity not rebuilt from the ledger', {
      component: COMPONENT,
      runId,
      error: error.message
    });
    return null;
  }
}

// ── storage bounds ──────────────────────────────────────────────────────────

function text(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function strings(list, max = MAX_STORED_LIST, chars = MAX_LABEL_CHARS) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(value => typeof value === 'string' && value)
    .slice(0, max)
    .map(value => text(value, chars));
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null)
  );
}

function boundSource(source) {
  if (!source || typeof source !== 'object') return null;
  const out = compact({
    url: text(source.url),
    documentId: text(source.documentId, MAX_LABEL_CHARS),
    title: text(source.title, MAX_LABEL_CHARS),
    citedText: text(source.citedText),
    read: source.read === true ? true : undefined,
    readFailed: source.readFailed === true ? true : undefined
  });
  return out.url || out.documentId ? out : null;
}

function boundDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.slice(0, MAX_DETAILS).map(detail => ({
    name: text(detail?.name, MAX_LABEL_CHARS) || '',
    values: (Array.isArray(detail?.values) ? detail.values : [])
      .slice(0, MAX_DETAIL_VALUES)
      .map(value => compact({ text: text(value?.text) || '', full: text(value?.full) })),
    more: Number.isInteger(detail?.more) ? detail.more : 0
  }));
}

function boundToolItem(item) {
  return compact({
    id: text(item.id, MAX_LABEL_CHARS),
    kind: item.kind,
    native: item.native === true ? true : undefined,
    toolId: text(item.toolId, MAX_LABEL_CHARS),
    name: text(item.name, MAX_LABEL_CHARS),
    status: item.status,
    scope: item.scope,
    query: text(item.query),
    queries: item.queries ? strings(item.queries) : undefined,
    url: text(item.url),
    documentId: text(item.documentId, MAX_LABEL_CHARS),
    title: text(item.title, MAX_LABEL_CHARS),
    details: boundDetails(item.details),
    sources: (Array.isArray(item.sources) ? item.sources : [])
      .slice(0, MAX_STORED_ITEM_SOURCES)
      .map(boundSource)
      .filter(Boolean),
    error: text(item.error),
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null
  });
}

function boundStep(step) {
  return compact({
    nodeName: text(step?.nodeName, MAX_LABEL_CHARS),
    nodeType: text(step?.nodeType, 100),
    status: text(step?.status, 50),
    workflowName:
      typeof step?.workflowName === 'object' ? step.workflowName : text(step?.workflowName, 300),
    chatVisible: typeof step?.chatVisible === 'boolean' ? step.chatVisible : undefined
  });
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * The activity as it is stored with an answer: known fields only, each list
 * and string bounded, and the whole under {@link MAX_STORED_ACTIVITY_BYTES}.
 * Past that, the full text of long arguments goes first, then the sources of
 * each call, then the argument lists — the calls themselves stay.
 *
 * @param {unknown} activity - see `shared/run/runActivity.buildRunActivity`
 * @returns {Object|null}
 */
export function boundStoredActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const out = {};

  const items = activity.toolActivity?.items;
  if (Array.isArray(items) && items.length > 0) {
    out.toolActivity = {
      items: items.slice(0, MAX_STORED_TOOL_ITEMS).map(boundToolItem),
      reading: null
    };
  }
  const summary = activity.searchSummary;
  if (summary && typeof summary === 'object') {
    out.searchSummary = {
      queries: strings(summary.queries),
      applications: strings(summary.applications),
      sources: strings(summary.sources),
      totalHits: Number.isFinite(summary.totalHits) ? summary.totalHits : 0,
      rounds: Number.isInteger(summary.rounds) ? summary.rounds : 0,
      searching: false
    };
  }
  if (Array.isArray(activity.groundingSources) && activity.groundingSources.length > 0) {
    out.groundingSources = activity.groundingSources
      .slice(0, MAX_STORED_LIST)
      .map(boundSource)
      .filter(Boolean);
  }
  if (Array.isArray(activity.activeSkills) && activity.activeSkills.length > 0) {
    out.activeSkills = activity.activeSkills.slice(0, MAX_STORED_LIST).map(skill => ({
      name: text(skill?.name, MAX_LABEL_CHARS) || '',
      description: text(skill?.description, MAX_LABEL_CHARS) || ''
    }));
  }
  if (Array.isArray(activity.answerSource?.sources) && activity.answerSource.sources.length) {
    out.answerSource = { sources: strings(activity.answerSource.sources, 20, 100), type: 'mixed' };
  }
  if (Array.isArray(activity.workflowSteps) && activity.workflowSteps.length > 0) {
    // The end of a long run is what led to the answer; the execution page has
    // the whole history.
    out.workflowSteps = activity.workflowSteps.slice(-MAX_STORED_WORKFLOW_STEPS).map(boundStep);
  }
  if (activity.workflowResult && typeof activity.workflowResult === 'object') {
    out.workflowResult = compact({
      status: text(activity.workflowResult.status, 50),
      executionId: text(activity.workflowResult.executionId, 200),
      workflowName:
        typeof activity.workflowResult.workflowName === 'object'
          ? activity.workflowResult.workflowName
          : text(activity.workflowResult.workflowName, 300)
    });
  }
  if (typeof activity.outputFormat === 'string' && activity.outputFormat) {
    out.outputFormat = text(activity.outputFormat, 50);
  }

  if (out.toolActivity && jsonBytes(out) > MAX_STORED_ACTIVITY_BYTES) {
    const trims = [
      item => ({
        ...item,
        details: item.details.map(d => ({ ...d, values: d.values.map(v => ({ text: v.text })) }))
      }),
      item => ({ ...item, sources: item.sources.slice(0, 5) }),
      item => ({ ...item, details: [], sources: [] })
    ];
    for (const trim of trims) {
      out.toolActivity.items = out.toolActivity.items.map(trim);
      if (jsonBytes(out) <= MAX_STORED_ACTIVITY_BYTES) break;
    }
  }
  if (jsonBytes(out) > MAX_STORED_ACTIVITY_BYTES && out.workflowSteps) {
    out.workflowSteps = out.workflowSteps.slice(-20);
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The activity as a share carries it. What the turn did stays — which tools
 * it called, what it searched for, the public pages it read, the workflow
 * steps — but not what the owner's document searches found: those hits were
 * retrieved with the owner's iFinder permissions, which is also why a share
 * drops `citations` (see `ChatShareRepository.MESSAGE_FIELDS_DROPPED`). So a
 * document-scoped call keeps its query and loses its hits and the document it
 * read, and the iAssistant summary keeps its queries and counts and loses the
 * application and source names of its hits.
 *
 * @param {Object|null} activity - stored activity
 * @returns {Object|null}
 */
export function shareableActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const out = { ...activity };
  if (Array.isArray(activity.toolActivity?.items)) {
    out.toolActivity = {
      ...activity.toolActivity,
      items: activity.toolActivity.items.map(item => {
        if (item?.scope !== 'documents') return item;
        const { sources: _hits, title: _title, url: _url, documentId: _doc, ...rest } = item;
        return { ...rest, sources: [] };
      })
    };
  }
  if (activity.searchSummary) {
    out.searchSummary = { ...activity.searchSummary, applications: [], sources: [] };
  }
  return out;
}

/** Test hook: forget every recording. */
export function _resetRunActivity() {
  recordings.clear();
  parentOf.clear();
}
