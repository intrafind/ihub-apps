/**
 * Migration V068 — Split config/tools.json into individual tool files
 *
 * Tools are no longer stored as one shared config/tools.json array. Like
 * apps, prompts, and models, each tool now lives in its own file under
 * contents/tools/. There is no backward-compatible fallback: this migration
 * is the one-time cutover for existing installations, and config/tools.json
 * is deleted once every tool has been split out.
 *
 * Also removes tools that have been retired from the product defaults
 * (deepResearch, answerReducer, evaluator, queryRewriter, researchPlanner),
 * whether they're still sitting in the legacy array or already split into
 * their own file by an earlier build.
 */

import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import { isValidId } from '../utils/pathSecurity.js';

export const version = '068';
export const description = 'split_tools_config_into_individual_files';

const RETIRED_TOOL_IDS = [
  'deepResearch',
  'answerReducer',
  'evaluator',
  'queryRewriter',
  'researchPlanner'
];

/**
 * Runtime-only expansions of multi-function tools (id like `base_method`,
 * carrying a `method` without a `script`) were never meant to be persisted
 * as their own file — skip them rather than splitting them out.
 */
function isExpandedRuntimeEntry(tool) {
  return Boolean(tool.method) && tool.isAgentTool !== true && !tool.script;
}

export async function precondition(ctx) {
  return await ctx.fileExists('config/tools.json');
}

export async function up(ctx) {
  const tools = await ctx.readJson('config/tools.json');
  if (!Array.isArray(tools)) {
    ctx.warn('config/tools.json is not an array — leaving it in place');
    return;
  }

  const toolsDir = path.join(getRootDir(), 'contents', 'tools');
  await fs.mkdir(toolsDir, { recursive: true });

  let migrated = 0;
  let skipped = 0;
  let retired = 0;

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !tool.id) {
      skipped++;
      continue;
    }

    if (RETIRED_TOOL_IDS.includes(tool.id)) {
      retired++;
      continue;
    }

    if (isExpandedRuntimeEntry(tool) || !isValidId(tool.id)) {
      skipped++;
      continue;
    }

    // Legacy content wins over anything already at this path — it reflects
    // the installation's actual, possibly customized, tool definition.
    await ctx.writeJson(`tools/${tool.id}.json`, tool);
    migrated++;
  }

  // Clean up any already-split files for retired tools (e.g. left over from
  // an installation that ran an earlier build of the per-file split).
  for (const id of RETIRED_TOOL_IDS) {
    if (await ctx.fileExists(`tools/${id}.json`)) {
      await ctx.deleteFile(`tools/${id}.json`);
      retired++;
    }
  }

  await ctx.deleteFile('config/tools.json');

  ctx.log(
    `Split ${migrated} tool(s) into contents/tools/, removed ${retired} retired tool file(s)` +
      (skipped > 0 ? `, skipped ${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'}` : '') +
      ', and deleted config/tools.json'
  );
}
