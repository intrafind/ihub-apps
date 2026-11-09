// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool-call argument handling shared by every loop caller.
 *
 * Models emit tool arguments as a JSON string that is frequently a little
 * broken: two objects glued together (`{a}{b}`), a missing brace, prose around
 * the object. The chat loop and the workflow loop each had their own repair
 * strategy; this module is the union of both, plus the per-request parameter
 * defaults the chat loop applied.
 *
 * @module services/loop/toolArgs
 */
import { normalizeToolName } from '../../adapters/toolCalling/index.js';

/**
 * Find the first balanced JSON object/array in `text` (honours strings and
 * escapes). Returns the substring or null.
 * @param {string} text
 * @returns {string|null}
 */
export function extractFirstJsonValue(text) {
  if (typeof text !== 'string') return null;
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  void close;
  return null;
}

function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a model-emitted argument payload into an object. Strategy, in order:
 * already an object → as is; empty → `{}`; `JSON.parse`; glue `}{` → `,` and
 * wrap missing braces; first balanced JSON value inside the text; else `{}`.
 *
 * @param {string|object|null|undefined} raw
 * @returns {{ args: object, repaired: boolean, failed: boolean }}
 */
export function repairToolArguments(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.__raw_arguments !== undefined) return repairToolArguments(String(raw.__raw_arguments));
    return { args: raw, repaired: false, failed: false };
  }
  if (raw === undefined || raw === null) return { args: {}, repaired: false, failed: false };
  const text = String(raw).trim();
  if (text === '') return { args: {}, repaired: false, failed: false };

  const direct = parseObject(text);
  if (direct !== undefined) return { args: direct, repaired: false, failed: false };

  let glued = text.replace(/}\s*{/g, ',');
  if (!glued.startsWith('{') && !glued.startsWith('[')) glued = `{${glued}`;
  if (!glued.endsWith('}') && !glued.endsWith(']')) glued = `${glued}}`;
  const repaired = parseObject(glued);
  if (repaired !== undefined) return { args: repaired, repaired: true, failed: false };

  const embedded = extractFirstJsonValue(text);
  if (embedded) {
    const parsed = parseObject(embedded);
    if (parsed !== undefined) return { args: parsed, repaired: true, failed: false };
  }
  return { args: {}, repaired: true, failed: true };
}

/**
 * Fill in `parameters.properties[k].default` for arguments the model omitted.
 * Mutates and returns `args`.
 * @param {object} args
 * @param {object|null|undefined} toolDef
 * @returns {object}
 */
export function applyParameterDefaults(args, toolDef) {
  const props = toolDef?.parameters?.properties;
  if (!args || typeof args !== 'object' || !props || typeof props !== 'object') return args;
  for (const [key, schema] of Object.entries(props)) {
    if (schema && schema.default !== undefined && args[key] === undefined) {
      args[key] = schema.default;
    }
  }
  return args;
}

/**
 * Resolve the tool definition a model-emitted name refers to. Providers only
 * see normalized names, so match both the raw id and its normalized form.
 * @param {string} name
 * @param {Array} tools
 * @returns {object|null}
 */
export function matchTool(name, tools) {
  if (!name || !Array.isArray(tools)) return null;
  return (
    tools.find(t => t.id === name) ||
    tools.find(t => t.id && normalizeToolName(t.id) === name) ||
    tools.find(t => t.name === name || t.function?.name === name) ||
    null
  );
}

/**
 * One model-emitted tool call as the loop runs it. A call to `call_tool`
 * (tool search, services/tools/toolSearch.js) is unwrapped here, before any
 * seam looks at it: the item carries the tool it names and that tool's own
 * arguments (`viaCallTool`), so approval, the activity list, the run log and
 * the usage logs all see the real tool. A name that is not in this request's
 * deferred set is an unknown tool (`requestedName`), and a call that must not
 * run — arguments that do not fit, a tool the circuit breaker withheld — is a
 * `rejection`, answered to the model without running anything.
 *
 * @param {Object} options
 * @param {Object} options.call - The model's call
 * @param {{args: Object, repaired: boolean}} options.repair - `repairToolArguments` of its arguments
 * @param {Array<Object>} options.tools - The tools the request sends
 * @param {Object|null} [options.toolSearch] - `createToolSearch()` of the request
 * @param {Set<string>} [options.disabledTools] - Tool ids the circuit breaker withheld
 * @returns {{call: Object, toolDef: Object|null, args: Object, argsRepaired: boolean,
 *   viaCallTool?: boolean, requestedName?: string, rejection?: string}}
 */
export function resolveToolCall({ call, repair, tools, toolSearch = null, disabledTools = null }) {
  const named = matchTool(call.function.name, tools);
  const item = {
    call,
    toolDef: named,
    args: applyParameterDefaults(repair.args, named),
    argsRepaired: repair.repaired
  };
  if (!toolSearch || named?.toolSearchRole !== 'call') return item;

  const target = toolSearch.resolveCall(item.args);
  if (target.unknown) return { ...item, toolDef: null, requestedName: target.unknown };
  if (target.refused) return { ...item, rejection: target.refused };
  if (disabledTools?.has(target.toolDef.id)) {
    return {
      ...item,
      rejection: `${target.toolDef.id} failed repeatedly and is withheld for this run. Do not call it again; continue without it.`
    };
  }
  return { ...item, toolDef: target.toolDef, args: target.args, viaCallTool: true };
}
