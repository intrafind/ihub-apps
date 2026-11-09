// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the chat says while the model is still producing a tool call's
 * arguments, and while it says nothing at all (issue #3534).
 *
 * A tool call such as `create_web_artifact` carries a whole file in its
 * arguments, which a model needs a minute or more to write. Until the call is
 * finished the loop runs no tool, so the chat had nothing to show. Two things
 * close that gap, both as `tool/progress` frames that are live only (they are
 * never stored, see `runActivity.js`):
 *
 *  - phases `args` / `args.ended`: the call is announced as soon as the
 *    converter reports its name (`chunk.toolCallProgress`, see
 *    `adapters/toolCalling/toolCallProgress.js`), reported at most once a
 *    second with the size of the arguments so far, and always closed;
 *  - phase `model.waiting`: after {@link TOOL_ARG_PROGRESS.WAITING_AFTER_MS}
 *    without visible output, once a second, so the chat is never a bare spinner
 *    for a provider that sends nothing.
 *
 * No frame carries any part of the arguments. This module is the logic; the
 * chat seam (`chatSeams.js`, `chatToolSeam`) only feeds it chunks and emits
 * what it returns. Wire contract: `docs/sse-v2.md`.
 *
 * @module services/chat/toolArgProgress
 */
import { repairToolArguments } from '../loop/toolArgs.js';
import { toolDisplayOf } from '../../utils/toolDisplay.js';

/** Every timing of the feature, in one place so product can tune it. */
export const TOOL_ARG_PROGRESS = Object.freeze({
  /**
   * A tool that is not a system-skill tool is announced only once its
   * arguments are still streaming this long after its name was seen, so a fast
   * call (a search, a page read) never flickers.
   */
  ANNOUNCE_AFTER_MS: 1500,
  /** At most one `args` frame per call in this interval. */
  MIN_FRAME_INTERVAL_MS: 1000,
  /**
   * While fragments flow, a call is reported at least this often. The
   * throttle is driven by the chunks themselves, so it keeps this without a
   * timer; tests assert it.
   */
  MAX_FRAME_GAP_MS: 2000,
  /** `model.waiting` starts after this long without visible output ... */
  WAITING_AFTER_MS: 3000,
  /** ... and repeats at this interval while the silence lasts. */
  WAITING_INTERVAL_MS: 1000,
  /**
   * Whether streamed reasoning counts as visible output and so resets the
   * waiting clock. It does not: reasoning that is not shown is exactly the
   * silence the line explains, and `model.waiting` carries `reasoning: true`
   * so the chat says "Thinking" instead. Set it to true to restart the clock
   * with every reasoning fragment (then a model that reasons without a pause
   * never produces a waiting frame).
   */
  REASONING_RESETS_WAITING: false
});

/** The `tool/progress` phases of this feature. */
export const PROGRESS_PHASES = Object.freeze({
  ARGS: 'args',
  ARGS_ENDED: 'args.ended',
  MODEL_WAITING: 'model.waiting'
});

/** Why an announced call stopped streaming (`args.ended` `data.outcome`). */
export const ARGS_OUTCOMES = Object.freeze({
  /** The finished call exists; a `tool/started` or an interaction follows. */
  READY: 'ready',
  /** The loop will not run it. */
  DROPPED: 'dropped',
  /** The model hit its output limit inside the arguments. */
  TRUNCATED: 'truncated',
  /** The arguments could not be read as JSON. */
  INVALID: 'invalid',
  /** Stop, a deadline or a provider error ended the model call. */
  ABORTED: 'aborted'
});

/**
 * Whether a call to this tool may be announced while its arguments stream: a
 * known tool that the server runs and the chat shows. The loop's own tools
 * (skills, tool search), a question to the user, a passthrough (workflow) tool
 * and anything the caller executes never are, and neither is a name that
 * matches no tool (a hallucinated one).
 *
 * @param {Object|null|undefined} toolDef - the offered tool the call name resolved to
 * @returns {boolean}
 */
export function isArgStreamAnnounceable(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return false;
  if (toolDef.isInternalTool || toolDef.interactive || toolDef.passthrough) return false;
  return true;
}

/**
 * How an announced call ended, once the model call is over.
 *
 * @param {Object} call - tracked call (`id`, `index`)
 * @param {'completed'|'error'|'aborted'} streamOutcome - how the model call ended
 * @param {Object} [result] - the accumulated result of a completed model call
 * @returns {'ready'|'dropped'|'truncated'|'invalid'|'aborted'}
 */
export function argsOutcomeOf(call, streamOutcome, result) {
  if (streamOutcome !== 'completed') return ARGS_OUTCOMES.ABORTED;
  const finished = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const truncatedByLimit = result?.finishReason === 'length';
  // By id first; a provider that repeats a different id per fragment still has
  // the call at its index.
  const final =
    finished.find(c => c?.id && String(c.id) === call.id) ??
    finished.find(c => c?.index === call.index);
  // The loop runs only calls that have a name. A call cut off before it was
  // finished (Anthropic never ends the block) is not in the list at all.
  if (!final || !String(final.function?.name || '').trim()) {
    return truncatedByLimit ? ARGS_OUTCOMES.TRUNCATED : ARGS_OUTCOMES.DROPPED;
  }
  const repair = repairToolArguments(final.function?.arguments);
  if (!repair.repaired) return ARGS_OUTCOMES.READY;
  // Arguments that only parse after repair: cut off by the limit, or the
  // loop runs the call with what the repair made of them (or with `{}`).
  if (truncatedByLimit) return ARGS_OUTCOMES.TRUNCATED;
  return repair.failed ? ARGS_OUTCOMES.INVALID : ARGS_OUTCOMES.READY;
}

/**
 * Follows the tool calls one model call streams and decides which `args` /
 * `args.ended` frames to send. Pure bookkeeping: no timers, nothing is emitted
 * here; every method returns the frames to send (`{ phase, callId, toolId,
 * data }`).
 *
 * One tracker lives for a chat turn; `close()` ends a model call and readies it
 * for the next one. It counts the calls it announced per tool for the turn's
 * `occurrence`.
 *
 * @param {Object} [options]
 * @param {() => number} [options.now] - clock in ms (tests)
 * @returns {{
 *   observe: (entries: Array, resolveTool: (name: string) => Object|null) => Array,
 *   close: (end: {outcome: string, result?: Object}) => Array,
 *   hasOpenCalls: () => boolean
 * }}
 */
export function createToolArgTracker({ now = () => Date.now() } = {}) {
  const { ANNOUNCE_AFTER_MS, MIN_FRAME_INTERVAL_MS } = TOOL_ARG_PROGRESS;
  /** toolId → how many calls of it were announced in this turn. */
  const occurrences = new Map();
  /** index → state of one call of the current model call. */
  let calls = new Map();

  /** The first frame of a call: what the chat needs to draw its row. */
  const announce = (call, t) => {
    const occurrence = (occurrences.get(call.toolId) || 0) + 1;
    occurrences.set(call.toolId, occurrence);
    call.stage = 'announced';
    call.lastFrameAt = t;
    call.sentBytes = call.argBytes;
    return {
      phase: PROGRESS_PHASES.ARGS,
      callId: call.id,
      toolId: call.toolId,
      data: {
        name: call.name,
        ...toolDisplayOf(call.toolDef),
        argBytes: call.argBytes,
        elapsedMs: t - call.firstSeenAt,
        ...(occurrence >= 2 ? { occurrence } : {})
      }
    };
  };

  /**
   * Later frames carry the two numbers only: the row is drawn already, and the
   * repeated display fields would be most of the frame budget of a long call.
   */
  const progress = (call, t) => {
    call.lastFrameAt = t;
    call.sentBytes = call.argBytes;
    return {
      phase: PROGRESS_PHASES.ARGS,
      callId: call.id,
      toolId: call.toolId,
      data: { argBytes: call.argBytes, elapsedMs: t - call.firstSeenAt }
    };
  };

  return {
    /**
     * Take the early progress a chunk carries.
     *
     * @param {Array<{index: number, id?: string, name?: string, argBytes: number}>} entries -
     *   `chunk.toolCallProgress`
     * @param {(name: string) => Object|null} resolveTool - the offered tool a call name refers to
     * @returns {Array} frames to send
     */
    observe(entries, resolveTool) {
      const frames = [];
      const t = now();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const index = Number.isInteger(entry.index) ? entry.index : 0;
        let call = calls.get(index);
        if (!call) {
          call = {
            index,
            id: null,
            name: null,
            argBytes: 0,
            firstSeenAt: t,
            nameSeenAt: null,
            stage: 'pending'
          };
          calls.set(index, call);
        }
        if (call.stage === 'ignored') continue;
        if (entry.id && !call.id) call.id = String(entry.id);
        if (entry.name && !call.name) {
          call.name = String(entry.name);
          call.nameSeenAt = t;
        }
        if (Number.isFinite(entry.argBytes))
          call.argBytes = Math.max(call.argBytes, entry.argBytes);

        // Nothing is said until both the id and the name are known: the call
        // id of the row must be the one `tool/started` will carry.
        if (call.stage === 'pending' && call.id && call.name) {
          const toolDef = resolveTool(call.name);
          if (isArgStreamAnnounceable(toolDef)) {
            call.toolDef = toolDef;
            call.toolId = String(toolDef.id);
            // A system-skill tool's arguments are the deliverable: announce at
            // once. Any other tool only when its arguments keep streaming.
            call.stage = toolDef.isSystemSkillTool === true ? 'immediate' : 'deferred';
          } else {
            call.stage = 'ignored';
          }
        }

        if (call.stage === 'immediate') {
          frames.push(announce(call, t));
        } else if (call.stage === 'deferred') {
          if (t - call.nameSeenAt >= ANNOUNCE_AFTER_MS) frames.push(announce(call, t));
        } else if (call.stage === 'announced') {
          if (call.argBytes > call.sentBytes && t - call.lastFrameAt >= MIN_FRAME_INTERVAL_MS) {
            frames.push(progress(call, t));
          }
        }
      }
      return frames;
    },

    /**
     * End the model call: every announced call gets exactly one `args.ended`.
     * What was never announced leaves nothing behind.
     *
     * @param {Object} end
     * @param {'completed'|'error'|'aborted'} end.outcome - how the model call ended
     * @param {Object} [end.result] - the accumulated result (`completed` only)
     * @returns {Array} frames to send
     */
    close({ outcome, result }) {
      const frames = [];
      const t = now();
      for (const call of calls.values()) {
        if (call.stage !== 'announced') continue;
        call.stage = 'closed';
        frames.push({
          phase: PROGRESS_PHASES.ARGS_ENDED,
          callId: call.id,
          toolId: call.toolId,
          data: {
            outcome: argsOutcomeOf(call, outcome, result),
            argBytes: call.argBytes,
            elapsedMs: t - call.firstSeenAt
          }
        });
      }
      calls = new Map();
      return frames;
    },

    /** Whether a call was announced and has not been closed (a row is on screen). */
    hasOpenCalls() {
      for (const call of calls.values()) if (call.stage === 'announced') return true;
      return false;
    }
  };
}

