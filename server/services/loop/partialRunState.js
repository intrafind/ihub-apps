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
 * - `step/completed` drops that step's text (the ledger has it now) and keeps
 *   its thinking (the ledger has none).
 * - `run/ended` / `run/paused` drop the run. A paused run continues later as a
 *   new segment, which starts empty.
 * - Caps per run: past them the head is kept, the run is marked `truncated`
 *   and nothing more is appended; the transcript re-read at the end of the
 *   turn fills the rest in. Images are not kept.
 *
 * @module services/loop/partialRunState
 */
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { buildEnvelope, MAX_TRACKED_STREAMS, observeEmittedEnvelopes } from './RunStream.js';

/** Text kept per run (decision E1), counted in characters. */
export const MAX_PARTIAL_TEXT_BYTES = 256 * 1024;
/** Thinking kept per run (decision E1), counted in characters. */
export const MAX_PARTIAL_THINKING_BYTES = 512 * 1024;

/** Shown in place of what a capped run did not keep. */
const TRUNCATION_MARK = '…';

/**
 * runId → `{ streamId, steps: Map<step, text>, thoughts: [{ step, name?, content }],
 * textBytes, thinkingBytes, truncated }`. Map order doubles as LRU order.
 */
const runs = new Map();

function entryFor(runId, streamId) {
  let entry = runs.get(runId);
  if (entry) {
    runs.delete(runId);
  } else {
    entry = {
      streamId,
      steps: new Map(),
      thoughts: [],
      textBytes: 0,
      thinkingBytes: 0,
      truncated: false
    };
  }
  runs.set(runId, entry);
  // ponytail: LRU by count like the seq map; a byte budget if leaked runs ever matter.
  while (runs.size > MAX_TRACKED_STREAMS) runs.delete(runs.keys().next().value);
  return entry;
}

function appendText(entry, step, content) {
  if (entry.truncated) return;
  if (entry.textBytes + content.length > MAX_PARTIAL_TEXT_BYTES) {
    entry.truncated = true;
    return;
  }
  entry.textBytes += content.length;
  entry.steps.set(step, (entry.steps.get(step) || '') + content);
}

function appendThinking(entry, step, content, name) {
  if (entry.truncated) return;
  if (entry.thinkingBytes + content.length > MAX_PARTIAL_THINKING_BYTES) {
    entry.truncated = true;
    return;
  }
  entry.thinkingBytes += content.length;
  const last = entry.thoughts[entry.thoughts.length - 1];
  // Same rule as the reducer: unnamed chunks of one step run together, a named
  // thought is its own entry.
  if (!name && last && !last.name && last.step === step) last.content += content;
  else entry.thoughts.push({ step, ...(name ? { name } : {}), content });
}

/**
 * Fold one emitted envelope into the store. Installed as an emit observer.
 *
 * @param {Object} envelope - SSE v2 envelope
 * @param {string} streamId - The stream it was emitted on (the chat id)
 */
export function recordEnvelope(envelope, streamId) {
  const { runId, type, data } = envelope || {};
  if (!runId) return;
  switch (type) {
    case SSE_V2_EVENTS.RUN_STARTED:
      // Tracked from its start, so a re-attach during a tool call before any
      // text still finds the worker running it.
      entryFor(runId, streamId);
      break;
    case SSE_V2_EVENTS.STEP_DELTA: {
      const step = Number.isInteger(data?.step) ? data.step : 0;
      if (data.kind === 'text' && data.content) {
        appendText(entryFor(runId, streamId), step, data.content);
      } else if (data.kind === 'thinking' && (data.content || data.meta?.name)) {
        appendThinking(entryFor(runId, streamId), step, data.content || '', data.meta?.name);
      }
      break;
    }
    case SSE_V2_EVENTS.STEP_COMPLETED:
      runs.get(runId)?.steps.delete(data?.step ?? 0);
      break;
    case SSE_V2_EVENTS.RUN_ENDED:
    case SSE_V2_EVENTS.RUN_PAUSED:
      runs.delete(runId);
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
  const steps = new Set([...entry.thoughts.map(t => t.step), ...entry.steps.keys()]);
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
    const text = entry.steps.get(step);
    if (text) frames.push(delta({ step, kind: 'text', content: text }));
  }
  if (entry.truncated && frames.length > 0) {
    const last = Math.max(...steps);
    frames.push(delta({ step: last, kind: 'text', content: TRUNCATION_MARK }));
  }
  return { frames, truncated: entry.truncated };
}

/** Test seam. */
export function resetPartialRunState() {
  runs.clear();
}

observeEmittedEnvelopes(recordEnvelope);
