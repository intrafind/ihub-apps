/**
 * How the answer of a workflow run is picked for the chat, shared by the
 * server (which picks it, `server/tools/workflowRunner.js`) and the client
 * (the admin page explains the pick; the web chat shows a whole-output answer
 * in the workflow's output format).
 *
 * A workflow names its answer with `chatIntegration.primaryOutput`. Without
 * one ("Automatic"), the runner takes the first non-empty string among these
 * fields of the end node's output, and otherwise answers with the whole output
 * as JSON.
 *
 * @module shared/workflowChatOutput
 */

export const CHAT_OUTPUT_FALLBACK_FIELDS = Object.freeze([
  'finalReport',
  'report',
  'content',
  'output',
  'result',
  'summary',
  'text',
  'message'
]);

/**
 * The fallback field the runner would pick among the given output keys, or
 * null when none of them is one, i.e. the chat would show JSON.
 *
 * @param {string[]} keys - Keys of the end node's output
 * @returns {string|null}
 */
export function fallbackChatOutputField(keys) {
  const present = new Set(keys || []);
  return CHAT_OUTPUT_FALLBACK_FIELDS.find(field => present.has(field)) || null;
}

/**
 * What "Automatic" shows for an end step passing on these keys, decided from
 * the names alone so the admin page can explain it before the workflow runs.
 * At run time a fallback field that turns out empty is skipped like the
 * runner does; from the names alone that cannot be known.
 *
 * @param {string[]} keys - Keys of the end node's output, in order
 * @returns {{mode: 'field', field: string} | {mode: 'json', keys: string[]} | {mode: 'none'}}
 */
export function automaticChatOutput(keys) {
  const field = fallbackChatOutputField(keys);
  if (field) return { mode: 'field', field };
  return keys && keys.length > 0 ? { mode: 'json', keys: [...keys] } : { mode: 'none' };
}

function getNestedField(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** The selected output as answer text, or null when it gives none. */
function selectedAnswer(output, primaryOutput) {
  if (!primaryOutput || typeof primaryOutput !== 'string') return null;
  const value = getNestedField(output, primaryOutput);
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return null;
}

/**
 * The answer a workflow run gives in chat, and whether it is the whole output
 * — the fallback when neither the selected result nor a conventionally named
 * output gives one. The web chat reformats only that fallback; an answer the
 * workflow chose is shown as it is.
 *
 * @param {*} output - The end node's output
 * @param {string} [primaryOutput] - `chatIntegration.primaryOutput`
 * @returns {{text: string|null, wholeOutput: boolean}}
 */
export function chatAnswerOf(output, primaryOutput) {
  if (!output) return { text: null, wholeOutput: false };
  if (typeof output !== 'object') return { text: String(output), wholeOutput: false };

  const selected = selectedAnswer(output, primaryOutput);
  if (selected !== null) return { text: selected, wholeOutput: false };

  const field = CHAT_OUTPUT_FALLBACK_FIELDS.find(
    name => typeof output[name] === 'string' && output[name].length > 0
  );
  if (field) return { text: output[field], wholeOutput: false };

  return { text: JSON.stringify(output, null, 2), wholeOutput: true };
}
