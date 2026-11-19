// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where an answer that hit the model's output limit (`finishReason: length`)
 * ran out.
 *
 * A reasoning model spends the same `max_tokens` on its thinking as on its
 * answer. When the thinking takes all of it, the answer is not cut short: it
 * never started. The two need different words for the user, and only the
 * server has the step's token counts to tell them apart, so it decides here
 * and sends the result with `run/ended` and the stored message.
 *
 * @module services/chat/outputLimit
 */

/** Share of the completion that must be reasoning for "it only thought". */
const REASONING_SHARE = 0.9;

/**
 * @param {Object} params
 * @param {string|null|undefined} params.finishReason - How the turn finished.
 * @param {string|null|undefined} params.answerText - What the final step answered.
 * @param {{completionTokens?: number, reasoningTokens?: number}|null} [params.stepUsage] -
 *   Usage of the final model call alone (not the turn's sum).
 * @returns {'reasoning'|'answer'|undefined} `reasoning` when the limit was used
 *   up thinking and no answer was written, `answer` when the answer was cut
 *   off, nothing when the limit was not reached or the cause is unknown.
 */
export function limitReachedIn({ finishReason, answerText, stepUsage }) {
  if (finishReason !== 'length') return undefined;
  if (typeof answerText === 'string' && answerText.trim()) return 'answer';
  const completion = Number(stepUsage?.completionTokens);
  const reasoning = Number(stepUsage?.reasoningTokens);
  if (completion > 0 && reasoning >= completion * REASONING_SHARE) return 'reasoning';
  return undefined;
}
