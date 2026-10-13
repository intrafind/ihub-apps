import { getDisplayableOutput } from './filterInternalFields';

/** Section title for an output: `corrected_text` → `corrected text`, as on the execution page. */
const titleOf = key => key.replace(/_/g, ' ');

/**
 * How the web chat shows a workflow answer that is a JSON object, in the
 * answer's output format.
 *
 * Without a selected result (`chatIntegration.primaryOutput`), a workflow
 * whose outputs have no conventional answer name answers with its whole
 * output as JSON (shared/workflowChatOutput.js). That text is what is stored
 * and what API, MCP and A2A callers receive, so it stays as it is; only the
 * web chat shows it the way the chosen format asks for:
 *
 * - `markdown`: one section per output, its name as the heading; text values
 *   as they are, structured values as a JSON code block;
 * - `text`: one `name:` line per output, followed by its value;
 * - a single output is shown on its own, without a heading.
 *
 * Engine fields (`_…` and the like) are left out, as on the execution page.
 *
 * @param {string} content - The answer as stored
 * @param {string} format - The answer's output format
 * @returns {string|null} The text to show, or null to show the answer as it is:
 *   for the JSON format, for anything that is not a JSON object, and when no
 *   output is left to show
 */
export function readableWorkflowAnswer(content, format) {
  if (format !== 'markdown' && format !== 'text') return null;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const entries = Object.entries(getDisplayableOutput(parsed)).filter(
    ([, value]) => value !== undefined && value !== null && value !== ''
  );
  if (entries.length === 0) return null;

  const valueText = value => {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    const json = JSON.stringify(value, null, 2);
    return format === 'markdown' ? '```json\n' + json + '\n```' : json;
  };

  if (entries.length === 1) return valueText(entries[0][1]);
  if (format === 'markdown') {
    return entries.map(([key, value]) => `### ${titleOf(key)}\n\n${valueText(value)}`).join('\n\n');
  }
  return entries.map(([key, value]) => `${titleOf(key)}:\n${valueText(value)}`).join('\n\n');
}
