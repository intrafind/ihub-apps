/**
 * Startup check for script-backed tools.
 *
 * A tool definition (`contents/tools/<id>.json`) names an implementation
 * script under `server/tools/`. Nothing used to look at that pairing until a
 * model first called the tool, so a retired script, a typo, a hand-edited
 * script with a syntax error or a script that needs a package the install does
 * not have all surfaced as a failed tool call in the middle of a chat.
 *
 * This answers "would the tool work in general" once at startup, without
 * calling any tool: for every enabled script-backed tool it checks that the
 * script exists, that it loads (the same `import()` `runTool` does, so a
 * missing package or a throw at module load shows up here) and that it exports
 * what the definition declares — the default export for a plain tool, a named
 * export per function for a multi-function tool or an explicit `method`.
 *
 * Problems are logged as warnings, never thrown: a broken tool must not keep
 * the server from starting, and an admin can disable or fix it afterwards.
 * Whether a tool is *configured* (API keys, credentials) is a different
 * question this deliberately leaves alone.
 *
 * @module services/tools/toolScriptCheck
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRootDir } from '../../pathUtils.js';
import { describeToolScript } from '../../utils/toolScripts.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ToolScriptCheck';

/** Reasons a script-backed tool cannot work. */
export const TOOL_SCRIPT_PROBLEMS = Object.freeze({
  INVALID_NAME: 'invalid-script-name',
  MISSING: 'missing-script',
  LOAD_FAILED: 'load-failed',
  MISSING_EXPORT: 'missing-export'
});

/**
 * The exports `runTool` will look for in a tool's script: the named method for
 * one function of a multi-function tool, the default export otherwise. A
 * definition that still carries its whole `functions` map (the raw file, before
 * the config cache expands it) needs every function exported.
 * @param {Object} tool
 * @returns {string[]}
 */
export function expectedExports(tool) {
  if (tool.method) return [tool.method];
  const functionNames =
    tool.functions && typeof tool.functions === 'object' ? Object.keys(tool.functions) : [];
  return functionNames.length > 0 ? functionNames : ['default'];
}

function firstLine(error) {
  const text = String(error?.message ?? error ?? '');
  return text.split('\n')[0].slice(0, 300);
}

function defaultScriptsDir() {
  return path.join(getRootDir(), 'server', 'tools');
}

function defaultImportScript(scriptPath) {
  return import(pathToFileURL(scriptPath).href);
}

/**
 * Group tool definitions by the script that runs them.
 * @param {Object[]} tools
 * @returns {{scripts: Map<string, {toolIds: Set<string>, exports: Set<string>}>,
 *   invalid: Array<{script: string, toolId: string}>, skipped: number}}
 */
function groupByScript(tools) {
  const scripts = new Map();
  const invalid = [];
  let skipped = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    const target = describeToolScript(tool);
    // A disabled tool cannot be called, so a broken script behind it is not a
    // problem (an admin may well have disabled it for that reason).
    if (!target || tool.enabled === false) {
      skipped++;
    } else if (target.valid) {
      if (!scripts.has(target.script)) {
        scripts.set(target.script, { toolIds: new Set(), exports: new Set() });
      }
      const entry = scripts.get(target.script);
      entry.toolIds.add(String(tool.id));
      expectedExports(tool).forEach(name => entry.exports.add(name));
    } else {
      invalid.push({ script: String(target.script).slice(0, 200), toolId: String(tool.id) });
    }
  }
  return { scripts, invalid, skipped };
}

/**
 * Load a script the way `runTool` does.
 * @returns {Promise<{mod: Object}|{error: unknown}>}
 */
function loadScript(importScript, scriptPath) {
  return importScript(scriptPath).then(
    mod => ({ mod }),
    error => ({ error })
  );
}

/**
 * Check one script against what its tool definitions need from it.
 * @returns {Promise<{script: string, toolIds: string[], kind: string, message: string, missingExports?: string[]}|null>}
 *   the problem found, null when the script is usable
 */
