import { isValidId } from './pathSecurity.js';

/**
 * Which script in `server/tools/` runs a tool, resolved the way
 * `toolLoader.runTool` does it, so the load-time warning and the startup check
 * look at exactly the file a call would load.
 *
 * `runTool` hands MCP tools, A2A agent skills, OpenAPI tools and provider-handled
 * (`isSpecialTool`) tools to their own dispatchers; every other tool runs the
 * script named by `script`, or `<id>.js` when the definition names none.
 *
 * @param {Object} tool - Tool definition
 * @returns {{script: unknown, valid: boolean}|null} null when the tool is not run
 *   from `server/tools/`. `script` is the file name; `valid` is false when it is
 *   not a plain file name (not a string, or a path), which `runTool` refuses.
 */
export function describeToolScript(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.isSpecialTool || tool._mcp || tool._a2a || tool.type === 'openapi') return null;
  const script = tool.script || (tool.id ? `${tool.id}.js` : undefined);
  if (script === undefined) return null;
  const valid = typeof script === 'string' && isValidId(script.replace(/\.js$/, ''));
  return { script, valid };
}
