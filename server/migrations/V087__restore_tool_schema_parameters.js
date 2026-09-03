/**
 * Migration V087 — restore tool-schema parameters lost to config drift
 *
 * `performInitialSetup` only copies files that are *missing* from contents/, so
 * a tool config written by an older release keeps its old parameter schema for
 * ever while the shipped default gains fields.
 *
 * That silently disabled web search content extraction. `braveSearch.json` in
 * an existing install declares only `query`, while the shipped default declares
 * `query`, `extractContent`, `maxResults` and `contentMaxLength`.
 * `resolveWebsearchTool` applies an app's `websearch` config by writing
 * `default` onto those schema properties — so with them absent every
 * assignment is a no-op, the model can only ever pass `query`, and
 * `braveSearch.js` falls back to its own `extractContent = false`. The app then
 * answers from search-result snippets instead of page content: for a
 * "who is X" question that means stale directory blurbs outranking the current
 * source, and `app.websearch.extractContent` / `maxResults` /
 * `contentMaxLength` having no effect at all no matter what an admin sets.
 *
 * Parameters are merged in from the shipped default with existing values
 * winning, so an admin's own descriptions, enums and defaults are preserved and
 * only genuinely absent keys are added.
 */

export const version = '087';
export const description = 'restore_tool_schema_parameters';

export async function precondition(ctx) {
  const files = await ctx.listFiles('tools', '*.json');
  return Array.isArray(files) && files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('tools', '*.json');
  let patched = 0;

  for (const file of files) {
    let shipped;
    try {
      shipped = await ctx.readDefaultJson(`tools/${file}`);
    } catch {
      continue; // not a shipped tool (admin-authored) — nothing to reconcile
    }
    const shippedProps = shipped?.parameters?.properties;
    if (!shippedProps || typeof shippedProps !== 'object') continue;

    const tool = await ctx.readJson(`tools/${file}`);
    if (!tool || typeof tool !== 'object') continue;
    if (!tool.parameters || typeof tool.parameters !== 'object') continue;
    if (!tool.parameters.properties || typeof tool.parameters.properties !== 'object') continue;

    const missing = Object.keys(shippedProps).filter(
      key => !Object.prototype.hasOwnProperty.call(tool.parameters.properties, key)
    );
    if (missing.length === 0) continue;

    // Existing values always win; only the absent properties are added.
    ctx.mergeDefaults(tool.parameters.properties, shippedProps);
    await ctx.writeJson(`tools/${file}`, tool);
    patched += 1;
    ctx.log(`Restored parameters on tools/${file}: ${missing.join(', ')}`);
  }

  if (patched === 0) ctx.log('All tool schemas already carry their shipped parameters');
}
