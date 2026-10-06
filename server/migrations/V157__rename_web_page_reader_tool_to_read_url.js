/**
 * Migration V157 — rename the web page reader tool id webContentExtractor → read_url
 *
 * The model chooses a tool by its id, and `webContentExtractor` read as a
 * camelCase blob next to plain ids like `braveSearch`; it also looked close
 * enough to a generic "read" that the model sometimes pointed it at a skill's
 * bundled file (a relative path, not a URL) and got "Invalid URL". `read_url`
 * says plainly what the tool does — open a URL — which keeps it distinct from
 * `read_skill_resource`. The shipped definition now lives at
 * `tools/read_url.json`; fresh installs get it from server/defaults.
 *
 * This migration renames an existing installation's copy: the tool definition
 * (its id and, when it is the shipped file, its filename) and every reference
 * to it in app, workflow and agent tool lists. The implementation file
 * (`webContentExtractor.js`) and the tool's display name are unchanged.
 *
 * Ordering note: performInitialSetup() copies missing defaults BEFORE
 * migrations run, so an upgrading install already has the fresh
 * `tools/read_url.json` next to its own `tools/webContentExtractor.json`. The
 * install's own file is authoritative (it may carry admin edits — a disabled
 * flag, tuned parameters), so we write it over the fresh default and delete the
 * old file, leaving exactly one `read_url.json` with the admin's settings.
 */

export const version = '157';
export const description = 'rename_web_page_reader_tool_to_read_url';

const OLD_ID = 'webContentExtractor';
const NEW_ID = 'read_url';

/**
 * Rename OLD_ID → NEW_ID in every `tools` array nested anywhere in `value`
 * (an app's `tools`, a workflow node's `config.tools`, an agent's `tools`).
 *
 * @param {unknown} value
 * @returns {number} how many entries were renamed
 */
function renameInToolsArrays(value) {
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) count += renameInToolsArrays(item);
    return count;
  }
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (key === 'tools' && Array.isArray(val)) {
        val.forEach((tool, index) => {
          if (tool === OLD_ID) {
            val[index] = NEW_ID;
            count += 1;
          }
        });
      }
      count += renameInToolsArrays(val);
    }
  }
  return count;
}

export async function precondition(ctx) {
  if (await ctx.fileExists('config/tools.json')) return true;
  for (const dir of ['tools', 'apps', 'workflows', 'agents']) {
    if ((await ctx.listFiles(dir, '*.json')).length > 0) return true;
  }
  return false;
}

/**
 * Rename the tool definition itself: the per-file definition in
 * `contents/tools/`, and a legacy aggregate `config/tools.json` if one survived
 * from before V068.
 *
 * @param {Object} ctx
 */
async function renameToolDefinition(ctx) {
  for (const file of await ctx.listFiles('tools', '*.json')) {
    const tool = await ctx.readJson(`tools/${file}`);
    if (!tool || typeof tool !== 'object' || tool.id !== OLD_ID) continue;
    tool.id = NEW_ID;
    // Write the admin's definition to read_url.json, overwriting the fresh
    // default that performInitialSetup copied in (identical shipped content, so
    // nothing new is lost), then drop the old file so the id is not duplicated.
    await ctx.writeJson(`tools/${NEW_ID}.json`, tool);
    if (file !== `${NEW_ID}.json`) {
      await ctx.deleteFile(`tools/${file}`);
    }
    ctx.log(`Renamed tool definition tools/${file} → tools/${NEW_ID}.json (id → ${NEW_ID})`);
  }

  if (await ctx.fileExists('config/tools.json')) {
    const tools = await ctx.readJson('config/tools.json');
    if (Array.isArray(tools)) {
      let changed = false;
      for (const tool of tools) {
        if (tool && tool.id === OLD_ID) {
          tool.id = NEW_ID;
          changed = true;
        }
      }
      if (changed) {
        await ctx.writeJson('config/tools.json', tools);
        ctx.log(`Renamed ${OLD_ID} → ${NEW_ID} in legacy config/tools.json`);
      }
    }
  }
}

export async function up(ctx) {
  await renameToolDefinition(ctx);

  for (const dir of ['apps', 'workflows', 'agents']) {
    for (const file of await ctx.listFiles(dir, '*.json')) {
      const config = await ctx.readJson(`${dir}/${file}`);
      if (!config || typeof config !== 'object') continue;
      const renamed = renameInToolsArrays(config);
      if (renamed > 0) {
        await ctx.writeJson(`${dir}/${file}`, config);
        ctx.log(`Renamed ${renamed} ${OLD_ID} reference(s) → ${NEW_ID} in ${dir}/${file}`);
      }
    }
  }
}
