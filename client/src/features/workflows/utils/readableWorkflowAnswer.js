import { getDisplayableOutput } from './filterInternalFields';

/** Section title for an output: `corrected_text` → `corrected text`, as on the execution page. */
const titleOf = key => key.replaceAll('_', ' ');

/** The answer parsed as a plain JSON object, or null. */
function parseObject(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The outputs worth showing: no engine fields, no empty values. */
function shownEntries(output) {
  return Object.entries(getDisplayableOutput(output)).filter(
    ([, value]) => value !== undefined && value !== null && value !== ''
  );
}

function valueText(value, format) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  const json = JSON.stringify(value, null, 2);
  return format === 'markdown' ? `\`\`\`json\n${json}\n\`\`\`` : json;
}

/**
 * The outputs in the answer's format: one Markdown section, or one `name:`
 * line, per output; a single output on its own.
 */
function formatEntries(entries, format) {
  if (entries.length === 1) return valueText(entries[0][1], format);
  const block =
    format === 'markdown'
      ? ([key, value]) => `### ${titleOf(key)}\n\n${valueText(value, format)}`
      : ([key, value]) => `${titleOf(key)}:\n${valueText(value, format)}`;
  return entries.map(block).join('\n\n');
}

/**
 * How the web chat shows a workflow answer that is the workflow's whole
 * output as JSON — the fallback when no result is selected and no output has
 * a conventional answer name (`wholeOutput` on the result, set by the runner;
 * see shared/workflowChatOutput.js). An answer the workflow chose itself is
 * never reformatted, even when it is JSON.
 *
 * The stored answer, and what API, MCP and A2A callers receive, stays JSON;
 * only the web chat shows it the way the output format asks for:
 * Markdown — one section per output; text — one `name:` line per output;
 * JSON — unchanged. Engine fields are left out, as on the execution page.
 *
 * @param {object} message - The chat message
 * @param {string} format - The answer's output format
 * @returns {{text: string|null, preserveBreaks: boolean}|null} null to show the
 *   answer as it is; `text: null` when no output is left to show
 */
export function workflowAnswerView(message, format) {
  if (!message?.workflowResult?.wholeOutput) return null;
  if (format !== 'markdown' && format !== 'text') return null;
  const output = parseObject(message.content);
  if (!output) return null;
  const entries = shownEntries(output);
  return {
    text: entries.length > 0 ? formatEntries(entries, format) : null,
    preserveBreaks: format === 'text'
  };
}
