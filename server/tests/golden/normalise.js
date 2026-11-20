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
 * - `seq` and `rseq` are dropped after a check that they increase;
 * - consecutive `step/delta` events of one step and kind are merged, because
 *   how a text is cut into deltas depends on timing;
 * - events of one `parallelGroup` are put in the order of their call id,
 *   because tool calls that run side by side finish in any order;
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
    for (const key of Object.keys(value).sort()) {
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
      for (const name of Object.keys(value).sort()) {
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
 * Merge consecutive `step/delta` envelopes of one run, step and kind into one.
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

const groupOf = event => event?.data?.parallelGroup;
const callIdOf = event => String(event?.data?.callId ?? event?.data?.toolCallId ?? '');

/**
 * Put the events of one parallel group into a fixed order. Tool calls of one
 * group run side by side, so their events arrive in the order the tools
 * finish. A run of consecutive events of the same run, step and
 * `parallelGroup` is sorted by call id and, for one call, by the order the
 * events arrived in.
 *
 * Events without `parallelGroup` keep their place and end a run.
 *
 * @param {Object[]} events - Envelopes or ledger events (`{ type, runId, data }`).
 * @returns {Object[]}
 */
export function orderParallelGroups(events) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      run = run
        .map((event, index) => ({ event, index }))
        .sort(
          (a, b) => callIdOf(a.event).localeCompare(callIdOf(b.event), 'en') || a.index - b.index
        )
        .map(entry => entry.event);
    }
    out.push(...run);
    run = [];
  };
  for (const event of events) {
    const group = groupOf(event);
    const first = run[0];
    const sameRun =
      first &&
      group !== undefined &&
      groupOf(first) === group &&
      first.runId === event.runId &&
      first.data?.step === event.data?.step;
    if (group === undefined || !sameRun) flush();
    if (group === undefined) out.push(event);
    else run.push(event);
  }
  flush();
  return out;
}

/**
 * Normalise the envelopes of a stream (SSE v2): drop keep-alive frames, check
 * and drop `seq` and `rseq`, merge deltas, order parallel groups, then apply
 * the value rules.
 *
 * @param {Object[]} envelopes - As delivered, in order.
 * @param {ReturnType<typeof createNormaliser>} normaliser
 * @returns {Array<{type: string, runId?: string, data: any}>}
 */
export function normaliseEnvelopes(envelopes, normaliser) {
  const kept = envelopes.filter(envelope => !DROPPED_EVENT_TYPES.has(envelope.type));
  assertIncreasing(kept, 'seq');
  assertIncreasing(kept, 'rseq', envelope => envelope.runId || '');
  return orderParallelGroups(mergeStepDeltas(kept)).map(envelope =>
    normaliser.normalise({
      type: envelope.type,
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
  for (const key of Object.keys(body).sort()) {
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
