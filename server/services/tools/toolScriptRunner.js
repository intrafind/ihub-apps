// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isValidId } from '../../utils/pathSecurity.js';

/**
 * Run a function of one of iHub's tool scripts (`server/tools/<script>`).
 *
 * The one place a tool script is imported and called: `runTool`
 * runs the platform tools of workflows and agents through it, and a custom integration's connector
 * module reaches it as `ctx.runToolScript` (see `NativeAdapter.run`). The
 * connectors migration V211 generated from admin-created tool files call the
 * script the tool file named this way, so the migrated actions run exactly
 * the code the tools ran before.
 *
 * @param {string} script - file name in `server/tools/`, e.g. `braveSearch.js`
 * @param {Object} [options]
 * @param {string} [options.method] - the exported function to call; the default export when absent
 * @param {Object} [options.parameters] - the JSON schema of the arguments; its
 *   `default` values fill arguments the call left out
 * @param {Object} [options.params] - the arguments plus iHub's context keys
 *   (`chatId`, `user`, `appConfig`, …), as a tool function receives them
 * @returns {Promise<unknown>} what the function returns
 * @throws {Error} when the name is not a plain file name or the function is missing
 *
 * @example
 * await runToolScript('braveSearch.js', { params: { query: 'iHub', chatId: 'c1' } });
 */
export async function runToolScript(script, { method, parameters, params = {} } = {}) {
  if (typeof script !== 'string' || !isValidId(script.replace(/\.js$/, ''))) {
    throw new Error('Invalid script name');
  }
  const file = script.endsWith('.js') ? script : `${script}.js`;
  const mod = await import(`../../tools/${file}`);
  const fn = method ? mod[method] : mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`Tool script ${file} does not export function ${method || 'default'}`);
  }
  // Filled in place, as the tool loader always did: the function receives
  // the very object the caller passed.
  for (const [key, prop] of Object.entries(parameters?.properties || {})) {
    if (params[key] === undefined && prop && prop.default !== undefined) params[key] = prop.default;
  }
  return fn(params);
}

export default runToolScript;
