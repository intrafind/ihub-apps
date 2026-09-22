/**
 * Migration V123 — route an existing webContentExtractor definition through
 * the model-facing entry point
 *
 * `webContentExtractor` is now offered automatically next to the script-backed
 * web search tool, so the model can open a result in full. The shipped
 * definition (`server/defaults/tools/webContentExtractor.json`) calls
 * `extractForTool`, which clamps `maxLength` and never takes `ignoreSSL` from
 * the model. Fresh installs, and upgrades without the file, get that definition
 * from `copyDefaultConfiguration()`, which only backfills missing files.
 *
 * An install that kept the definition from an older release (V086 deliberately
 * left it in place) still points at the script's default export and may still
 * declare `ignoreSSL` to the model. Offered to every web search app, that would
 * let a model (or a page it read) switch certificate checking off. This
 * migration sets `method: "extractForTool"` and drops `ignoreSSL` from the
 * model-facing parameters. Everything else an admin changed (name, description,
 * `enabled`, other parameters) is kept.
 */

export const version = '123';
export const description = 'web_page_reader_entry_point';

const TOOL_ID = 'webContentExtractor';
const TOOL_FILE = `tools/${TOOL_ID}.json`;
const ENTRY_POINT = 'extractForTool';

export async function precondition(ctx) {
  return (await ctx.fileExists(TOOL_FILE)) || (await ctx.fileExists('config/tools.json'));
}

/**
 * Update one webContentExtractor definition in place.
 * @param {Object} tool
 * @returns {string[]} what changed, empty when nothing did
 */
function harden(tool) {
  const changes = [];
  // A definition an admin pointed at a different script is theirs to keep.
  if (tool.script && tool.script !== `${TOOL_ID}.js`) return changes;

  if (tool.method !== ENTRY_POINT) {
    tool.method = ENTRY_POINT;
    changes.push(`method → ${ENTRY_POINT}`);
  }

  const params = tool.parameters;
  if (params?.properties && 'ignoreSSL' in params.properties) {
    delete params.properties.ignoreSSL;
    changes.push('removed ignoreSSL parameter');
  }
  if (Array.isArray(params?.required) && params.required.includes('ignoreSSL')) {
    params.required = params.required.filter(p => p !== 'ignoreSSL');
  }
  return changes;
}

export async function up(ctx) {
  if (await ctx.fileExists(TOOL_FILE)) {
    const tool = await ctx.readJson(TOOL_FILE);
    if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
      const changes = harden(tool);
      if (changes.length > 0) {
        await ctx.writeJson(TOOL_FILE, tool);
        ctx.log(`Updated ${TOOL_FILE}: ${changes.join(', ')}`);
      } else {
        ctx.log(`${TOOL_FILE} already uses ${ENTRY_POINT}`);
      }
    } else {
      ctx.warn(`${TOOL_FILE} is not an object — skipping`);
    }
  }

  if (await ctx.fileExists('config/tools.json')) {
    const tools = await ctx.readJson('config/tools.json');
    if (!Array.isArray(tools)) {
      ctx.warn('config/tools.json is not an array — skipping');
      return;
    }
    const tool = tools.find(t => t?.id === TOOL_ID);
    if (!tool) {
      ctx.log(`No ${TOOL_ID} entry in config/tools.json — nothing to do`);
      return;
    }
    const changes = harden(tool);
    if (changes.length > 0) {
      await ctx.writeJson('config/tools.json', tools);
      ctx.log(`Updated ${TOOL_ID} in config/tools.json: ${changes.join(', ')}`);
    }
  }
}
