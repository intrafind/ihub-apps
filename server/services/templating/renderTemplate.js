/**
 * Minimal Handlebars-subset template renderer.
 *
 * Generic — no audit/evidence assumptions. Consumers pass a template string
 * and a context object; this module is shared between the
 * `template-render` workflow node, the agent-tool `composeReport`, and any
 * future caller. A second Handlebars-subset renderer lives inside
 * `PromptNodeExecutor.js` (for prompt templates); consolidating to one
 * shared utility is a follow-up cleanup.
 *
 * Supported:
 *   - {{path.to.value}}                  — variable substitution with dot navigation
 *   - {{#if path}}...{{/if}}             — truthy conditional
 *   - {{#each list}}...{{/each}}         — loop; binds `this` + `@index` in the
 *                                           per-item context. Recursive — nested
 *                                           each/if/vars all work.
 *
 * Inside an each-block, `this` refers to the current item, so
 * `{{this.field}}`, `{{#if this.field}}`, and `{{#each this.field}}` all work.
 *
 * Not supported (yet): {{else}}, comparisons, custom helpers.
 *
 * @module services/templating/renderTemplate
 */

const MAX_PASSES = 5;
const MAX_DEPTH = 8;

export function renderTemplate(template, context, depth = 0) {
  if (typeof template !== 'string') return '';
  if (!context || typeof context !== 'object') context = {};
  if (depth > MAX_DEPTH) return template;

  // Standalone-block whitespace control (Handlebars convention): when an
  // {{#each}}, {{/each}}, {{#if}}, or {{/if}} sits alone on a line with
  // only whitespace around it, strip that line entirely. Without this,
  // every block produces a blank line in the output — which breaks
  // Markdown tables (`|---|---|` followed by a blank line drops the row
  // separator semantically).
  let result = stripStandaloneBlockLines(template);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = result;
    result = renderEach(result, context, depth);
    result = renderIf(result, context, depth);
    result = renderUnless(result, context, depth);
    result = renderVars(result, context);
    if (result === before) break;
  }
  return result;
}

function renderUnless(template, context, depth) {
  return replaceBlock(template, '#unless', '/unless', (header, body) => {
    const path = header.trim();
    const value = getPath(path, context);
    return isTruthy(value) ? '' : renderTemplate(body, context, depth + 1);
  });
}

function stripStandaloneBlockLines(s) {
  // Standalone-block whitespace control (Handlebars convention). When a
  // block directive is the only non-whitespace content on a line, consume
  // the trailing newline so the directive line itself doesn't render as a
  // blank line. Leading newline (i.e. the previous line's terminator) is
  // preserved so author whitespace before the block is intact.
  return s.replace(
    /(^|\n)[ \t]*(\{\{[#/](?:each|if|unless)(?:\s[^}]*)?\}\})[ \t]*\n/g,
    (_match, leading, directive) => `${leading}${directive}`
  );
}

function renderEach(template, context, depth) {
  return replaceBlock(template, '#each', '/each', (header, body) => {
    const listPath = header.trim();
    const list = getPath(listPath, context);
    if (!Array.isArray(list) || list.length === 0) return '';
    return list
      .map((item, index) => {
        const itemContext = { ...context, this: item, '@index': index };
        return renderTemplate(body, itemContext, depth + 1);
      })
      .join('');
  });
}

function renderIf(template, context, depth) {
  return replaceBlock(template, '#if', '/if', (header, body) => {
    const path = header.trim();
    const value = getPath(path, context);
    return isTruthy(value) ? renderTemplate(body, context, depth + 1) : '';
  });
}

function renderVars(template, context) {
  // {{@index}} first — won't match the regex below (starts with @).
  let result = template.replace(/\{\{@index\}\}/g, () => {
    const v = context['@index'];
    return v === undefined || v === null ? '' : String(v);
  });
  // Then `{{path}}` — exclude block opens (`#`), block closes (`/`), and `@`-prefixed
  // identifiers like {{@index}} handled above.
  result = result.replace(/\{\{([^#/@}][^}]*)\}\}/g, (_match, expr) => {
    const trimmed = expr.trim();
    const value = getPath(trimmed, context);
    return value === undefined || value === null ? '' : stringify(value);
  });
  return result;
}

/**
 * Replace the first `{{openTag header}}...{{closeTag}}` block (with correct
 * balanced nesting of the same tag) using `transform(header, body)`.
 * Repeats until no more blocks of this kind remain.
 */
function replaceBlock(input, openTag, closeTag, transform) {
  let result = input;
  let safety = 0;
  while (safety++ < 200) {
    const startRe = new RegExp(`\\{\\{${escapeRe(openTag)}\\s+([^}]+)\\}\\}`);
    const startMatch = result.match(startRe);
    if (!startMatch) break;

    const startIdx = startMatch.index;
    const headerLen = startMatch[0].length;
    const headerText = startMatch[1];
    const bodyStart = startIdx + headerLen;

    let depth = 1;
    let cursor = bodyStart;
    const openRe = new RegExp(`\\{\\{${escapeRe(openTag)}\\s+[^}]+\\}\\}`, 'g');
    const closeRe = new RegExp(`\\{\\{${escapeRe(closeTag)}\\}\\}`, 'g');

    let replaced = false;
    while (depth > 0 && cursor < result.length) {
      openRe.lastIndex = cursor;
      closeRe.lastIndex = cursor;
      const nextOpen = openRe.exec(result);
      const nextClose = closeRe.exec(result);
      if (!nextClose) {
        // Unbalanced — strip the orphaned opener so we don't loop forever.
        result = result.slice(0, startIdx) + result.slice(bodyStart);
        replaced = true;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose.index + nextClose[0].length;
        if (depth === 0) {
          const body = result.slice(bodyStart, nextClose.index);
          const replacement = transform(headerText, body);
          result = result.slice(0, startIdx) + replacement + result.slice(cursor);
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) break;
  }
  return result;
}

function getPath(path, ctx) {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function stringify(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default renderTemplate;
