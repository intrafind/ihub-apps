import { getDisplayableOutput } from './filterInternalFields';
import { answerOf, executionOutputOf } from '../../../../../shared/workflowChatOutput.js';

/**
 * What to offer as the download of a finished execution.
 *
 * The answer of the run is the output of the end step it finished at: text as
 * Markdown, anything else (JSON, a number, a boolean) as JSON. A run without
 * one (stopped, failed) offers what it has: a single string field, then a
 * Markdown bundle of all string outputs, and finally a JSON dump of whatever is
 * left.
 *
 * @param {Object} state - Execution state (`GET /workflows/executions/:id`)
 * @returns {{content: string, extension: 'md'|'json'}|null} Null when the run has nothing to download
 */
export function executionDownload(state) {
  const answer = answerOf(executionOutputOf(state));
  if (typeof answer === 'string') return { content: answer, extension: 'md' };
  // `0` and `false` are answers too: only a run without one falls back to its state
  if (answer !== null) return { content: JSON.stringify(answer, null, 2), extension: 'json' };

  const output = getDisplayableOutput(state?.data);
  const keys = Object.keys(output);
  if (keys.length === 0) return null;

  const stringKeys = keys.filter(key => typeof output[key] === 'string');
  if (stringKeys.length === 1) return { content: output[stringKeys[0]], extension: 'md' };
  if (stringKeys.length > 1) {
    const content = stringKeys.map(key => `# ${key}\n\n${output[key]}`).join('\n\n');
    return { content, extension: 'md' };
  }
  return { content: JSON.stringify(output, null, 2), extension: 'json' };
}
