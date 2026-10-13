/**
 * How the answer of a workflow run is picked for the chat, shared by the
 * server (which picks it) and the admin client (which explains and warns
 * about the pick on the workflow page).
 *
 * A workflow names its answer with `chatIntegration.primaryOutput`. Without
 * one ("Automatic"), the runner takes the first non-empty string among these
 * fields of the end node's output, and otherwise shows the whole output as
 * JSON (`extractReadableOutput()` in `server/tools/workflowRunner.js`).
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
