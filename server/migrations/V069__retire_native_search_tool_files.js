/**
 * Migration V069 — Retire the googleSearch/webSearch tool files
 *
 * Native (provider-handled) web search — Google Search grounding, OpenAI Web
 * Search, and now Anthropic Web Search — is no longer represented as a tool.
 * It's resolved directly by toolLoader.resolveAppNativeWebSearch() /
 * resolveNativeWebSearchProvider() from the app's unified `websearch` config
 * (or a workflow node's generic `webSearch` tool id) and injected straight
 * into the provider request by the adapter. Only `braveSearch` remains a
 * real, script-backed tool.
 *
 * This deletes the now-unused `googleSearch.json` / `webSearch.json` tool
 * files left behind by V068's config/tools.json → contents/tools/ split.
 */

const RETIRED_TOOL_IDS = ['googleSearch', 'webSearch'];

export const version = '069';
export const description = 'retire_native_search_tool_files';

export async function precondition(ctx) {
  for (const id of RETIRED_TOOL_IDS) {
    if (await ctx.fileExists(`tools/${id}.json`)) {
      return true;
    }
  }
  return false;
}

export async function up(ctx) {
  let removed = 0;
  for (const id of RETIRED_TOOL_IDS) {
    if (await ctx.fileExists(`tools/${id}.json`)) {
      await ctx.deleteFile(`tools/${id}.json`);
      removed++;
    }
  }
  ctx.log(
    `Removed ${removed} retired tool file(s) — native web search is now resolved directly by the model adapter, not a tool`
  );
}
