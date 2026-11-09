// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Early tool-call progress, as the converters expose it.
 *
 * Most converters hold a half-built tool call in private state and only hand
 * the finished call to the loop. For a call whose arguments are a whole file
 * (a web artifact, a document) that is minutes of silence. A converter that
 * can see the call being built therefore adds one optional field to the chunk
 * it returns:
 *
 *     toolCallProgress: [{ index, id?, name?, argBytes }]
 *
 * - `index`: the index the finished call will carry in `tool_calls`.
 * - `id` / `name`: as far as the provider has sent them (absolute, not deltas).
 * - `argBytes`: UTF-8 bytes of the raw argument text received so far (absolute,
 *   never decreasing). The argument text itself is never part of the signal.
 *
 * The field is set only when something changed since the last report of that
 * call, and never changes `tool_calls`: the finished calls stay exactly what
 * the converter always produced. `LLMClient.normalizeChunk` passes the field
 * through and `ResultAccumulator` ignores it; the chat's `chatToolSeam` is its
 * only reader (`services/chat/toolArgProgress.js`).
 *
 * A call that arrives whole in its first fragment (a provider-side tool-call
 * parser that buffers until the call is complete) carries no early signal, so
 * nothing is reported for it — see {@link arrivedWhole}.
 *
 * @module adapters/toolCalling/toolCallProgress
 */

/**
 * UTF-8 size of a piece of argument text.
 * @param {*} text
 * @returns {number} 0 for anything that is not a non-empty string
 */
export function utf8Bytes(text) {
  return typeof text === 'string' && text.length > 0 ? Buffer.byteLength(text, 'utf8') : 0;
}

/**
 * Whether a first argument fragment already holds the call's whole arguments
 * (a JSON object that parses). Such a call was buffered upstream: it announces
 * nothing before it is finished, so it is not reported as progress.
 *
 * @param {*} text - the first fragment of a call's arguments
 * @returns {boolean}
 */
export function arrivedWhole(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/**
 * The progress entry for one in-flight call, or null when there is nothing new
 * to say (nothing changed since the last report, or the call arrived whole).
 * The last report is remembered on `holder`, which is the converter's own
 * record of the call.
 *
 * @param {Object} holder - the converter's pending-call record (mutated: `progressReported`,
 *   `progressSuppressed`)
 * @param {{index: number, id?: string|null, name?: string|null, argBytes: number}} call
 * @returns {{index: number, id?: string, name?: string, argBytes: number}|null}
 */
export function progressEntry(holder, { index, id, name, argBytes }) {
  if (holder.progressSuppressed) return null;
  if (!id && !name && !argBytes) return null;
  const last = holder.progressReported;
  if (last && last.id === id && last.name === name && last.argBytes === argBytes) return null;
  holder.progressReported = { id, name, argBytes };
  return {
    index,
    ...(id ? { id: String(id) } : {}),
    ...(name ? { name: String(name) } : {}),
    argBytes
  };
}

/**
 * Count one argument fragment on an OpenAI-style pending call (`{ id, name,
 * arguments, index, argBytes }`), as the Chat Completions converters
 * accumulate them.
 *
 * @param {Object} pending - the pending call (mutated: `argBytes`, `progressSuppressed`)
 * @param {string} fragment - the argument text of this delta
 * @param {boolean} first - this delta created the pending call
 */
export function noteArgumentFragment(pending, fragment, first) {
  pending.argBytes = (pending.argBytes || 0) + utf8Bytes(fragment);
  if (first && arrivedWhole(fragment)) pending.progressSuppressed = true;
}

/**
 * The progress entries of the pending calls a chunk touched (OpenAI-style
 * records, see {@link noteArgumentFragment}); empty when nothing changed.
 *
 * @param {Iterable<Object>} touched - pending calls an incoming chunk added to
 * @returns {Array<{index: number, id?: string, name?: string, argBytes: number}>}
 */
export function pendingCallsProgress(touched) {
  const entries = [];
  for (const pending of touched) {
    const entry = progressEntry(pending, {
      index: pending.index,
      id: pending.id,
      name: pending.name,
      argBytes: pending.argBytes || 0
    });
    if (entry) entries.push(entry);
  }
  return entries;
}
