/**
 * Migration V086 — clean up the web search tools V025 left behind
 *
 * V025 folded the fragmented web search tools into `app.websearch`, but it only
 * rewrote `app.tools[]`. Two leftovers stayed behind on existing installs:
 *
 *  1. The tool config files themselves. `enhancedWebSearch.json` still points at
 *     `enhancedWebSearch.js`, which no longer exists, and `webSearch.json` /
 *     `googleSearch.json` / `tavilySearch.json` describe tools nothing
 *     implements. Web search is now either native (resolved on the provider
 *     request, never a named tool) or the script-backed `braveSearch` fallback.
 *     `braveSearch` and `webContentExtractor` are deliberately kept: their
 *     scripts are still present.
 *
 *  2. The prompts. Apps kept instructing the model to call those tools by name
 *     ("use the enhancedWebSearch, google_search or web_search tool"). The model
 *     obliges, the loop answers with a hallucinated-tool envelope, and the round
 *     is wasted — which on a web search app shows up as a visibly worse answer.
 *     Only the dangling tool names are rewritten, so an admin's surrounding
 *     wording is preserved.
 */

export const version = '086';
export const description = 'cleanup_removed_websearch_tools';

/** Tool configs for web search tools that no longer have an implementation. */
const REMOVED_TOOL_FILES = [
  'enhancedWebSearch.json',
  'webSearch.json',
  'googleSearch.json',
  'tavilySearch.json'
];

/** Tool identifiers that may still be named in prompt text. */
const REMOVED_TOOL_NAMES = [
  'enhancedWebSearch',
  'tavilySearch',
  'googleSearch',
  'google_search',
  'webSearch',
  'web_search'
];

/**
 * Matches one removed tool name, or a run of them joined by a separator
 * ("a, b or c"), so an alternation collapses into a single phrase instead of
 * repeating it once per name. Built fresh per call: a shared /g regex carries
 * `lastIndex` between uses.
 */
function toolNameRun() {
  const names = REMOVED_TOOL_NAMES.join('|');
  return new RegExp(
    `\\b(?:${names})\\b(?:\\s*(?:,|/|or|and|oder|und)\\s*\\b(?:${names})\\b)*`,
    'g'
  );
}

/**
 * Replace every run of removed tool names in `text` with `phrase`.
 * @param {string} text
 * @param {string} phrase
 * @returns {string} rewritten text (identical reference-wise if nothing matched)
 */
function stripToolNames(text, phrase) {
  return text.replace(toolNameRun(), phrase);
}

/** Locale-appropriate replacement for a removed tool name. */
function phraseFor(locale) {
  return String(locale).toLowerCase().startsWith('de') ? 'Websuche' : 'web search';
}

/**
 * Rewrite dangling tool names in a localized string map, in place.
 * @param {Object} field - localized map (e.g. {en: '…', de: '…'}) or a string
 * @param {string} fallbackLocale - locale to assume for a plain string
 * @returns {number} number of locales changed
 */
function rewriteLocalized(field, fallbackLocale = 'en') {
  if (typeof field === 'string') return 0; // handled by the caller (needs reassignment)
  if (!field || typeof field !== 'object') return 0;
  let changed = 0;
  for (const [locale, value] of Object.entries(field)) {
    if (typeof value !== 'string') continue;
    const next = stripToolNames(value, phraseFor(locale || fallbackLocale));
    if (next !== value) {
      field[locale] = next;
      changed += 1;
    }
  }
  return changed;
}

export async function precondition(ctx) {
  const apps = await ctx.listFiles('apps', '*.json');
  return Array.isArray(apps) && apps.length > 0;
}

export async function up(ctx) {
  // 1. Drop the tool configs whose implementation is gone.
  let removed = 0;
  for (const file of REMOVED_TOOL_FILES) {
    if (await ctx.fileExists(`tools/${file}`)) {
      await ctx.deleteFile(`tools/${file}`);
      removed += 1;
      ctx.log(`Removed stale web search tool config tools/${file}`);
    }
  }
  if (removed === 0) ctx.log('No stale web search tool configs present');

  // 2. Rewrite prompts that still name those tools.
  const files = await ctx.listFiles('apps', '*.json');
  let patched = 0;
  for (const file of files) {
    const app = await ctx.readJson(`apps/${file}`);
    if (!app || typeof app !== 'object') continue;

    let changed = 0;
    for (const key of ['system', 'prompt', 'greeting', 'messagePlaceholder']) {
      if (typeof app[key] === 'string') {
        const next = stripToolNames(app[key], phraseFor('en'));
        if (next !== app[key]) {
          app[key] = next;
          changed += 1;
        }
      } else {
        changed += rewriteLocalized(app[key]);
      }
    }

    if (changed > 0) {
      await ctx.writeJson(`apps/${file}`, app);
      patched += 1;
      ctx.log(`Rewrote removed web search tool names in apps/${file}`);
    }
  }

  if (patched === 0) ctx.log('No app prompts referenced the removed web search tools');
}
