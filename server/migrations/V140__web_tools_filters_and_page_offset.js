/**
 * Migration V140 — new parameters on the web search tools and the page reader
 *
 * - `webContentExtractor` gained `offset`: the page reader now reports
 *   `truncated` / `nextOffset`, and the model reads on in a long page by calling
 *   it again with the offset.
 * - `braveSearch` and `qwantSearch` gained `freshness` and `includeDomains`,
 *   `staanSearch` gained `freshness` (it already had `includeDomains`). Every
 *   provider now honours both: natively where the provider can (Brave
 *   freshness, Staan domains), otherwise through `site:` in the query and by
 *   dropping dated results that are too old.
 *
 * `copyDefaultConfiguration()` only backfills whole files missing from
 * `contents/`, so an install that already has these tool files keeps the old
 * schema without this — and a model could not know the options exist.
 *
 * Only a property that is absent is added. Everything else an admin changed
 * (names, descriptions, limits, `enabled`) is kept, and a definition an admin
 * pointed at another script is left alone. Both layouts are handled: one file
 * per tool (`tools/<id>.json`) and the legacy `config/tools.json` array.
 */

export const version = '140';
export const description = 'web_tools_filters_and_page_offset';

/** `offset` as `server/defaults/tools/webContentExtractor.json` declares it in V140. */
const OFFSET_PARAMETER = {
  type: 'integer',
  description: {
    en: "Character offset to start reading at, for reading on in a long page: pass the 'nextOffset' of the previous result (default: 0)",
    de: "Zeichenposition, ab der gelesen wird, um eine lange Seite weiterzulesen: den 'nextOffset' des vorigen Ergebnisses übergeben (Standard: 0)"
  },
  default: 0,
  minimum: 0
};

/** `freshness` as the Brave and Qwant tool defaults declare it in V140. */
const FRESHNESS_PARAMETER = {
  type: 'string',
  enum: ['day', 'week', 'month', 'year'],
  description: {
    en: 'Only return results from the last day, week, month or year. Use it when the question is about recent events or the user asks for current information.',
    de: 'Nur Ergebnisse aus dem letzten Tag, der letzten Woche, dem letzten Monat oder Jahr zurückgeben. Verwenden, wenn es um aktuelle Ereignisse geht oder der Benutzer nach aktuellen Informationen fragt.'
  }
};

/**
 * `freshness` as the Staan tool default declares it in V140. Staan results carry
 * no date, so the filter cannot drop anything and the description says so.
 */
const STAAN_FRESHNESS_PARAMETER = {
  ...FRESHNESS_PARAMETER,
  description: {
    en: 'Prefer results from the last day, week, month or year. Best effort: Staan results are not dated, so older pages can still be returned; check the date of what you cite. Use it when the question is about recent events or the user asks for current information.',
    de: 'Ergebnisse aus dem letzten Tag, der letzten Woche, dem letzten Monat oder Jahr bevorzugen. Ohne Gewähr: Staan-Ergebnisse haben kein Datum, ältere Seiten können also trotzdem zurückkommen; das Datum der zitierten Seiten prüfen. Verwenden, wenn es um aktuelle Ereignisse geht oder der Benutzer nach aktuellen Informationen fragt.'
  }
};

/** `includeDomains` as the Brave and Qwant tool defaults declare it in V140. */
const INCLUDE_DOMAINS_PARAMETER = {
  type: 'array',
  items: { type: 'string' },
  description: {
    en: "Only return results from these domains, e.g. ['example.com']. Maximum 10. Use it when the user names a site or domain.",
    de: "Nur Ergebnisse von diesen Domains zurückgeben, z. B. ['example.com']. Maximal 10. Verwenden, wenn der Benutzer eine Website oder Domain nennt."
  }
};

/** Parameters each tool gains, by tool id. */
export const NEW_PARAMETERS = {
  webContentExtractor: { offset: OFFSET_PARAMETER },
  braveSearch: { freshness: FRESHNESS_PARAMETER, includeDomains: INCLUDE_DOMAINS_PARAMETER },
  qwantSearch: { freshness: FRESHNESS_PARAMETER, includeDomains: INCLUDE_DOMAINS_PARAMETER },
  staanSearch: { freshness: STAAN_FRESHNESS_PARAMETER }
};

const TOOL_IDS = Object.keys(NEW_PARAMETERS);

export async function precondition(ctx) {
  for (const id of TOOL_IDS) {
    if (await ctx.fileExists(`tools/${id}.json`)) return true;
  }
  return await ctx.fileExists('config/tools.json');
}

/**
 * Add the missing parameters to one tool definition in place.
 * @param {Object} tool
 * @returns {string[]} names of the parameters added
 */
function addParameters(tool) {
  const additions = NEW_PARAMETERS[tool?.id];
  if (!additions) return [];
  // A definition an admin pointed at a different script is theirs to keep.
  if (tool.script && tool.script !== `${tool.id}.js`) return [];
  const properties = tool.parameters?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];

  const added = [];
  for (const [name, schema] of Object.entries(additions)) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) continue;
    properties[name] = structuredClone(schema);
    added.push(name);
  }
  return added;
}

export async function up(ctx) {
  for (const id of TOOL_IDS) {
    const file = `tools/${id}.json`;
    if (!(await ctx.fileExists(file))) continue;
    const tool = await ctx.readJson(file);
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      ctx.warn(`${file} is not an object — skipping`);
      continue;
    }
    const added = addParameters(tool);
    if (added.length > 0) {
      await ctx.writeJson(file, tool);
      ctx.log(`Added ${added.join(', ')} to ${file}`);
    } else {
      ctx.log(`${file} needs no new parameters`);
    }
  }

  if (await ctx.fileExists('config/tools.json')) {
    const tools = await ctx.readJson('config/tools.json');
    if (!Array.isArray(tools)) {
      ctx.warn('config/tools.json is not an array — skipping');
      return;
    }
    const changed = [];
    for (const tool of tools) {
      const added = addParameters(tool);
      if (added.length > 0) changed.push(`${tool.id} (${added.join(', ')})`);
    }
    if (changed.length > 0) {
      await ctx.writeJson('config/tools.json', tools);
      ctx.log(`Added parameters in config/tools.json: ${changed.join('; ')}`);
    }
  }
}
