// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The normalisation rules of the golden harness: what makes two recordings of
 * the same run byte-equal. Each rule removes one thing that differs between
 * runs and says nothing about behaviour, and each has a unit test in
 * `normalise.test.js`:
 *
 * - ids are numbered by first appearance (`<id:1>`), so the same id in two
 *   places still reads as the same id;
 * - timestamps become `<ts>`, durations `<ms>`;
 * - `seq` and `rseq` are dropped after a check that they increase, `seq` within
 *   one stream and `rseq` within one run; the stream an envelope went to stays;
 * - consecutive `step/delta` events of one step and kind are merged, because
 *   how a text is cut into deltas depends on timing;
 * - the events of tool calls that ran side by side (one `parallelGroup`) are
 *   put in the order the model asked for the calls, because they arrive in the
 *   order the tools finish;
 * - the date sentence of the system prompt is replaced;
 * - temporary paths, hashes over content that holds a date, and the product
 *   version are replaced;
 * - `heartbeat` and `stream/connected` frames are dropped.
 *
 * See docs/run-testing.md.
 *
 * @module tests/golden/normalise
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { byCodeUnit } from './byCodeUnit.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * What counts as an id inside a string. Each pattern has one capture group, the
 * part that is replaced; the text around it stays (`chat-<id:1>`).
 */
