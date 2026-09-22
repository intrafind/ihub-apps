/**
 * Migration V125 — point the iFinder search tool at the ifinder-search skill
 *
 * `performInitialSetup` only copies files that are *missing* from contents/, so
 * an installation that already has `tools/iFinder.json` never picks up a
 * reworded description afterwards. The `search` description exists everywhere,
 * so nothing short of an explicit refresh would reach it.
 *
 * What is added is one sentence naming the skill and its MCP resource URI. The
 * skill holds what no tool description has room for — the full IntraFind
 * operator set, the discovery loop, and the table of what to do when a search
 * returns nothing or the wrong thing. Its reference files are now resources of
 * their own (`ihub://skill/ifinder-search/references/…`), so an external agent
 * that follows the pointer can read all of it. Without the pointer it has no
 * reason to look: MCP resources are passive, and a caller that only sees the
 * tools never learns the skill exists.
 *
 * Refreshed ONLY where the stored text is still character-for-character the
 * description V101 shipped — an admin who reworded it keeps their wording,
 * in every language they declared.
 */

export const version = '125';
export const description = 'ifinder_search_skill_pointer';

/**
 * The description as V101 shipped it. A stored description equal to this has
 * never been edited, so replacing it loses nothing.
 */
const SUPERSEDED_SEARCH_DESCRIPTION = {
  en: 'Search documents in iFinder using the IntraFind query syntax (Lucene plus NEAR/, MODE/, THES/, ENTITY/ and other operators). Field-qualified terms (title:budget, creators:"DOE, John") search the analyzed field; exact-value matching, faceting and sorting need the `.keyword` variant of a text field. Call iFinder_getFields first when unsure which name a field takes.',
  de: 'Dokumente in iFinder mit der IntraFind-Syntax suchen (Lucene plus die Operatoren NEAR/, MODE/, THES/, ENTITY/ und weitere). Feldbezogene Terme (title:budget, creators:"DOE, John") durchsuchen das analysierte Feld; exakte Werte, Facetten und Sortierung benötigen die `.keyword`-Variante eines Textfelds. Bei Unsicherheit zuerst iFinder_getFields aufrufen.'
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
 * Refresh one installation's iFinder search description if it is untouched.
 *
 * @param {Object} tool - The installation's iFinder tool config (mutated).
 * @param {Object} shipped - The shipped default tool config.
 * @returns {boolean} Whether the description was replaced.
 */
function applySearchDescription(tool, shipped) {
  const search = tool?.functions?.search;
  const shippedDescription = shipped?.functions?.search?.description;
  if (!search || !shippedDescription) return false;
  if (!isUnmodified(search.description, SUPERSEDED_SEARCH_DESCRIPTION)) return false;
  search.description = shippedDescription;
  return true;
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
      if (applySearchDescription(tool, shipped)) {
        await ctx.writeJson('tools/iFinder.json', tool);
        ctx.log('Refreshed the search description in tools/iFinder.json');
      } else {
        ctx.log('tools/iFinder.json search description is admin-edited or already current');
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
    if (applySearchDescription(iFinder, shipped)) {
      await ctx.writeJson('config/tools.json', tools);
      ctx.log('Refreshed the search description in the config/tools.json iFinder entry');
    } else {
      ctx.log('config/tools.json iFinder entry is admin-edited or already current');
    }
  }
}
