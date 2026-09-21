/**
 * Migration V115 — expose `language` on the existing braveSearch tool
 *
 * `braveSearch` gained a `language` parameter so a model can target one search
 * at a language explicitly, the way it already can with `qwantSearch` and
 * `staanSearch`. The default that the app's web search config injects reaches
 * the tool either way — `runTool` passes its params straight through, and
 * `tools/braveSearch.js` destructures `language` regardless of the schema. What
 * needs this migration is the *declared* parameter: without it the model has no
 * way to know the option exists, and a call that passes it fails validation.
 *
 * A new field on an existing config file is exactly the case
 * `copyDefaultConfiguration()` does not cover: it backfills whole files that
 * are missing from `contents/`, so an install that already has
 * `tools/braveSearch.json` would keep the old schema forever.
 *
 * Only the one property is added, and only when it is absent, so an admin who
 * has edited the tool's descriptions or limits keeps every other change.
 */

export const version = '115';
export const description = 'Add the language parameter to the braveSearch tool';

/** The property as `server/defaults/tools/braveSearch.json` declares it in V115. */
const LANGUAGE_PARAMETER = {
  type: 'string',
  description: {
    en: "Language or locale for the search results, e.g. 'en', 'de' or 'en-GB' (default: the user's language)",
    de: "Sprache oder Gebietsschema für die Suchergebnisse, z. B. 'en', 'de' oder 'en-GB' (Standard: die Sprache des Benutzers)"
  }
};

export async function precondition(ctx) {
  return await ctx.fileExists('tools/braveSearch.json');
}

export async function up(ctx) {
  const tool = await ctx.readJson('tools/braveSearch.json');

  if (!tool || typeof tool !== 'object') {
    ctx.warn('tools/braveSearch.json could not be read — skipping');
    return;
  }

  const properties = tool.parameters?.properties;
  if (!properties || typeof properties !== 'object') {
    ctx.warn('tools/braveSearch.json has no parameters.properties — skipping');
    return;
  }

  if (properties.language) {
    ctx.log('braveSearch already declares a language parameter — leaving it as configured');
    return;
  }

  properties.language = { ...LANGUAGE_PARAMETER };
  await ctx.writeJson('tools/braveSearch.json', tool);
  ctx.log('Added the language parameter to the braveSearch tool');
}