export const DEFAULT_ID_PATTERNS = Object.freeze([
  // UUIDs, also inside a prefixed id such as `chat-<uuid>` or `inst_<uuid>`.
  new RegExp(`(${UUID})`, 'gi'),
  // ULIDs (the output id of a provenance record).
  /\b([0-7][0-9A-HJKMNP-TV-Z]{25})\b/g,
  // Short random suffixes of ids the server mints: `seg-1a2b3c4d`, `agent:<run>:1a2b3c4d`.
  /\bseg-([0-9a-f]{8})\b/g,
  // The parent id in the middle may already hold an `<id:N>` from the rule above.
  /\bagent:(?:<id:\d+>|[^:\s"'])+:([0-9a-f]{8})\b/g
]);

/** Keys whose value is a point in time, whatever its type. */
const TIMESTAMP_KEYS = new Set(['ts', 'timestamp', 'created_at', 'updated_at']);
/** Keys ending like this hold a point in time when the value is a number or a date string. */
const TIMESTAMP_KEY_SUFFIX = /(At|Time|Timestamp)$/;
/** Keys whose value is how long something took. Limits (`timeoutMs`, `maxWallClockMs`) are not. */
export const DURATION_KEYS = new Set([
  'durationMs',
  'latencyMs',
  'elapsedMs',
  'ttftMs',
  'waitMs',
  'queuedMs',
  'took',
  // The short names of a usage record: latency and time to first token.
  'lat',
  'ttft'
]);
/** Hashes over content that carries the date or an id, so they differ from run to run. */
export const VOLATILE_HASH_KEYS = new Set(['requestHash', 'messagesHash']);
/** Frames that say the connection is alive and nothing about the run. */
export const DROPPED_EVENT_TYPES = new Set(['heartbeat', 'stream/connected']);

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

/**
 * The sentence that tells the model the date (`globalPromptVariables.context`
 * in platform.json, filled with `{{date}}` in the language of the request:
 * "Friday, November 20, 2026" or "Freitag, 20. November 2026").
 */
const DATE_SENTENCE = /(The current date is )(.+?\b\d{4})(\.)/g;

/**
 * Replace the date in the date sentence of a system prompt.
 *
 * @param {string} text
 * @returns {string}
 */
export function applyDateRule(text) {
  return text.replace(DATE_SENTENCE, '$1<date>$3');
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * JSON with sorted keys, two spaces and a final newline: the one form a
 * record is written and compared in.
 *
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * A normaliser for one recording. It numbers ids in the order it meets them,
 * so everything of one record goes through the same normaliser, and in a fixed
 * order (see `harness.js`).
 *
 * @param {Object} [options]
 * @param {string} [options.appVersion] - The product version; a string equal to it becomes `<version>`.
 * @param {string[]} [options.tmpDirs=[os.tmpdir()]] - Directories under which temporary paths are created.
 * @param {RegExp[]} [options.idPatterns] - Added to {@link DEFAULT_ID_PATTERNS}; one capture group each.
 * @param {string[]} [options.volatileKeys] - More keys whose value is replaced by `<volatile>`.
 * @returns {{normalise: (value: any) => any, text: (value: string) => string, ids: Map<string, number>}}
 */
export function createNormaliser({
  appVersion,
  tmpDirs = [os.tmpdir()],
  idPatterns = [],
  volatileKeys = []
} = {}) {
  /** @type {Map<string, number>} */
  const ids = new Map();
  const patterns = [...DEFAULT_ID_PATTERNS, ...idPatterns];
  const volatile = new Set(volatileKeys);
  const tmpPatterns = [...new Set(tmpDirs)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(dir => new RegExp(`${escapeRegExp(dir)}[\\\\/][^\\\\/\\s"'<>]+`, 'g'));

  const idToken = raw => {
    const key = raw.toLowerCase();
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    return `<id:${ids.get(key)}>`;
  };

  const text = value => {
    let out = value;
    for (const pattern of tmpPatterns) out = out.replace(pattern, '<tmp>');
    out = applyDateRule(out);
    out = out.replace(ISO_TIMESTAMP, '<ts>');
    for (const pattern of patterns) {
      out = out.replace(pattern, (match, id) => match.replace(id, idToken(id)));
    }
    return out;
  };

  const isTimestampKey = key => TIMESTAMP_KEYS.has(key) || TIMESTAMP_KEY_SUFFIX.test(key);

  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (appVersion && value === appVersion) return '<version>';
      if (VOLATILE_HASH_KEYS.has(key)) return '<hash>';
      if (volatile.has(key)) return '<volatile>';
      return text(value);
    }
    if (typeof value === 'number') {
      if (DURATION_KEYS.has(key)) return '<ms>';
      if (volatile.has(key)) return '<volatile>';
      // A point in time as epoch milliseconds (after 2001); a small number under such a key is something else.
      if (isTimestampKey(key) && value > 1e12) return '<ts>';
      return value;
    }
    if (value instanceof Date) return '<ts>';
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (value && typeof value === 'object') {
      if (volatile.has(key)) return '<volatile>';
      const out = {};
      // Sorted, so the numbering of ids does not depend on the order a producer filled the object in.
      for (const name of Object.keys(value).sort(byCodeUnit)) {
        if (value[name] === undefined) continue;
        out[name] = walk(value[name], name);
      }
      return out;
    }
    return value;
  };

  return { normalise: value => walk(value, ''), text, ids };
}

/**
 * Fail unless `key` increases strictly over the events that carry it. The
 * numbers are dropped from a record, so this is the one place their order is
 * checked.
 *
 * @param {Object[]} events
 * @param {string} key - `seq` or `rseq`.
 * @param {(event: Object) => string} [streamOf] - Events are compared within one stream.
 */
export function assertIncreasing(events, key, streamOf = () => '') {
  const last = new Map();
  for (const [index, event] of events.entries()) {
    const value = event?.[key];
    if (value === undefined || value === null) continue;
    const stream = streamOf(event);
    const previous = last.get(stream);
    if (!Number.isFinite(value) || (previous !== undefined && value <= previous)) {
      throw new Error(
        `${key} does not increase at event ${index} (${event.type}): ${previous} then ${value}`
      );
    }
    last.set(stream, value);
  }
}

/** Whether two `step/delta` envelopes are pieces of the same text. */
function sameDelta(a, b) {
  return (
    a.streamId === b.streamId &&
    a.runId === b.runId &&
    a.data?.step === b.data?.step &&
    a.data?.kind === b.data?.kind &&
    a.data?.meta === undefined &&
    b.data?.meta === undefined &&
    typeof a.data?.content === 'string' &&
    typeof b.data?.content === 'string'
  );
}

/**
 * Merge consecutive `step/delta` envelopes of one stream, run, step and kind into one.
 * The server sends text in pieces whose size depends on a 50 ms window
 * (`RunStream.js`), so the pieces differ between runs and their sum does not.
 *
 * @param {Object[]} envelopes
 * @returns {Object[]}
 */
export function mergeStepDeltas(envelopes) {
  const merged = [];
  for (const envelope of envelopes) {
    const previous = merged[merged.length - 1];
    if (
      envelope.type === 'step/delta' &&
      previous?.type === 'step/delta' &&
      sameDelta(previous, envelope)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        data: { ...previous.data, content: previous.data.content + envelope.data.content }
      };
    } else {
      merged.push(envelope);
    }
  }
  return merged;
}

const callIdOf = event => {
  const id = event?.data?.callId ?? event?.data?.toolCallId;
  return id === undefined || id === null ? '' : String(id);
};
const callKey = (runId, step, callId) => `${runId}\u0000${step}\u0000${callId}`;

/**
 * `tool/progress` phases sent while the model still writes a call
 * (`toolArgProgress.js`), before any tool runs. They carry the call id, and
 * their order is the order of the model stream, so they are not moved.
 */
const MODEL_STREAM_PHASES = new Set(['args', 'args.ended']);
const whileModelStreams = event =>
  event?.type === 'tool/progress' && MODEL_STREAM_PHASES.has(event.data?.phase);

/**
 * Which tool calls ran side by side, read from the run ledger.
 *
 * The server names the group in one place only: `parallelGroup` on the ledger
 * event `tool/call` (`AgentLoop.js`). The `tool/result` of the same call and
 * the envelopes `tool/started` and `tool/completed` carry the call id and the
 * step, not the group. So the group of every other event is looked up here, by
 * run, step and call id.
 *
 * The position of a call is the place the model gave it in its answer
 * (`message/assistant`, `toolCalls`). It is the one order of a group that does
 * not depend on timing, and it also holds when a provider's call ids are
 * random.
 *
 * @param {Object[]} ledger - Run ledger events (`{ type, runId, data }`), in any order.
 * @returns {Map<string, {group: number, position: number|null}>} By run, step and call id.
 */
export function parallelGroupsOf(ledger) {
  const positions = new Map();
  for (const event of ledger) {
    if (event?.type !== 'message/assistant' || !Array.isArray(event.data?.toolCalls)) continue;
    for (const [position, call] of event.data.toolCalls.entries()) {
      // The id the server gives the call (`AgentLoop.js`): the model's, else its index, 0 included.
      const callId = call?.id || `${call?.index ?? ''}`;
      if (!callId) continue;
      positions.set(callKey(event.runId, event.data.step, callId), position);
    }
  }
  const groups = new Map();
  for (const event of ledger) {
    const group = event?.data?.parallelGroup;
    const callId = callIdOf(event);
    if (event?.type !== 'tool/call' || group === undefined || group === null || !callId) continue;
    const key = callKey(event.runId, event.data.step, callId);
    groups.set(key, { group, position: positions.get(key) ?? null });
  }
  return groups;
}

/** The order of two calls of one group: as the model asked for them, else by call id. */
function byCall(a, b) {
  if (a.position !== null && b.position !== null && a.position !== b.position) {
    return a.position - b.position;
  }
  return byCodeUnit(a.callId, b.callId) || a.index - b.index;
}

/**
 * Put the events of tool calls that ran side by side into a fixed order. The
 * calls of one group run under one `Promise.all`, so their events arrive in
 * the order the tools finish. A run of events of the same stream, run, step
 * and group is put in the order the model asked for the calls (by call id
 * where the ledger does not say) and, for one call, in the order its events
 * arrived in.
 *
 * An event belongs to a group when `groups` knows its run, step and call id.
 * That holds for the ledger events `tool/call` and `tool/result` and for
 * every envelope of the call that carries `callId` (`tool/started`,
 * `tool/completed`, `sources/added`). The `tool/progress` frames sent while
 * the model writes the call are left out: they are not the result of running
 * side by side, and their order is the model's.
 *
 * An event without a call id that arrives between the events of a group, in
 * the same stream and run and with the same step or none, is placed behind the
 * group: the circuit breaker's `tool/disabled` and a `tool/progress` a tool
 * sends with its phase only say nothing about which call they came from, so
 * their place between the results is a matter of timing. Several of them keep
 * the order they arrived in. Every other event keeps its place and ends the
 * run.
 *
 * What stays timing-dependent, and makes a golden of such a case unstable:
 * the order of two events without a call id that come from different calls of
 * one group, and the content of `tool/disabled` (a success between the
 * failures of the same tool resets the count, so whether and with which
 * `failures` the breaker trips depends on the finishing order).
 *
 * @param {Object[]} events - Envelopes (`{ type, streamId, runId, data }`) or ledger events
 *   (`{ type, runId, data }`).
 * @param {ReturnType<typeof parallelGroupsOf>} [groups] - From the ledger of the same recording.
 *   Without it the events are taken to be that ledger.
 * @returns {Object[]}
 */
export function orderParallelGroups(events, groups = parallelGroupsOf(events)) {
  const memberOf = event => {
    const callId = callIdOf(event);
    if (!callId || whileModelStreams(event)) return null;
    const found = groups.get(callKey(event.runId, event.data?.step, callId));
    return found ? { ...found, callId } : null;
  };
  const out = [];
  let run = [];
  let behind = [];
  const flush = () => {
    if (run.length > 1) run.sort(byCall);
    for (const entry of run) out.push(entry.event);
    out.push(...behind);
    run = [];
    behind = [];
  };
  /** Of the stream, run and step of the group being collected (`anyStep`: or of no step). */
  const ofOpenRun = (event, anyStep = false) => {
    const first = run[0]?.event;
    const step = event.data?.step;
    return (
      first !== undefined &&
      first.streamId === event.streamId &&
      first.runId === event.runId &&
      (first.data?.step === step || (anyStep && (step === undefined || step === null)))
    );
  };
  for (const event of events) {
    const member = memberOf(event);
    if (!member) {
      if (!callIdOf(event) && ofOpenRun(event, true)) {
        behind.push(event);
      } else {
        flush();
        out.push(event);
      }
      continue;
    }
    if (!(run[0]?.group === member.group && ofOpenRun(event))) flush();
    run.push({ ...member, event, index: run.length });
  }
  flush();
  return out;
}

/**
 * Normalise the envelopes a recording delivered (SSE v2): drop keep-alive
 * frames, check and drop `seq` and `rseq`, merge deltas, order parallel groups,
 * then apply the value rules.
 *
 * `seq` counts per stream and `rseq` per run (`RunStream.js`), so each is
 * checked within its own. The stream id stays in the record: an envelope that
 * went to another stream than before is a difference.
 *
 * @param {Array<{streamId: string, envelope: Object}>} deliveries - What was delivered to which
 *   stream, in order.
 * @param {ReturnType<typeof createNormaliser>} normaliser
 * @param {ReturnType<typeof parallelGroupsOf>} [groups] - The parallel groups of the recording, from
 *   its ledger. An envelope does not say which group its call ran in, so without this no envelope
 *   is moved.
 * @returns {Array<{type: string, streamId: string, runId?: string, data: any}>}
 */
export function normaliseEnvelopes(deliveries, normaliser, groups = new Map()) {
  const kept = deliveries
    .filter(({ envelope }) => !DROPPED_EVENT_TYPES.has(envelope.type))
    .map(({ streamId, envelope }) => ({ ...envelope, streamId: String(streamId ?? '') }));
  assertIncreasing(kept, 'seq', envelope => envelope.streamId);
  assertIncreasing(kept, 'rseq', envelope => envelope.runId || '');
  return orderParallelGroups(mergeStepDeltas(kept), groups).map(envelope =>
    normaliser.normalise({
      type: envelope.type,
      streamId: envelope.streamId,
      ...(envelope.runId ? { runId: envelope.runId } : {}),
      data: envelope.data ?? null
    })
  );
}

/**
 * Normalise run ledger events: check and drop `seq`, order parallel groups,
 * then apply the value rules.
 *
 * @param {Object[]} events - As appended, in order.
 * @param {ReturnType<typeof createNormaliser>} normaliser
 * @returns {Array<{type: string, runId: string, data: any}>}
 */
export function normaliseLedger(events, normaliser) {
  assertIncreasing(events, 'seq', event => event.runId || '');
  return orderParallelGroups(events).map(event =>
    normaliser.normalise({ type: event.type, runId: event.runId, data: event.data ?? null })
  );
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  }
  if (content && typeof content === 'object') return textOf(content.parts ?? content.text ?? '');
  return '';
}

