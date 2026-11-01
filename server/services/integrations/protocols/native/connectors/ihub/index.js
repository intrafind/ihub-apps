// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the always-installed `ihub` installation
 * (`com.intrafind/ihub`): iHub's own tools — `ask_user`, the project
 * knowledge tools, artifacts, agent memory, inboxes and tasks, the evidence
 * tools and the scheduled-task tools — under the ids they always had, so
 * `app.tools: ["ask_user"]`, group grants and the loop's own rules
 * (`isInteractiveTool`, the scheduling gate, the memory tools) keep working.
 *
 * The tool definitions are the shipped `server/defaults/tools/<id>.json`
 * files, read as data: each action's parameters, model-facing description
 * and flags come from there, and `run` delegates to the implementation in
 * `server/tools/<script>.js` exactly as the tool loader did (defaults from
 * the schema applied, `method` picked for function-style tools). The files
 * stay in `server/defaults/tools/` because released config migrations (V087,
 * V160, V173) read them through `ctx.readDefaultJson` while upgrading an
 * older install; V199 removes the copies from `contents/tools/`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getLocalizedString } from '../../../../../../utils/localize.js';

const TOOLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'defaults',
  'tools'
);

/** The file-level tool ids (`evidence`, not `evidence_collect`) the installation owns. */
export const IHUB_TOOL_FILE_IDS = Object.freeze([
  'ask_user',
  'create_task',
  'delete_scheduled_task',
  'evidence',
  'get_task_run',
  'knowledge',
  'list_scheduled_tasks',
  'list_task_runs',
  'list_tasks',
  'mark_task_done',
  'read_inbox',
  'read_memory',
  'run_scheduled_task_now',
  'schedule_task',
  'update_scheduled_task',
  'write_artifact',
  'write_inbox',
  'write_memory'
]);

/** Flags of a tool file that other code reads from the loaded tool. */
const CARRIED_FLAGS = ['requiresUserInput', 'isAgentTool', 'passthrough', 'requiresApproval'];

/**
 * The tool definitions, expanded like `configCache.expandToolFunctions`: a
 * file with `functions` becomes one tool per function (`evidence_collect`).
 * @returns {Map<string, object>} tool id → definition
 */
function loadToolDefinitions() {
  const tools = new Map();
  for (const id of IHUB_TOOL_FILE_IDS) {
    const tool = JSON.parse(readFileSync(path.join(TOOLS_DIR, `${id}.json`), 'utf8'));
    if (tool.functions && typeof tool.functions === 'object') {
      for (const [fn, cfg] of Object.entries(tool.functions)) {
        const base = { ...tool };
        delete base.functions;
        tools.set(`${tool.id}_${fn}`, {
          ...base,
          id: `${tool.id}_${fn}`,
          name: cfg.name || `${getLocalizedString(tool.name, 'en', undefined, tool.id)}_${fn}`,
          description: cfg.description || tool.description,
          parameters: cfg.parameters || {},
          method: fn,
          passthrough: cfg.passthrough || tool.passthrough || false
        });
      }
    } else {
      tools.set(tool.id, tool);
    }
  }
  return tools;
}

const TOOLS = loadToolDefinitions();

/** The ids of iHub's own tools, as the definition's actions name them. */
export const IHUB_TOOL_IDS = Object.freeze([...TOOLS.keys()]);

function localizedText(value, language) {
  if (typeof value === 'string') return value;
  return getLocalizedString(value, language || 'en', 'en', '') || '';
}

/** Fill the model's arguments with the defaults the schema declares (as `runTool` did). */
function withDefaults(tool, params) {
  const out = { ...params };
  for (const [key, prop] of Object.entries(tool.parameters?.properties || {})) {
    if (out[key] === undefined && prop?.default !== undefined) out[key] = prop.default;
  }
  return out;
}

async function implementationOf(tool) {
  const script = tool.script || `${tool.id}.js`;
  if (!/^[a-zA-Z0-9_-]+\.js$/.test(script)) {
    throw new Error(`Tool ${tool.id}: invalid script name`);
  }
  const mod = await import(`../../../../../../tools/${script}`);
  const fn = tool.method ? mod[tool.method] : mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`Tool ${tool.id} does not export function ${tool.method || 'default'}`);
  }
  return fn;
}

function action(tool) {
  const extras = { enabled: true };
  for (const flag of CARRIED_FLAGS) {
    if (tool[flag] !== undefined) extras[flag] = tool[flag];
  }
  return {
    parameters: tool.parameters || { type: 'object', properties: {}, required: [] },
    description: ctx => localizedText(tool.description, ctx.language),
    extras: () => extras,
    async run(_args, ctx) {
      const fn = await implementationOf(tool);
      // `params` is everything the tool call received: the model's arguments
      // plus iHub's context (`user`, `chatId`, `appConfig`, …), which the
      // implementations read themselves.
      return fn(withDefaults(tool, ctx.params || {}));
    }
  };
}

/** The installation test: every tool's implementation module loads and exports its function. */
async function test() {
  const steps = [];
  for (const tool of TOOLS.values()) {
    try {
      await implementationOf(tool);
      steps.push({ id: tool.id, label: tool.id, status: 'ok', message: tool.script });
    } catch (error) {
      steps.push({ id: tool.id, label: tool.id, status: 'fail', message: error.message });
    }
  }
  return steps;
}

const connector = {
  id: 'ihub',
  actions: Object.fromEntries([...TOOLS].map(([id, tool]) => [id, action(tool)])),
  test,
  status() {
    return { connected: true, toolCount: TOOLS.size };
  },
  invalidate() {},
  onChanged() {}
};

export default connector;
