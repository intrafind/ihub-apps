/**
 * Handlebars-subset template engine used to resolve `{{...}}` placeholders in
 * agent-node prompts (system/user templates, per-task worker prompts).
 *
 * Extracted from `PromptNodeExecutor` (see #1775): this engine is
 * provider-agnostic and doesn't depend on the executor's LLM/tool-loop state,
 * but it does need three PromptNodeExecutor-specific hooks — `citations` and
 * `previousTaskResults` placeholder rendering, and `$.path` resolution — so
 * those are passed in via `deps` rather than imported directly.
 *
 * Deliberately NOT delegated to `services/templating/renderTemplate.js`: that
 * renderer doesn't support the `{{#compare}}` comparison-operator blocks this
 * engine does (see its module docstring). Consolidating the two is tracked as
 * a separate follow-up rather than folded into this extraction.
 *
 * @module services/workflow/executors/promptTemplateEngine
 */

/**
 * Get a nested value from an object using dot notation.
 *
 * @param {string} path - Dot-notation path like "user.name" or "items.0.id"
 * @param {Object} obj - Object to search
 * @returns {*} Value at path or undefined
 */
export function getNestedValue(path, obj) {
  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * Process {{#each}}...{{/each}} blocks with proper nesting support.
 * Uses balanced matching to correctly handle nested loops.
 *
 * @param {string} template - Template string to process
 * @param {Object} state - Workflow state
 * @param {{logger?: Object}} [deps] - `logger` is used to warn on malformed templates
 * @returns {string} Processed template
 */
export function processEachBlocks(template, state, deps = {}) {
  const { logger } = deps;
  let result = template;
  let iterations = 0;
  const maxIterations = 20; // Prevent infinite loops

  // Process from outermost to innermost
  // Find the first {{#each ...}} and its matching {{/each}} with balanced nesting
  while (iterations < maxIterations) {
    iterations++;

    const startMatch = result.match(/\{\{#each\s+([^}]+)\}\}/);
    if (!startMatch) {
      break; // No more each blocks
    }

    const startIndex = startMatch.index;
    const arrayPath = startMatch[1].trim();
    const afterOpenTag = startIndex + startMatch[0].length;

    // Find the matching closing tag with balanced nesting
    let depth = 1;
    let searchPos = afterOpenTag;
    let closingIndex = -1;

    while (depth > 0 && searchPos < result.length) {
      const nextOpen = result.indexOf('{{#each', searchPos);
      const nextClose = result.indexOf('{{/each}}', searchPos);

      if (nextClose === -1) {
        // No closing tag found - malformed template
        break;
      }

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // Found another opening tag before the closing tag
        depth++;
        searchPos = nextOpen + 7; // Move past "{{#each"
      } else {
        // Found closing tag
        depth--;
        if (depth === 0) {
          closingIndex = nextClose;
        }
        searchPos = nextClose + 9; // Move past "{{/each}}"
      }
    }

    if (closingIndex === -1) {
      // Couldn't find matching closing tag
      logger?.warn('Unbalanced {{#each}} block', {
        component: 'promptTemplateEngine',
        arrayPath
      });
      break;
    }

    // Extract the content between opening and closing tags
    const content = result.substring(afterOpenTag, closingIndex);

    // Get the array to iterate over
    const array = getNestedValue(arrayPath, state.data || {});

    let replacement = '';
    if (Array.isArray(array) && array.length > 0) {
      replacement = array
        .map((item, index) => {
          let itemContent = content;

          // Replace {{@index}} with current index
          itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));

          // Replace {{this.property}} with item.property
          itemContent = itemContent.replace(/\{\{this\.([^}]+)\}\}/g, (_, prop) => {
            const propPath = prop.trim();
            const val = getNestedValue(propPath, item);
            if (val !== undefined && val !== null) {
              return typeof val === 'object' ? JSON.stringify(val) : String(val);
            }
            return '';
          });

          // Replace {{this}} with JSON of item
          itemContent = itemContent.replace(/\{\{this\}\}/g, () => {
            return typeof item === 'object' ? JSON.stringify(item) : String(item);
          });

          // Recursively process any nested each blocks in this iteration
          itemContent = processEachBlocks(itemContent, state, deps);

          return itemContent;
        })
        .join('');
    }

    // Replace the full match with the processed content
    result = result.substring(0, startIndex) + replacement + result.substring(closingIndex + 9);
  }

  return result;
}

/**
 * Resolve template variables in a string.
 * Supports multiple syntaxes:
 * - {{variable}} - Simple Handlebars-style (looks up in state.data)
 * - {{#if condition}}...{{/if}} - Simple conditional blocks
 * - {{#each array}}...{{/each}} - Loop over arrays
 * - {{@index}} - Current loop index (0-based)
 * - {{this}} and {{this.property}} - Current item reference
 * - {{#compare val1 "op" val2}}...{{/compare}} - Comparison blocks
 * - $.path - JSONPath-style (via deps.resolveVariables)
 * - ${$.path} - Embedded JSONPath-style (via deps.resolveVariables)
 *
 * @param {string} template - Template string
 * @param {Object} state - Workflow state
 * @param {Object} [opts] - Options forwarded to `previousTaskResults` rendering
 * @param {{
 *   logger?: Object,
 *   formatPreviousTaskResults?: (state: Object, opts?: Object) => string,
 *   formatCitations?: (state: Object) => string,
 *   resolveVariables?: (value: string, state: Object) => string
 * }} [deps] - PromptNodeExecutor-specific hooks this engine defers to
 * @returns {string} Resolved template
 */
export function resolveTemplateVariables(template, state, opts = {}, deps = {}) {
  if (typeof template !== 'string') {
    return template;
  }

  const { logger, formatPreviousTaskResults, formatCitations, resolveVariables } = deps;

  let result = template;

  // Handle {{#each array}}...{{/each}} blocks with proper nesting support
  // Process from outermost to innermost using balanced matching
  result = processEachBlocks(result, state, deps);

  // Handle {{#compare val1 "op" val2}}...{{/compare}} blocks
  // Supports operators: <, >, <=, >=, ==, !=
  result = result.replace(
    /\{\{#compare\s+([^\s"]+)\s+"([^"]+)"\s+([^\s}]+)\s*\}\}([\s\S]*?)\{\{\/compare\}\}/g,
    (match, left, operator, right, content) => {
      // Resolve left value - could be a variable path or literal
      let leftVal = getNestedValue(left.trim(), state.data || {});
      if (leftVal === undefined) {
        // Treat as literal if not found in state
        leftVal = left.trim();
      }

      // Resolve right value - could be a variable path or literal
      let rightVal = getNestedValue(right.trim(), state.data || {});
      if (rightVal === undefined) {
        // Treat as literal if not found in state
        rightVal = right.trim();
      }

      let comparisonResult = false;

      switch (operator) {
        case '<':
          comparisonResult = Number(leftVal) < Number(rightVal);
          break;
        case '>':
          comparisonResult = Number(leftVal) > Number(rightVal);
          break;
        case '<=':
          comparisonResult = Number(leftVal) <= Number(rightVal);
          break;
        case '>=':
          comparisonResult = Number(leftVal) >= Number(rightVal);
          break;
        case '==':
          comparisonResult = leftVal == rightVal;
          break;
        case '===':
          comparisonResult = leftVal === rightVal;
          break;
        case '!=':
          comparisonResult = leftVal != rightVal;
          break;
        case '!==':
          comparisonResult = leftVal !== rightVal;
          break;
        default:
          logger?.warn('Unknown comparison operator', {
            component: 'promptTemplateEngine',
            operator
          });
      }

      return comparisonResult ? resolveTemplateVariables(content, state, opts, deps) : '';
    }
  );

  // Handle {{#if condition}}...{{/if}} blocks
  result = result.replace(
    /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (match, condition, content) => {
      // Resolve the condition variable
      const conditionValue = getNestedValue(condition.trim(), state.data || {});
      if (conditionValue) {
        // Recursively resolve variables in the content
        return resolveTemplateVariables(content, state, opts, deps);
      }
      return '';
    }
  );

  // Handle simple {{variable}} or {{path.to.value}} substitution
  // Exclude @index and this which are handled in each loops
  result = result.replace(/\{\{([^#/@}][^}]*)\}\}/g, (match, variable) => {
    const trimmed = variable.trim();

    // Skip 'this' references outside of each loops (they should be empty)
    if (trimmed === 'this' || trimmed.startsWith('this.')) {
      return '';
    }

    // Special template variable populated by the runtime — formats the
    // accumulated planner task results into a markdown block so the
    // synthesizer (and intermediate plan tasks) can see prior work.
    if (trimmed === 'previousTaskResults') {
      return formatPreviousTaskResults
        ? formatPreviousTaskResults(state, opts.previousTaskResults)
        : '';
    }

    // Citations ledger collected from every search/extract tool call
    // during the run. Renders a numbered list `[1] title — url` that the
    // synthesizer cites inline. Named `citations` (NOT `sources`) so it
    // doesn't collide with `profile.sources` — the configured knowledge
    // bases the agent can look up via `source_*` tools. Citations are
    // the runtime ledger of URLs the agent actually consulted; sources
    // is the configured catalog it could consult.
    if (trimmed === 'citations') {
      return formatCitations ? formatCitations(state) : '';
    }

    // Inbox item — render clean. The state object stores the FULL parsed
    // checklist line in `.raw`, which accumulates `-- done by …` notes
    // every time the item gets re-checked. Stringifying the whole object
    // bleeds that history (including prior hallucinated reports) into the
    // current run's prompts and the synthesizer's final report. Render
    // just `(P1) text` so the LLM sees what the user actually wrote.
    if (trimmed === 'currentInboxItem') {
      const item = state?.data?.currentInboxItem;
      if (!item) return '';
      if (typeof item === 'string') return item;
      const text = (item.text || '').toString().trim();
      if (!text) return '';
      const priority =
        item.priority && item.priority !== 'unprioritized'
          ? `(${item.priority.toUpperCase()}) `
          : '';
      return `${priority}${text}`;
    }

    const value = getNestedValue(trimmed, state.data || {});
    if (value !== undefined && value !== null) {
      // Convert objects to JSON string to avoid [object Object]
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    }
    return ''; // Remove unresolved variables
  });

  // Finally, handle $.path syntax via the executor's own resolveVariables
  result = resolveVariables ? resolveVariables(result, state) : result;

  return result;
}
