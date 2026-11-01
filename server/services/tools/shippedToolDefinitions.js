// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool definitions iHub ships for its own features, read as data from
 * `server/defaults/tools/<id>.json`, and the implementations they name in
 * `server/tools/`.
 *
 * Three owners read them, each its own files:
 *
 * - the always-installed iHub integration (`ask_user`, the scheduled-task
 *   tools): `protocols/native/connectors/ihub/`;
 * - the workflow and agent tools (agent workspace, evidence):
 *   `services/tools/platformTools.js`;
 * - the project knowledge tools: `services/knowledge/knowledgeTools.js`.
 *
 * The files stay in `server/defaults/tools/` because released config
 * migrations (V087, V160, V173) read them through `ctx.readDefaultJson` while
 * upgrading an older install; migration V199 removed the copies from
 * `contents/tools/`.
 *
 * @module services/tools/shippedToolDefinitions
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This module imports nothing of iHub's own: the knowledge and platform tool
// modules read their definitions while the config cache's import graph is
// still loading, and a cycle back into it would leave the constants below
// uninitialized at that point.

/**
 * Where the shipped tool files live: next to the server code, not under the
 * configured root directory (`APP_ROOT_DIR`), because they are part of the
 * code like the implementations in `server/tools/`.
 */
const SHIPPED_TOOLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'defaults',
  'tools'
);

/**
 * Where the shipped tool files live.
 * @returns {string}
 */
export function shippedToolsDir() {
  return SHIPPED_TOOLS_DIR;
}

/**
 * A tool file's name as `configCache` names an expanded function: the English
 * text, else the first text, else the id.
 * @param {Object} tool
 * @returns {string}
 */
function englishName(tool) {
  if (typeof tool.name === 'string') return tool.name;
  if (tool.name && typeof tool.name === 'object') {
    if (typeof tool.name.en === 'string') return tool.name.en;
    const first = Object.values(tool.name).find(value => typeof value === 'string');
    if (first !== undefined) return first;
  }
  return tool.id;
}

/**
 * Expand one tool file the way `configCache` expands a configured one: a file
 * with `functions` becomes one tool per function (`evidence` →
 * `evidence_collect`, …, each with `method` set to the function name).
 *
 * @param {Object} tool - Parsed tool file
 * @returns {Object[]} The tools the file stands for
 */
export function expandShippedTool(tool) {
  if (!tool.functions || typeof tool.functions !== 'object') return [tool];
  const base = { ...tool };
  delete base.functions;
  return Object.entries(tool.functions).map(([fn, cfg]) => ({
    ...base,
    id: `${tool.id}_${fn}`,
    name: cfg.name || `${englishName(tool)}_${fn}`,
    description: cfg.description || tool.description,
    parameters: cfg.parameters || {},
    method: fn,
    passthrough: cfg.passthrough || tool.passthrough || false
  }));
}

/**
 * Read shipped tool files and expand them into tool definitions.
 *
 * @param {readonly string[]} fileIds - File-level ids (`evidence`, not `evidence_collect`)
 * @param {Object} [options]
 * @param {string} [options.dir] - Directory to read from (tests); the shipped one by default
 * @returns {Map<string, Object>} tool id → definition (multilingual texts as in the file)
 * @throws {Error} When a file is missing or not valid JSON: a shipped file is part of iHub
 * @example
 * readShippedToolDefinitions(['knowledge']).keys();
 * // → 'knowledge_search', 'knowledge_read', 'knowledge_list'
 */
export function readShippedToolDefinitions(fileIds, { dir = shippedToolsDir() } = {}) {
  const tools = new Map();
  for (const fileId of fileIds) {
    const file = JSON.parse(readFileSync(path.join(dir, `${fileId}.json`), 'utf8'));
    for (const tool of expandShippedTool(file)) tools.set(tool.id, tool);
  }
  return tools;
}

/**
 * The function that runs a shipped tool: the module `server/tools/<script>`
 * (`<id>.js` when the file names none), its export `method`, else its default
 * export.
 *
 * @param {Object} tool - Definition from {@link readShippedToolDefinitions}
 * @returns {Promise<Function>}
 * @throws {Error} When the script name is not a plain file name or the export is missing
 */
export async function shippedToolImplementation(tool) {
  const script = tool.script || `${tool.id}.js`;
  if (!/^[a-zA-Z0-9_-]+\.js$/.test(script)) {
    throw new Error(`Tool ${tool.id}: invalid script name`);
  }
  const mod = await import(`../../tools/${script}`);
  const fn = tool.method ? mod[tool.method] : mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`Tool ${tool.id} does not export function ${tool.method || 'default'}`);
  }
  return fn;
}

/**
 * The call's parameters with the defaults the tool's schema declares filled
 * in for the arguments the model left out (as `runTool` does for a tool file).
 *
 * @param {Object} tool - Tool definition
 * @param {Object} [params] - The model's arguments plus iHub's context keys
 * @returns {Object} A new object; `params` is not changed
 */
export function withSchemaDefaults(tool, params = {}) {
  const out = { ...params };
  for (const [key, prop] of Object.entries(tool.parameters?.properties || {})) {
    if (out[key] === undefined && prop?.default !== undefined) out[key] = prop.default;
  }
  return out;
}

/**
 * Run a shipped tool through its implementation.
 *
 * @param {Object} tool - Definition from {@link readShippedToolDefinitions}
 * @param {Object} [params] - Everything the tool call received: the model's
 *   arguments plus iHub's context (`user`, `chatId`, `appConfig`, …), which the
 *   implementations read themselves
 * @returns {Promise<any>} The implementation's result
 */
export async function runShippedTool(tool, params = {}) {
  const fn = await shippedToolImplementation(tool);
  return fn(withSchemaDefaults(tool, params));
}
