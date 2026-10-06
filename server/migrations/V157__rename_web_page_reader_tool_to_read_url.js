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
 * (its id and, when it is the shipped file, its filename), every reference to it
 * in app, workflow and agent tool lists, and the id where it is named in a
 * prompt (so an app's instructions do not tell the model to call a tool that no
 * longer exists). The implementation file (`webContentExtractor.js`) and the
 * tool's display name are unchanged.
 *
 * Ordering note: performInitialSetup() copies missing defaults BEFORE
 * migrations run, so an upgrading install already has the fresh
 * `tools/read_url.json` next to its own `tools/webContentExtractor.json`. The
 * install's own file is authoritative (it may carry admin edits — a disabled
 * flag, tuned parameters), so we write it over the fresh default and delete the
 * old file, leaving exactly one `read_url.json` with the admin's settings. The
 * one exception is a pre-existing `read_url.json` that is a different tool (an
 * admin's own, by the same brand-new id): that collision is left for the admin.
 */

export const version = '157';
export const description = 'rename_web_page_reader_tool_to_read_url';

const OLD_ID = 'webContentExtractor';
const NEW_ID = 'read_url';

/** The page reader's implementation script — the signal that a tool definition is the reader. */
const READER_SCRIPT = 'webContentExtractor.js';

/**
 * The old id as a standalone token: a whole word (so a longer id like
 * `webContentExtractorPro` is left alone) and not the implementation file name
 * `webContentExtractor.js` (which keeps its name). Matches a bare `tools` entry
 * (`"webContentExtractor"`) and a mention in prompt text ("use the
 * webContentExtractor tool") alike.
 */
const OLD_ID_TOKEN = /\bwebContentExtractor\b(?!\.js)/g;

/**
 * Rename every reference to OLD_ID inside a config object: `tools` entries
 * (`app.tools`, a workflow node's `config.tools`, an agent's `tools`) and the
 * id where it is named in a string field such as a `system`/`prompt` text, so
 * an upgraded app does not tell the model to call a tool that no longer exists.
 * Mutates `value` in place; returns how many strings changed.
 *
 * @param {unknown} value
 * @returns {number} how many string values were rewritten
 */
function renameToolReferences(value) {
  let count = 0;
  const rewrite = (container, key, str) => {
    const next = str.replace(OLD_ID_TOKEN, NEW_ID);
    if (next !== str) {
      container[key] = next;
      count += 1;
    }
  };
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') rewrite(value, index, item);
      else count += renameToolReferences(item);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string') rewrite(value, key, val);
      else count += renameToolReferences(val);
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
  const target = `tools/${NEW_ID}.json`;
  for (const file of await ctx.listFiles('tools', '*.json')) {
    if (file === `${NEW_ID}.json`) continue; // the target itself, handled below
    const tool = await ctx.readJson(`tools/${file}`);
    if (!tool || typeof tool !== 'object' || tool.id !== OLD_ID) continue;
    tool.id = NEW_ID;
    // Write the admin's definition to read_url.json, overwriting the fresh
    // default that performInitialSetup copied in (identical shipped content, so
    // nothing new is lost), then drop the old file so the id is not duplicated.
    // But if read_url.json already holds a *different* tool — an admin's own
    // tool that happens to use this brand-new id — do not clobber it: leave
    // both files for the admin to resolve. The page reader's own default is
    // recognised by its script; only that is safe to overwrite.
    if (await ctx.fileExists(target)) {
      const existing = await ctx.readJson(target);
      if (existing && existing.script !== READER_SCRIPT) {
        ctx.warn(
          `tools/${target} already exists and is not the page reader; leaving tools/${file} in place. Resolve the read_url id collision manually.`
        );
        continue;
      }
    }
    await ctx.writeJson(target, tool);
    await ctx.deleteFile(`tools/${file}`);
    ctx.log(`Renamed tool definition tools/${file} → ${target} (id → ${NEW_ID})`);
  }

  // An install that already carries the tool as tools/read_url.json (its id
  // never left as the old one) needs nothing; the id is already current.

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
      const renamed = renameToolReferences(config);
      if (renamed > 0) {
        await ctx.writeJson(`${dir}/${file}`, config);
        ctx.log(`Renamed ${renamed} ${OLD_ID} reference(s) → ${NEW_ID} in ${dir}/${file}`);
      }
    }
  }
}
