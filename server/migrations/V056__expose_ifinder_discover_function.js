/**
 * Migration V056 — Expose the iFinder.discover function in tools.json
 *
 * The `discover` function already existed on the iFinder service and was
 * invokable via the admin "build memory from tool" endpoint, but it was not
 * declared in config/tools.json so the tool dispatcher couldn't surface it
 * to agents or workflows. This migration adds the function entry so that
 * `iFinder_discover` becomes a normal callable tool function for everyone.
 */
export const version = '056';
export const description = 'expose_ifinder_discover_function';

const DISCOVER_FN = {
  description: {
    en: "Probe an iFinder search profile and return a corpus map: totals, top facet values, and sample document titles. Use this to learn what data is available and which fields can be filtered before issuing a real search.",
    de: "Ein iFinder-Suchprofil sondieren und eine Korpus-Karte zurückgeben: Gesamtzahlen, häufigste Facettenwerte und Beispieltitel. Verwende dies, um zu lernen, welche Daten verfügbar sind und welche Felder gefiltert werden können, bevor eine echte Suche ausgeführt wird."
  },
  parameters: {
    type: 'object',
    properties: {
      searchProfile: {
        type: 'string',
        description: {
          en: 'Search profile ID to probe.',
          de: 'Suchprofil-ID zum Sondieren.'
        }
      },
      query: {
        type: 'string',
        description: {
          en: "Optional scope query. Defaults to '*:*' (everything).",
          de: "Optionale Bereichsabfrage. Standard ist '*:*' (alles)."
        },
        default: '*:*'
      },
      facets: {
        type: 'array',
        items: { type: 'string' },
        description: {
          en: 'Facet fields to probe (defaults to a sensible set).',
          de: 'Zu sondierende Facettenfelder (Standardwerte werden verwendet).'
        }
      },
      sampleSize: {
        type: 'integer',
        description: {
          en: 'Max sample documents to include (default: 10).',
          de: 'Max. Anzahl der einzuschließenden Beispieldokumente (Standard: 10).'
        },
        default: 10,
        minimum: 0,
        maximum: 50
      }
    },
    required: ['searchProfile']
  }
};

export async function precondition(ctx) {
  return await ctx.fileExists('config/tools.json');
}

export async function up(ctx) {
  const tools = await ctx.readJson('config/tools.json');
  if (!Array.isArray(tools)) {
    ctx.warn('config/tools.json is not an array — skipping');
    return;
  }

  const iFinder = tools.find(t => t && t.id === 'iFinder');
  if (!iFinder) {
    ctx.warn('iFinder tool entry not found — skipping');
    return;
  }
  if (!iFinder.functions || typeof iFinder.functions !== 'object') {
    iFinder.functions = {};
  }
  if (iFinder.functions.discover) {
    ctx.log('iFinder.discover already declared — leaving as-is');
    return;
  }
  iFinder.functions.discover = DISCOVER_FN;

  await ctx.writeJson('config/tools.json', tools);
  ctx.log('Declared iFinder.discover in tools.json');
}
