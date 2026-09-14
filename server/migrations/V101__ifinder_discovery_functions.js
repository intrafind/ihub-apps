/**
 * Migration V101 — iFinder discovery functions and the missing search parameters
 *
 * `performInitialSetup` only copies files that are *missing* from contents/, so
 * an installation that already has `tools/iFinder.json` never picks up
 * functions or parameters added to the shipped default afterwards.
 *
 * Two things were added there:
 *
 * 1. Three discovery functions — `getFields` (the index field catalog, which
 *    reports per field whether it needs a `.keyword` suffix to be filtered,
 *    faceted or sorted), `getFacetValues` (enumerate the values of one facet)
 *    and `listProfiles` (the search profiles the caller can reach). Without
 *    them an MCP client has to guess field names, and guessing `.keyword` wrong
 *    is the single most common reason an iFinder filter silently matches
 *    nothing.
 *
 * 2. Four search parameters the service has always supported but that were
 *    never declared on the tool: `filter`, `sort`, `returnFacets` and `from`.
 *    Undeclared means unreachable — a model calling `iFinder_search` could not
 *    narrow, sort, facet or page a result set at all.
 *
 * Existing values always win, so an admin's own descriptions, defaults and
 * added functions are preserved and only genuinely absent keys are added.
 *
 * Two descriptions are the exception, and a narrow one. `search` and its
 * `query` parameter already exist everywhere, so the merge above would never
 * touch them — and both used to describe a plain keyword search, with no hint
 * that iFinder accepts the IntraFind operators (`NEAR/`, `MODE/`, `THES/`,
 * `ENTITY/`, …) that are its whole advantage over a `query_string` search. They
 * are refreshed, but ONLY where the stored text is still character-for-character
 * the previously shipped default: an admin who reworded either keeps their
 * wording untouched.
 */

export const version = '101';
export const description = 'ifinder_discovery_functions';

const NEW_FUNCTIONS = ['getFields', 'getFacetValues', 'listProfiles'];
const NEW_SEARCH_PARAMS = ['filter', 'sort', 'returnFacets', 'from'];

/**
 * The descriptions as the last release shipped them. A stored description equal
 * to one of these has never been edited, so replacing it loses nothing.
 */
const SUPERSEDED_DESCRIPTIONS = {
  search: {
    en: 'Search for documents in the iFinder system',
    de: 'Nach Dokumenten im iFinder-System suchen'
  },
  query: {
    en: "Search query to find documents in iFinder. Example: 'contract proposals' or 'technical documentation'",
    de: "Suchanfrage zum Finden von Dokumenten in iFinder. Beispiel: 'Vertragsvorschläge' oder 'technische Dokumentation'"
  }
};

/**
 * True when `stored` is still the description this migration supersedes.
 *
 * Compares every language the superseded default declares. A description an
 * admin translated into a further language, or reworded in any one of them, no
 * longer matches and is left alone.
 *
 * @param {*} stored - The description currently on the tool.
 * @param {Object} superseded - The previously shipped description.
 * @returns {boolean}
 */
function isUnmodified(stored, superseded) {
  if (!stored || typeof stored !== 'object') return false;
  const storedKeys = Object.keys(stored).sort();
  const supersededKeys = Object.keys(superseded).sort();
  if (storedKeys.join() !== supersededKeys.join()) return false;
  return supersededKeys.every(lang => stored[lang] === superseded[lang]);
}

/**
 * Merge the shipped default's iFinder functions and search parameters into an
 * installation's tool entry.
 *
 * @param {Object} tool - The installation's iFinder tool config (mutated).
 * @param {Object} shipped - The shipped default tool config.
 * @param {Object} ctx - Migration context.
 * @returns {string[]} Names of the keys that were added.
 */
function applyToolDefaults(tool, shipped, ctx) {
  const added = [];

  if (!tool.functions || typeof tool.functions !== 'object') {
    tool.functions = {};
  }

  for (const fn of NEW_FUNCTIONS) {
    if (!shipped.functions?.[fn]) continue;
    if (tool.functions[fn]) continue;
    tool.functions[fn] = shipped.functions[fn];
    added.push(fn);
  }

  const shippedSearchProps = shipped.functions?.search?.parameters?.properties;
  const searchProps = tool.functions.search?.parameters?.properties;
  if (shippedSearchProps && searchProps) {
    for (const param of NEW_SEARCH_PARAMS) {
      if (!shippedSearchProps[param]) continue;
      if (Object.prototype.hasOwnProperty.call(searchProps, param)) continue;
      searchProps[param] = shippedSearchProps[param];
      added.push(`search.${param}`);
    }
  } else if (!searchProps) {
    ctx.warn('iFinder tool has no search parameter schema — skipping search parameters');
  }

  const search = tool.functions.search;
  if (search && isUnmodified(search.description, SUPERSEDED_DESCRIPTIONS.search)) {
    if (shipped.functions?.search?.description) {
      search.description = shipped.functions.search.description;
      added.push('search.description');
    }
  }
  if (
    searchProps?.query &&
    isUnmodified(searchProps.query.description, SUPERSEDED_DESCRIPTIONS.query)
  ) {
    if (shippedSearchProps?.query?.description) {
      searchProps.query.description = shippedSearchProps.query.description;
      added.push('search.query.description');
    }
  }

  return added;
}

export async function precondition(ctx) {
  return (
    (await ctx.fileExists('tools/iFinder.json')) || (await ctx.fileExists('config/tools.json'))
  );
}

export async function up(ctx) {
  let shipped;
  try {
    shipped = await ctx.readDefaultJson('tools/iFinder.json');
  } catch {
    ctx.warn('Shipped iFinder tool default not found — skipping');
    return;
  }

  // Individual-file layout (the current one, since V068).
  if (await ctx.fileExists('tools/iFinder.json')) {
    const tool = await ctx.readJson('tools/iFinder.json');
    if (tool && typeof tool === 'object') {
      const added = applyToolDefaults(tool, shipped, ctx);
      if (added.length > 0) {
        await ctx.writeJson('tools/iFinder.json', tool);
        ctx.log(`Added to tools/iFinder.json: ${added.join(', ')}`);
      } else {
        ctx.log('tools/iFinder.json already carries the discovery functions');
      }
    } else {
      ctx.warn('tools/iFinder.json is not an object — skipping');
    }
  }

  // Legacy aggregate layout, still read as a fallback by the tools loader.
  if (await ctx.fileExists('config/tools.json')) {
    const tools = await ctx.readJson('config/tools.json');
    if (!Array.isArray(tools)) {
      ctx.warn('config/tools.json is not an array — skipping');
      return;
    }
    const iFinder = tools.find(t => t && t.id === 'iFinder');
    if (!iFinder) {
      ctx.log('No iFinder entry in config/tools.json — nothing to do');
      return;
    }
    const added = applyToolDefaults(iFinder, shipped, ctx);
    if (added.length > 0) {
      await ctx.writeJson('config/tools.json', tools);
      ctx.log(`Added to config/tools.json iFinder entry: ${added.join(', ')}`);
    } else {
      ctx.log('config/tools.json iFinder entry already carries the discovery functions');
    }
  }
}