async function inspectScript(script, { toolIds, exports: wanted }, { scriptsDir, importScript }) {
  const ids = [...toolIds];
  const scriptPath = path.join(scriptsDir, script);
  if (!fs.existsSync(scriptPath)) {
    return {
      script,
      toolIds: ids,
      kind: TOOL_SCRIPT_PROBLEMS.MISSING,
      message: 'The script file does not exist'
    };
  }

  // Let the event loop serve requests between module loads: this runs right
  // after the server starts listening.
  await new Promise(resolve => setImmediate(resolve));

  const loaded = await loadScript(importScript, scriptPath);
  if ('error' in loaded) {
    return {
      script,
      toolIds: ids,
      kind: TOOL_SCRIPT_PROBLEMS.LOAD_FAILED,
      message: firstLine(loaded.error)
    };
  }

  const missingExports = [...wanted].filter(name => typeof loaded.mod?.[name] !== 'function');
  if (missingExports.length === 0) return null;
  const names = missingExports.map(name => JSON.stringify(name)).join(', ');
  return {
    script,
    toolIds: ids,
    kind: TOOL_SCRIPT_PROBLEMS.MISSING_EXPORT,
    message: `The script does not export ${names} as a function`,
    missingExports
  };
}

/**
 * Check the scripts of a set of tool definitions. Several definitions may share
 * one script (every function of a multi-function tool, or the scheduling
 * tools): each script is loaded once and must export everything its
 * definitions need.
 *
 * @param {Object[]} tools - Tool definitions, raw or as expanded by the config cache
 * @param {Object} [options]
 * @param {string} [options.scriptsDir] - Directory holding the scripts (default `server/tools`)
 * @param {(scriptPath: string) => Promise<Object>} [options.importScript] - Module loader (tests)
 * @returns {Promise<{checked: number, ok: number, skipped: number,
 *   problems: Array<{script: string, toolIds: string[], kind: string, message: string, missingExports?: string[]}>}>}
 */
export async function checkToolScripts(tools, options = {}) {
  const context = {
    scriptsDir: options.scriptsDir || defaultScriptsDir(),
    importScript: options.importScript || defaultImportScript
  };
  const { scripts, invalid, skipped } = groupByScript(tools);

  const problems = invalid.map(({ script, toolId }) => ({
    script,
    toolIds: [toolId],
    kind: TOOL_SCRIPT_PROBLEMS.INVALID_NAME,
    message: 'The script name is not a plain file name'
  }));
  for (const [script, needs] of scripts) {
    const problem = await inspectScript(script, needs, context);
    if (problem) problems.push(problem);
  }

  // Every script (a name that is not a plain file name counts as one) has at
  // most one problem.
  const checked = scripts.size + invalid.length;
  return { checked, ok: checked - problems.length, skipped, problems };
}

/**
 * Run the check against the configured tools and log the outcome. A script
 * that does not exist, or whose name is not a plain file name, was already
 * reported when the tools were loaded (`warnAboutMissingToolScripts`), so it
 * only counts towards the summary here.
 *
 * @param {Object} [options]
 * @param {Object[]} [options.tools] - Definitions to check (default: the config cache's tools)
 * @param {string} [options.scriptsDir]
 * @param {(scriptPath: string) => Promise<Object>} [options.importScript]
 * @returns {Promise<Awaited<ReturnType<typeof checkToolScripts>>|null>} the report, null when it could not run
 */
export async function runStartupToolCheck(options = {}) {
  try {
    let tools = options.tools;
    if (!tools) {
      const { default: configCache } = await import('../../configCache.js');
      tools = configCache.getTools()?.data;
    }
    if (!Array.isArray(tools)) return null;

    const report = await checkToolScripts(tools, options);

    for (const problem of report.problems) {
      if (
        problem.kind === TOOL_SCRIPT_PROBLEMS.MISSING ||
        problem.kind === TOOL_SCRIPT_PROBLEMS.INVALID_NAME
      ) {
        continue;
      }
      logger.warn('Tool script cannot be used', {
        component: COMPONENT,
        script: problem.script,
        tools: problem.toolIds,
        problem: problem.kind,
        reason: problem.message
      });
    }

    const summary = {
      component: COMPONENT,
      scripts: report.checked,
      ok: report.ok,
      problems: report.problems.length
    };
    if (report.problems.length > 0) {
      logger.warn(
        'Some tool scripts cannot be used; calls to these tools will fail until they are fixed or the tools are disabled',
        summary
      );
    } else {
      logger.info('Tool scripts checked: every enabled script-backed tool can be loaded', summary);
    }
    return report;
  } catch (error) {
    logger.warn('Tool script check could not run', { component: COMPONENT, error: error?.message });
    return null;
  }
}
