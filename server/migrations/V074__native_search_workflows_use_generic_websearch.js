/**
 * Migration V074 — Point workflow nodes at the generic `webSearch` marker
 *
 * `googleSearch` is retired as a tool id (see V073): native web search is now
 * resolved at request time from the generic `webSearch` marker, based on the
 * step's model provider (Google/OpenAI/Anthropic get native search, others
 * fall back to braveSearch) — see toolLoader.resolveNativeWebSearchProvider().
 *
 * Any workflow node with `googleSearch` in its tools array — the bundled
 * research workflows hardcoded `"tools": ["googleSearch"]` on their researcher
 * node, and users may have copied that pattern into their own workflows —
 * would silently lose web search entirely once `googleSearch` stops resolving
 * to anything, and it only ever worked when the node's model happened to be a
 * Gemini model. This rewrites every occurrence of `googleSearch` in any
 * workflow node's tools to the generic `webSearch` marker, which keeps
 * Gemini grounding working and also gains native search on OpenAI/Anthropic
 * models. Nodes already using `webSearch` are untouched.
 */

export const version = '074';
export const description = 'native_search_workflows_use_generic_websearch';

export async function precondition(ctx) {
  const files = await ctx.listFiles('workflows', '*.json');
  return Array.isArray(files) && files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('workflows', '*.json');
  let updatedFiles = 0;

  for (const file of files) {
    const workflow = await ctx.readJson(`workflows/${file}`);
    if (!Array.isArray(workflow.nodes)) continue;

    let changed = false;
    for (const node of workflow.nodes) {
      const tools = node?.config?.tools;
      if (!Array.isArray(tools) || !tools.includes('googleSearch')) continue;

      // Replace googleSearch with the generic webSearch marker, deduping in
      // case the node already lists webSearch too.
      node.config.tools = [...new Set(tools.map(id => (id === 'googleSearch' ? 'webSearch' : id)))];
      changed = true;
      ctx.log(`Updated workflows/${file} (${node.id}): googleSearch → webSearch`);
    }

    if (changed) {
      await ctx.writeJson(`workflows/${file}`, workflow);
      updatedFiles++;
    }
  }

  ctx.log(`Updated ${updatedFiles} workflow file(s) to use the generic webSearch marker`);
}
