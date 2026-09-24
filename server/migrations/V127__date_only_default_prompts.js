/**
 * Migration V127 — shipped prompt texts use `{{date}}`, not `{{timezone}}`
 *
 * The default platform context and two shipped apps (iAssistant, iFinder
 * search) named the user's timezone in their prompt. The timezone differs per
 * user, so the rendered prompt differed per user from its first sentence on —
 * which defeats the providers' prompt (prefix) caching for everything after it
 * (issue #2508). The date alone is what these prompts need.
 *
 * `performInitialSetup` only copies files that are missing from contents/, so
 * existing installations keep the old wording until this migration runs.
 *
 * A text is replaced ONLY when it is still the shipped default: swapping the
 * timezone sentence for its new wording must give exactly the text this release
 * ships. An admin who changed anything else keeps their text; if it still uses
 * `{{timezone}}`, that is logged so they can decide themselves. `{{timezone}}`
 * and `{{time}}` keep working as variables.
 */

export const version = '127';
export const description = 'date_only_default_prompts';

/** The sentence each superseded default used → the sentence the new default uses. */
export const FRAGMENTS = Object.freeze([
  {
    from: "Very important: The user's timezone is {{timezone}}. The current date is {{date}}.",
    to: 'Very important: The current date is {{date}}.'
  },
  {
    from: "Today is {{date}} ({{date_iso}}), the user's timezone is {{timezone}}.",
    to: 'Today is {{date}} ({{date_iso}}).'
  },
  {
    from: 'Heute ist {{date}} ({{date_iso}}), die Zeitzone des Benutzers ist {{timezone}}.',
    to: 'Heute ist {{date}} ({{date_iso}}).'
  }
]);

/** Files and the text fields in them that carried a shipped default. */
export const TARGETS = Object.freeze([
  { file: 'config/platform.json', fields: [['globalPromptVariables', 'context']] },
  { file: 'apps/iassistant.json', fields: [['iassistant', 'extraContext']] },
  {
    file: 'apps/ifinder-search.json',
    fields: [
      ['system', 'en'],
      ['system', 'de']
    ]
  }
]);

function get(obj, path) {
  return path.reduce(
    (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
    obj
  );
}

function set(obj, path, value) {
  const parent = get(obj, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

/**
 * The new default for `stored`, or `null` when it must be left alone.
 *
 * @param {*} stored - The installation's text.
 * @param {*} shipped - The text this release ships for the same field.
 * @returns {string|null}
 */
export function refreshedText(stored, shipped) {
  if (typeof stored !== 'string' || typeof shipped !== 'string') return null;
  if (stored === shipped) return null;
  let swapped = stored;
  for (const { from, to } of FRAGMENTS) swapped = swapped.split(from).join(to);
  return swapped !== stored && swapped === shipped ? shipped : null;
}

export async function precondition(ctx) {
  for (const { file } of TARGETS) {
    if (await ctx.fileExists(file)) return true;
  }
  return false;
}

export async function up(ctx) {
  for (const { file, fields } of TARGETS) {
    if (!(await ctx.fileExists(file))) continue;
    let shipped;
    try {
      shipped = await ctx.readDefaultJson(file);
    } catch {
      ctx.warn(`No shipped default for ${file} — left as is`);
      continue;
    }
    const config = await ctx.readJson(file);
    const updated = [];
    for (const path of fields) {
      const stored = get(config, path);
      const next = refreshedText(stored, get(shipped, path));
      if (next !== null) {
        set(config, path, next);
        updated.push(path.join('.'));
      } else if (typeof stored === 'string' && stored.includes('{{timezone}}')) {
        ctx.warn(
          `${file} ${path.join('.')} was customized and still uses {{timezone}} — left as is. ` +
            'A per-user value early in a prompt keeps providers from caching it.'
        );
      }
    }
    if (updated.length > 0) {
      await ctx.writeJson(file, config);
      ctx.log(`${file}: default text now uses {{date}} only (${updated.join(', ')})`);
    }
  }
}