/**
 * The waiting line: a timer that reports `elapsedMs` once the model has shown
 * nothing for {@link TOOL_ARG_PROGRESS.WAITING_AFTER_MS}, then once a second
 * until something is shown or the model call ends.
 *
 * Visible output (answer text, an image, an announced tool row) resets the
 * clock; so does the end of the model call, which stops it. Streamed reasoning
 * is remembered and reported as `reasoning` (see
 * {@link TOOL_ARG_PROGRESS.REASONING_RESETS_WAITING}). A tick that finds an
 * announced row on screen stays silent: the row owns the headline then.
 *
 * Timers are read at call time (`setTimeout` / `Date.now`) so fake timers
 * work, and never keep the process alive.
 *
 * @param {Object} options
 * @param {(info: {elapsedMs: number, reasoning: boolean}) => void} options.onWaiting - called per tick
 * @param {() => boolean} [options.isSuppressed] - true while a row owns the headline
 * @returns {{arm: () => void, visible: () => void, thinking: () => void, stop: () => void}}
 */
export function createWaitingLine({ onWaiting, isSuppressed = () => false }) {
  const { WAITING_AFTER_MS, WAITING_INTERVAL_MS, REASONING_RESETS_WAITING } = TOOL_ARG_PROGRESS;
  let armed = false;
  let timer = null;
  let lastVisibleAt = 0;
  let reasoning = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = ms => {
    clear();
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  function tick() {
    timer = null;
    if (!armed) return;
    const elapsedMs = Date.now() - lastVisibleAt;
    // Output came since this tick was set: wait out the rest of the silence.
    if (elapsedMs < WAITING_AFTER_MS) {
      schedule(WAITING_AFTER_MS - elapsedMs);
      return;
    }
    if (!isSuppressed()) onWaiting({ elapsedMs, reasoning });
    schedule(WAITING_INTERVAL_MS);
  }

  return {
    /** A model call starts: the silence is counted from now. */
    arm() {
      armed = true;
      lastVisibleAt = Date.now();
      reasoning = false;
      schedule(WAITING_AFTER_MS);
    },
    /** Something the user can see arrived. */
    visible() {
      if (!armed) return;
      lastVisibleAt = Date.now();
      reasoning = false;
    },
    /** A reasoning fragment arrived (shown or not). */
    thinking() {
      if (!armed) return;
      reasoning = true;
      if (REASONING_RESETS_WAITING) lastVisibleAt = Date.now();
    },
    /** The model call is over. */
    stop() {
      armed = false;
      clear();
    }
  };
}
