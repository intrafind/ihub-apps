/**
 * The four wrap-up nudges the loop injects as `role: 'user'` messages with a
 * `[system]` prefix. Wording is prompt-sensitive and intentionally identical
 * to the former in-executor loop.
 *
 * @module services/loop/nudges
 */

export function toolDisabledNudge({ toolId, reason, count, message, isSearch }) {
  const detail =
    reason === 'rate_limited' ? `rate-limited, failed ${count}×` : `failed ${count}× in a row`;
  return (
    `[system] The tool "${toolId}" is unavailable for the rest of this step ` +
    `(${detail}: ${message || 'tool error'}). ` +
    `Do NOT call it again. ` +
    (isSearch
      ? `Web search/fetch is unavailable — do NOT invent or guess URLs, sources, or quotes. `
      : '') +
    `Produce your best final answer now using only what you have already gathered, and ` +
    `explicitly note anything you could not verify because the tool was unavailable.`
  );
}

export const ALL_TOOLS_DEAD_NUDGE =
  '[system] All tools are currently unavailable (rate-limited or repeatedly failing). ' +
  'Do NOT call any more tools and do NOT invent URLs, sources, or quotes. Produce your ' +
  'COMPLETE final response now using everything you have gathered, and briefly note any ' +
  'gaps you could not close because tools were unavailable.';

export function tokenBudgetNudge({ spent, max }) {
  return (
    `[system] Token budget for this run is exhausted (${spent}/${max}). ` +
    `Stop calling tools. Produce your best final answer now using what you already have. ` +
    `Be concise and note any gaps you could not close.`
  );
}

export const ROUND_CAP_NUDGE =
  '[system] You have reached the tool-use round limit for this step. Do NOT call any ' +
  'more tools. Using everything you have gathered so far, produce your COMPLETE final ' +
  'response now, in full, exactly as instructed — not a summary of what you did. If ' +
  'some details are missing, state them briefly but still deliver the best complete ' +
  'answer you can.';

/** Build the nudge message object the loop appends to the transcript. */
export function nudgeMessage(content) {
  return { role: 'user', content, _nudge: true };
}