/** The parts of a request body the projection reads by name; everything else is a model option. */
const NOT_AN_OPTION = new Set([
  'messages',
  'input',
  'contents',
  'system',
  'instructions',
  'systemInstruction',
  'system_instruction',
  'tools'
]);

function toolsOf(body) {
  const tools = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const declarations = tool?.functionDeclarations ?? tool?.function_declarations;
    if (Array.isArray(declarations)) {
      for (const d of declarations) tools.push({ name: d.name, parameters: d.parameters ?? null });
    } else if (tool?.function) {
      tools.push({ name: tool.function.name, parameters: tool.function.parameters ?? null });
    } else if (tool?.name) {
      tools.push({ name: tool.name, parameters: tool.input_schema ?? tool.parameters ?? null });
    } else {
      // A provider tool without a schema (native web search): its type is its name.
      tools.push({ name: String(tool?.type ?? 'unknown'), parameters: null });
    }
  }
  return tools;
}

/**
 * The projection of one model request that a golden asserts: the sequence of
 * roles, a hash of the system prompt after the value rules (so the date does
 * not change it), the offered tools by name with a reference to their
 * parameter schema, and the model options.
 *
 * It reads the request shapes of the adapters: OpenAI chat (`messages`,
 * `tools[].function`), OpenAI responses (`input`, `instructions`), Anthropic
 * (`system`, `tools[].input_schema`) and Google (`contents`,
 * `systemInstruction`, `functionDeclarations`).
 *
 * @param {{body: Object|string}} request - What the transport was handed.
 * @param {ReturnType<typeof createNormaliser>} normaliser
 * @returns {{projection: {roles: string[], systemPromptHash: string|null,
 *   tools: Array<{name: string, schema: string|null}>, options: Object},
 *   schemas: Record<string, any>}}
 */
