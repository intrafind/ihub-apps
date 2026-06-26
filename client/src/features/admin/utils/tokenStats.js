/**
 * Token-usage aggregation for the agent run detail page.
 *
 * Each step already records its LLM token usage in
 * `run.data._stepLogs[id].tokens = { input, output }` (visible when a step is
 * expanded). This rolls those per-step numbers up into run-level totals and a
 * per-model breakdown for the summary card, and formats large counts compactly.
 *
 * NOTE: a step's `input` is the SUM of prompt tokens across all of that step's
 * agent iterations (the tool-calling loop re-sends the growing conversation
 * each turn), not a single prompt size. Label it accordingly in the UI.
 */

/**
 * Roll up per-step token usage into run-level totals + per-model breakdown.
 *
 * @param {Object|null|undefined} stepLogs - run.data._stepLogs map (id -> step log)
 * @returns {{ totalInput: number, totalOutput: number, total: number,
 *   llmStepCount: number, byModel: Record<string, { input: number, output: number }> }}
 */
export function aggregateTokenUsage(stepLogs) {
  const result = { totalInput: 0, totalOutput: 0, total: 0, llmStepCount: 0, byModel: {} };
  if (!stepLogs || typeof stepLogs !== 'object') return result;

  for (const log of Object.values(stepLogs)) {
    const tok = log?.tokens;
    if (!tok || typeof tok !== 'object') continue;
    const input = Number.isFinite(tok.input) ? tok.input : 0;
    const output = Number.isFinite(tok.output) ? tok.output : 0;
    // A step that recorded zero usage made no billable LLM call (e.g. a
    // deterministic node) — don't inflate the step count or the model map.
    if (input === 0 && output === 0) continue;

    result.totalInput += input;
    result.totalOutput += output;
    result.llmStepCount += 1;

    const model = typeof log.model === 'string' && log.model ? log.model : 'unknown';
    if (!result.byModel[model]) result.byModel[model] = { input: 0, output: 0 };
    result.byModel[model].input += input;
    result.byModel[model].output += output;
  }

  result.total = result.totalInput + result.totalOutput;
  return result;
}

/**
 * Format a token count compactly: 3343003 -> "3.34M", 34336 -> "34.3K",
 * 1000 -> "1.0K", 999 -> "999". Non-numbers render as an em dash.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatTokenCount(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
