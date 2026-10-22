// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Estimating a project's size in tokens and what that means for the prompt.
 *
 * The estimate reads every item the way a chat would (link items are fetched,
 * with the caller's rights for iFinder), counts the tokens of its text and
 * recommends, per item and for the project, whether the text belongs in the
 * prompt or is better searched with the knowledge tools. It is a guide: the
 * real decision of a request is the planner's (`KnowledgeScopePlanner`), made
 * against the model's context window.
 *
 * @module services/projects/projectEstimate
 */
import { estimateTokens } from '../../../shared/tokenEstimator.js';
import { getItemText } from '../knowledge/ItemTextService.js';

/** The share of the load-all budget a project may take and still be put into the prompt as is. */
const COMFORTABLE_SHARE = 0.5;
/** The share of the load-all budget one document may take and still be pinned. */
const PIN_SHARE = 0.2;
/** The planner loads a project in `auto` mode up to this share of the context window. */
const CONTEXT_SHARE = 0.4;

/**
 * The recommendation for one document.
 *
 * - `prompt`: small enough to pin (always in the prompt) or to be loaded with its project.
 * - `search`: large; leave it to the knowledge tools.
 * - `unknown`: its size could not be measured.
 *
 * @param {number|null} tokens
 * @param {number} budgetTokens
 * @returns {{recommendation: 'prompt'|'search'|'unknown', reason: string}}
 */
export function recommendForItem(tokens, budgetTokens) {
  if (!Number.isFinite(tokens)) return { recommendation: 'unknown', reason: 'unmeasured' };
  if (tokens <= budgetTokens * PIN_SHARE) return { recommendation: 'prompt', reason: 'small' };
  return { recommendation: 'search', reason: 'large' };
}

/**
 * The recommendation for a whole project.
 *
 * - `prompt` / `comfortable`: well inside the budget; link it in `context` mode.
 * - `prompt` / `tight`: fits, but takes most of the budget that other projects share.
 * - `search` / `exceeds`: over the budget; link it in `tools` mode (or `auto`, which searches it).
 *
 * @param {number} tokens - Measured tokens (items without a size are not counted).
 * @param {number} budgetTokens
 * @param {{unmeasured?: number}} [options]
 * @returns {{recommendation: 'prompt'|'search'|'unknown', reason: string}}
 */
export function recommendForProject(tokens, budgetTokens, { unmeasured = 0 } = {}) {
  if (tokens > budgetTokens) return { recommendation: 'search', reason: 'exceeds' };
  if (unmeasured > 0) return { recommendation: 'unknown', reason: 'incomplete' };
  if (tokens === 0) return { recommendation: 'unknown', reason: 'empty' };
  if (tokens <= budgetTokens * COMFORTABLE_SHARE) {
    return { recommendation: 'prompt', reason: 'comfortable' };
  }
  return { recommendation: 'prompt', reason: 'tight' };
}

/**
 * Estimate one project: read its items, count tokens, recommend.
 *
 * @param {Object} project - A stored project.
 * @param {Object} options
 * @param {Object|null} options.user - The reader; link items are fetched with their rights.
 * @param {string} [options.language]
 * @param {number} options.budgetTokens - `projectSettings(...).loadAllMaxTokens`.
 * @param {number} [options.toolResultBudgetTokens]
 * @returns {Promise<{projectId: string, tokens: number, budgetTokens: number,
 *   toolResultBudgetTokens: number|null, share: number, minContextWindow: number,
 *   unmeasured: number, recommendation: string, reason: string, items: Array<Object>}>}
 */
export async function estimateProject(
  project,
  { user, language = 'en', budgetTokens, toolResultBudgetTokens = null }
) {
  const items = [];
  let total = 0;
  let unmeasured = 0;
  for (const item of project.items || []) {
    const base = { id: item.id, name: item.name, kind: item.kind, storage: item.storage };
    // A search without a fixed query is never loaded in full: the model's
    // terms become the query. It has no size to estimate.
    if (item.kind === 'ifinder-query' && !item.ref?.query) {
      items.push({
        ...base,
        ok: true,
        tokens: null,
        dynamic: true,
        recommendation: 'search',
        reason: 'dynamic'
      });
      continue;
    }
    const at = Date.now();
    try {
      const {
        text,
        truncated,
        failed = []
      } = await getItemText(project, item, {
        user,
        chatId: `project-estimate-${project.id}-${item.id}`,
        language,
        purpose: 'estimate'
      });
      const tokens = estimateTokens(text);
      total += tokens;
      items.push({
        ...base,
        ok: true,
        chars: text.length,
        tokens,
        // The source handed over only the start of the document, or lacks
        // documents it could not fetch: the real size is larger.
        ...(truncated ? { truncated: true } : {}),
        ...(failed.length ? { incomplete: true } : {}),
        duration: Date.now() - at,
        ...(truncated || failed.length
          ? { recommendation: 'search', reason: 'partial' }
          : recommendForItem(tokens, budgetTokens))
      });
    } catch (error) {
      unmeasured += 1;
      items.push({
        ...base,
        ok: false,
        tokens: null,
        error: error.message,
        code: error.code || 'ERROR',
        duration: Date.now() - at,
        recommendation: 'unknown',
        reason: 'unmeasured'
      });
    }
  }
  // The planner searches a project whose documents it could not load whole.
  const partial = items.some(entry => entry.truncated || entry.incomplete);
  const verdict = partial
    ? { recommendation: 'search', reason: 'partial' }
    : recommendForProject(total, budgetTokens, { unmeasured });
  return {
    projectId: project.id,
    tokens: total,
    budgetTokens,
    toolResultBudgetTokens,
    share: budgetTokens > 0 ? total / budgetTokens : 0,
    // The smallest context window with which `auto` loads the project in full.
    minContextWindow: Math.ceil(total / CONTEXT_SHARE),
    unmeasured,
    ...verdict,
    items
  };
}