export function projectModelRequest(request, normaliser) {
  const body = typeof request?.body === 'string' ? JSON.parse(request.body) : (request?.body ?? {});
  const messages = body.messages ?? body.input ?? body.contents ?? [];
  const list = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];
  const roles = list.map(message => String(message?.role ?? message?.type ?? 'unknown'));

  const systemParts = [];
  const topLevel =
    body.system ?? body.instructions ?? body.systemInstruction ?? body.system_instruction;
  if (topLevel !== undefined) systemParts.push(textOf(topLevel));
  for (const message of list) {
    if (message?.role === 'system' || message?.role === 'developer') {
      systemParts.push(textOf(message.content));
    }
  }
  const systemPrompt = systemParts.length > 0 ? normaliser.text(systemParts.join('\n\n')) : null;

  const schemas = {};
  const tools = toolsOf(body).map(tool => {
    if (tool.parameters === null) return { name: tool.name, schema: null };
    const parameters = normaliser.normalise(tool.parameters);
    const key = sha256(canonicalJson(parameters)).slice(0, 12);
    schemas[key] = parameters;
    return { name: tool.name, schema: key };
  });

  const options = {};
  for (const key of Object.keys(body).sort(byCodeUnit)) {
    if (!NOT_AN_OPTION.has(key)) options[key] = normaliser.normalise(body[key]);
  }

  return {
    projection: {
      roles,
      systemPromptHash: systemPrompt === null ? null : sha256(systemPrompt),
      tools,
      options
    },
    schemas
  };
}
