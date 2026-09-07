/**
 * Progress notes attached to any workflow node.
 *
 * Showing the user what a step is doing used to require its own `progress`
 * node in the graph — which meant loop bodies carried extra steps that had
 * nothing to do with the work. Instead any node may carry:
 *
 *   config.progress = {
 *     message: { en: "📄 Loading {{_currentDoc.title}}", de: "📄 Lade {{_currentDoc.title}}" },
 *     when?: "<expression>"
 *   }
 *
 * `message` may also be a plain string when the workflow is single-language.
 *
 * The message is emitted right before the node runs, with the same
 * `{{var}}` / `{{path.to.value}}` interpolation the standalone `progress`
 * node uses. The optional `when` is a boolean expression over workflow
 * state (`$.data....`); the note is skipped when it evaluates false.
 *
 * @module services/workflow/nodeProgress
 */

import { actionTracker } from '../../actionTracker.js';
// `shared/localize.js` rather than `server/utils/localize.js`: the latter pulls
// in configCache to read the platform default language, which is far too heavy
// a dependency for a helper called before every node runs.
import { getLocalizedContent } from '../../../shared/localize.js';
import { evaluateBooleanExpression } from './expressionEvaluator.js';

/**
 * Resolves `{{path}}` placeholders in a progress message against state data.
 *
 * @param {string|Object} template - Message template, plain or localized
 * @param {Object} data - Workflow state data
 * @param {string} [language='en'] - Language to resolve a localized template in
 * @returns {string} Message with placeholders substituted
 */
export function resolveProgressTemplate(template, data, language = 'en') {
  // A note may be a plain string or a localized object, like every other piece
  // of author-written text in a workflow. `getLocalizedString` passes plain
  // strings through unchanged, so both shapes work.
  const text = getLocalizedContent(template, language);
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (_match, path) => {
    const value = getNested(path, data);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  });
}

/** Reads a dotted/bracketed path out of an object. */
function getNested(path, obj) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Emits the SSE progress event for a resolved message.
 *
 * @param {Object} params
 * @param {string} params.message - Already-resolved message
 * @param {string} [params.nodeId] - Node the message belongs to
 * @param {string} [params.executionId] - SSE channel key
 * @param {string} [params.status='running'] - Step status
 */
export function emitProgressMessage({ message, nodeId, executionId, status = 'running' }) {
  if (!executionId || !message) return;
  try {
    actionTracker.emit('fire-sse', {
      event: 'workflow.node.progress',
      chatId: executionId,
      executionId,
      nodeId,
      status,
      message
    });
  } catch {
    /* best-effort: never fail a node because of an SSE emit */
  }
}

/**
 * Emits a node's own progress note, if it declares one and its `when`
 * condition holds. Called for every node the engine runs and for every
 * step inside a loop body.
 *
 * @param {Object} node - Workflow node
 * @param {Object} state - Current workflow state
 * @param {Object} context - Execution context (for the SSE channel)
 * @returns {boolean} Whether a note was emitted
 */
export function emitNodeProgress(node, state, context) {
  // `progress` is an OBJECT here. Standalone `progress` nodes may carry a
  // plain string under the same key as a legacy alias for their message —
  // that belongs to the node itself, not to this property.
  const progress = node?.config?.progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return false;

  const template = progress.message;
  if (!template || (typeof template !== 'string' && typeof template !== 'object')) return false;

  if (progress.when) {
    const { value } = evaluateBooleanExpression(progress.when, state);
    if (!value) return false;
  }

  const message = resolveProgressTemplate(template, state?.data || {}, context?.language);
  if (!message) return false;

  emitProgressMessage({
    message,
    nodeId: node?.id,
    executionId: context?.executionId || context?.runId || context?.chatId,
    status: progress.status || 'running'
  });
  return true;
}

export default emitNodeProgress;
