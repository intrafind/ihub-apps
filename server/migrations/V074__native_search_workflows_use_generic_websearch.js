/**
 * Migration V074 — Point default research workflows at generic `webSearch`
 *
 * `googleSearch` is retired as a tool id (see V073): native web search is now
 * resolved at request time from the generic `webSearch` marker, based on the
 * step's model provider (Google/OpenAI/Anthropic get native search, others
 * fall back to braveSearch) — see toolLoader.resolveNativeWebSearchProvider().
 *
 * The bundled research workflows hardcoded `"tools": ["googleSearch"]` on
 * their researcher node, which silently loses web search entirely once
 * `googleSearch` stops resolving to anything, and only ever worked when the
 * workflow's model happened to be a Gemini model. This swaps each workflow's
 * researcher node over to `"tools": ["webSearch"]` so it keeps working on
 * Gemini and also gains native search on OpenAI/Anthropic models. Only
 * touches installations that still have the exact untouched default value —
 * any node a user already customized is left alone.
 */

const TARGETS = [
  { file: 'workflows/iterative-research-human.json', nodeId: 'researcher' },
  { file: 'workflows/iterative-research-auto.json', nodeId: 'researcher' },
  { file: 'workflows/approval-workflow.json', nodeId: 'research' }
];

export const version = '074';
export const description = 'native_search_workflows_use_generic_websearch';

export async function precondition(ctx) {
  for (const { file } of TARGETS) {
    if (await ctx.fileExists(file)) {
      return true;
    }
  }
  return false;
}

export async function up(ctx) {
  let updated = 0;

  for (const { file, nodeId } of TARGETS) {
    if (!(await ctx.fileExists(file))) continue;

    const workflow = await ctx.readJson(file);
    const node = Array.isArray(workflow.nodes) ? workflow.nodes.find(n => n.id === nodeId) : null;
    if (!node?.config) continue;

    const tools = node.config.tools;
    if (!Array.isArray(tools) || tools.length !== 1 || tools[0] !== 'googleSearch') {
      ctx.log(`Skipping ${file} (${nodeId}) — tools already customized, leaving as-is`);
      continue;
    }

    node.config.tools = ['webSearch'];
    await ctx.writeJson(file, workflow);
    updated++;
    ctx.log(`Updated ${file} (${nodeId}): googleSearch → webSearch`);
  }

  ctx.log(`Updated ${updated} workflow file(s) to use generic webSearch`);
}
