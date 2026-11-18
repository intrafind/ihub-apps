// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a running turn has streamed that its ledger does not hold yet.
 *
 * The ledger keeps lifecycle, tool and completed-step events, but no text
 * deltas and no thinking. A client that re-attaches mid-step (a reload, a
 * second tab, a dropped POST stream) would therefore miss the text of the step
 * in progress until the turn ends. This store keeps, per run, the text of every
 * unfinished step and the run's thinking, fed by the emit observer on the
 * worker producing the frames, and turns it into ordinary `step/delta` frames
 * for the resume (`services/chat/chatResume.js`).
 *
 * - `step/delta` text is appended to its step; thinking to the run's thought
 *   list, merged the way the client reducer merges it (`appendThought`).
 * - `step/completed` drops that step's text (the ledger has it now, and the
 *   text no longer counts against the cap) and keeps its thinking (the ledger
 *   has none).
 * - `run/ended` / `run/paused` drop the run. A paused run continues later as a
 *   new segment, which starts empty.
 * - All runs together keep at most {@link MAX_PARTIAL_TOTAL_BYTES}; past it the
 *   oldest runs are dropped (as are runs past the stream count), so runs that
 *   never end — a turn that died without `run/ended` — cannot pile up.
 * - Caps per run, text and thinking each: past one, the head is kept, the step
 *   where it was cut gets a `…` and nothing more of that kind is appended (text
 *   again from the next step on); the transcript re-read at the end of the
 *   turn fills the rest in. Images are not kept.
 * - Only frames numbered for the chat stream (`rseq`) are kept: a run streamed
 *   to an in-process sink (an API response, a recorder) is never resumed.
 *
 * @module services/loop/partialRunState
 */
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { buildEnvelope, MAX_TRACKED_STREAMS, observeEmittedEnvelopes } from './RunStream.js';

/** Text kept per run (decision E1), counted in characters. */
export const MAX_PARTIAL_TEXT_BYTES = 256 * 1024;
/** Thinking kept per run (decision E1), counted in characters. */
export const MAX_PARTIAL_THINKING_BYTES = 512 * 1024;

/**
 * Text and thinking kept for all runs of this process, counted in characters
 * (about 40 runs at both per-run caps); past it the oldest runs are dropped.
 */
export const MAX_PARTIAL_TOTAL_BYTES = 32 * 1024 * 1024;

/** Shown in place of what a capped run did not keep. */
const TRUNCATION_MARK = '…';

/**
 * runId → `{ streamId, steps: Map<step, text>, thoughts: [{ step, name?, content }],
 * textBytes, thinkingBytes, textCut, thinkingCut }` (`*Cut`: the step where
 * that kind was cut, or null). Map order doubles as LRU order: a run is moved
 * to the end when it starts, not on every frame.
 */
const runs = new Map();
/** Text and thinking characters held by all runs. */
let totalBytes = 0;

/**
 * Forget a run and free what it held. The emit observer does this on
 * `run/ended` / `run/paused`; call it for a run that ends without either
 * passing the observer (e.g. a late refusal answered directly to the POST).
 *
 * @param {string} runId
 */
export function dropRun(runId) {
  const entry = runs.get(runId);
  if (!entry) return;
  totalBytes -= entry.textBytes + entry.thinkingBytes;
  runs.delete(runId);
}

/** Count characters added to (or freed by) a run; drop the oldest runs past the budget. */
function charge(bytes) {
  totalBytes += bytes;
  while (totalBytes > MAX_PARTIAL_TOTAL_BYTES && runs.size > 0) dropRun(runs.keys().next().value);
}

function createEntry(runId, streamId) {
  dropRun(runId);
  const entry = {
    streamId,
    steps: new Map(),
    thoughts: [],
    textBytes: 0,
    thinkingBytes: 0,
    textCut: null,
    thinkingCut: null
  };
  runs.set(runId, entry);
  while (runs.size > MAX_TRACKED_STREAMS) dropRun(runs.keys().next().value);
  return entry;
}

function appendText(entry, step, content) {
  if (entry.textCut !== null) return;
  if (entry.textBytes + content.length > MAX_PARTIAL_TEXT_BYTES) {
    entry.textCut = step;
    return;
  }
  entry.textBytes += content.length;
  entry.steps.set(step, (entry.steps.get(step) || '') + content);
  charge(content.length);
}

function completeStep(entry, step) {
  const freed = (entry.steps.get(step) || '').length;
  entry.textBytes -= freed;
  entry.steps.delete(step);
  charge(-freed);
  if (entry.textCut === step) entry.textCut = null;
}

function appendThinking(entry, step, content, name) {
  if (entry.thinkingCut !== null) return;
  if (entry.thinkingBytes + content.length > MAX_PARTIAL_THINKING_BYTES) {
    entry.thinkingCut = step;
    return;
  }
  entry.thinkingBytes += content.length;
  const last = entry.thoughts[entry.thoughts.length - 1];
  // Same rule as the reducer: unnamed chunks of one step run together, a named
  // thought is its own entry.
  if (!name && last && !last.name && last.step === step) last.content += content;
  else entry.thoughts.push({ step, ...(name ? { name } : {}), content });
  charge(content.length);
}

/**
 * Fold one emitted envelope into the store. Installed as an emit observer.
 *
 * @param {Object} envelope - SSE v2 envelope
 * @param {string} streamId - The stream it was emitted on (the chat id)
 */
export function recordEnvelope(envelope, streamId) {
  const { runId, type, data } = envelope || {};
  if (!runId || !envelope.rseq) return;
  switch (type) {
    case SSE_V2_EVENTS.RUN_STARTED:
      // Tracked from its start, so a re-attach during a tool call before any
      // text still finds the worker running it.
      createEntry(runId, streamId);
      break;
    case SSE_V2_EVENTS.STEP_DELTA: {
      const step = Number.isInteger(data?.step) ? data.step : 0;
      const entry = () => runs.get(runId) ?? createEntry(runId, streamId);
      if (data.kind === 'text' && data.content) {
        appendText(entry(), step, data.content);
      } else if (data.kind === 'thinking' && (data.content || data.meta?.name)) {
        appendThinking(entry(), step, data.content || '', data.meta?.name);
      }
      break;
    }
    case SSE_V2_EVENTS.STEP_COMPLETED: {
      const entry = runs.get(runId);
      if (entry) completeStep(entry, data?.step ?? 0);
      break;
    }
    case SSE_V2_EVENTS.RUN_ENDED:
    case SSE_V2_EVENTS.RUN_PAUSED:
      dropRun(runId);
      break;
    default:
  }
}

/**
 * The stream (chat) of a run this worker is producing, or null when it holds
 * nothing for it.
 *
 * @param {string} runId
 * @returns {string|null}
 */
export function trackedStream(runId) {
  return runs.get(runId)?.streamId ?? null;
}

/**
 * The run's partial state as `step/delta` frames, in step order: each step's
 * thinking, then the text of a step that has not completed. Frames carry no
 * `rseq`: they stand for every frame up to the snapshot's cursor.
 *
 * @param {string} runId
 * @param {string} streamId - The chat the caller is allowed to read; another
 *   chat's run yields nothing.
 * @returns {{frames: Object[], truncated: boolean}}
 */
export function snapshotRun(runId, streamId) {
  const entry = runs.get(runId);
  if (!entry || entry.streamId !== streamId) return { frames: [], truncated: false };
  const { textCut, thinkingCut } = entry;
  const steps = new Set([...entry.thoughts.map(t => t.step), ...entry.steps.keys()]);
  if (textCut !== null) steps.add(textCut);
  if (thinkingCut !== null) steps.add(thinkingCut);
  const delta = data => buildEnvelope({ streamId, runId, type: SSE_V2_EVENTS.STEP_DELTA, data });
  const frames = [];
  for (const step of [...steps].sort((a, b) => a - b)) {
    for (const thought of entry.thoughts) {
      if (thought.step !== step) continue;
      frames.push(
        delta({
          step,
          kind: 'thinking',
          content: thought.content,
          ...(thought.name ? { meta: { name: thought.name } } : {})
        })
      );
    }
    if (thinkingCut === step) {
      frames.push(delta({ step, kind: 'thinking', content: TRUNCATION_MARK }));
    }
    const text = entry.steps.get(step);
    if (text) frames.push(delta({ step, kind: 'text', content: text }));
    if (textCut === step) frames.push(delta({ step, kind: 'text', content: TRUNCATION_MARK }));
  }
  return { frames, truncated: textCut !== null || thinkingCut !== null };
}

/** Test seam. */
export function resetPartialRunState() {
  runs.clear();
  totalBytes = 0;
}

observeEmittedEnvelopes(recordEnvelope);
