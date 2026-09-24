/**
 * Migration V127 — iFinder: document ids for follow-up calls
 *
 * A search hit carries its `id`, but only the message text of earlier turns is
 * replayed to the model, never the tool results. So a document listed in one
 * turn was known by its title alone in the next, and the model passed that
 * title (or the file name, or the deep link) as `documentId` to
 * `iFinder_getMetadata` / `iFinder_getContent` — and got back a bare "not
 * found" or "invalid format" that read like an outage. Titles are not even
 * unique: the same file is usually indexed several times.
 *
 * Three shipped defaults changed for this, and none of them reaches an
 * existing installation on its own, because `performInitialSetup` only copies
 * files that are *missing* from contents/:
 *
 * 1. `tools/iFinder.json` — `getContent` and `getMetadata` now say that
 *    `documentId` is the `id` of a search hit and never a title or link, and
 *    how to obtain it when only the title is known. `getMetadata` also gained
 *    a fuller default projection (`id`, `creators`, `owners`, `creationDate`,
 *    `url`), since the app prompt sends the model there for "dates, authors
 *    or the link".
 * 2. `apps/ifinder-search.json` — the answer rules ask for every document link
 *    as `[title](deepLink "source › location · id")`: the link title renders
 *    as a tooltip telling the user where the link leads, and it carries the
 *    id into the next turn without showing it in the text.
 *
 * Every value is refreshed ONLY where the stored one is still exactly what was
 * previously shipped, in every language it declares — an admin who reworded a
 * description or the prompt keeps their wording. The new value is read from the
 * shipped default at run time, so a later default wins on an untouched install.
 */

export const version = '127';
export const description = 'ifinder_document_id_guidance';

const TOOL_FILE = 'tools/iFinder.json';
const LEGACY_TOOLS_FILE = 'config/tools.json';
const APP_FILE = 'apps/ifinder-search.json';

/**
 * Tool values this migration refreshes, each with the text previously shipped
 * at that path. A stored value equal to it has never been edited.
 */
export const SUPERSEDED_TOOL_VALUES = [
  {
    path: ['functions', 'getContent', 'description'],
    value: {
      en: 'Fetch document content from iFinder for LLM processing',
      de: 'Dokumentinhalt aus iFinder für LLM-Verarbeitung abrufen'
    }
  },
  {
    path: ['functions', 'getContent', 'parameters', 'properties', 'documentId', 'description'],
    value: {
      en: "Document ID to fetch content for. Example: 'doc123456'",
      de: "Dokument-ID für die Inhalte abgerufen werden sollen. Beispiel: 'doc123456'"
    }
  },
  {
    path: ['functions', 'getMetadata', 'description'],
    value: {
      en: 'Fetch detailed metadata for a specific document from iFinder using search endpoint',
      de: 'Detaillierte Metadaten für ein spezifisches Dokument aus iFinder über Suchendpunkt abrufen'
    }
  },
  {
    path: ['functions', 'getMetadata', 'parameters', 'properties', 'documentId', 'description'],
    value: {
      en: "Document ID to fetch metadata for. Example: 'onedrive-d4HF8X5AZOWTbeGW'",
      de: "Dokument-ID für die Metadaten abgerufen werden sollen. Beispiel: 'onedrive-d4HF8X5AZOWTbeGW'"
    }
  },
  {
    path: ['functions', 'getMetadata', 'parameters', 'properties', 'returnFields', 'description'],
    value: {
      en: "Fields to return in metadata response. Default: ['title', 'language', 'accessInfo.*', 'mediaType', 'sourceType', 'file.*', 'sourceLocations.*', 'navigationTree', 'modificationDate', 'indexingDate', 'application', 'contentLength', 'sourceName']",
      de: "In Metadatenantwort zurückzugebende Felder. Standard: ['title', 'language', 'accessInfo.*', 'mediaType', 'sourceType', 'file.*', 'sourceLocations.*', 'navigationTree', 'modificationDate', 'indexingDate', 'application', 'contentLength', 'sourceName']"
    }
  },
  {
    path: ['functions', 'getMetadata', 'parameters', 'properties', 'returnFields', 'default'],
    value: [
      'title',
      'language',
      'accessInfo.*',
      'mediaType',
      'sourceType',
      'file.*',
      'sourceLocations.*',
      'navigationTree',
      'modificationDate',
      'indexingDate',
      'application',
      'contentLength',
      'sourceName'
    ]
  }
];

/** The app system prompt as previously shipped, per locale. */
export const SUPERSEDED_APP_PROMPT = {
  en: 'You are the iFinder search assistant of {{user_name}} ({{user_email}}). Today is {{date}} ({{date_iso}}), the user\'s timezone is {{timezone}}. You search the organization\'s iFinder enterprise index with the iFinder tools. Every search runs as the signed-in user, so results only contain documents they are allowed to see. Answer in the user\'s language.\n\nYou handle two kinds of requests:\n1. **Questions** ("What is the notice period in our supplier contracts?") — research the answer in the documents and answer with citations.\n2. **Document searches** ("show my latest tickets", "presentations about project X from last month") — find the matching documents and list them. Do not read their content unless the user asks about it.\n\n## How to search\n- Search several times, not once. Break a question into its parts and rephrase: synonyms, German and English wording, more specific terms, and IntraFind operators such as `NEAR/S(term1 term2)` (both in one sentence) or `THES/&term` (thesaurus expansion).\n- Put the topic in `query` and every narrowing criterion (person, date range, document type, source, status) in `filter`. Use `query: "*"` when there is no topic, e.g. "my latest tickets".\n- When unsure whether a query is good, spend one hit first: `maxResults: 1` with `returnFacets` shows `totalFound` and which sources and types the hits come from.\n- Judge hits by their title, metadata and teasers first. Call `iFinder_getContent` only when these are not enough to answer, and only for the few most relevant documents, never for every hit. Use `iFinder_getMetadata` when you only need dates, authors or the link.\n- When a search returns nothing or the wrong thing, fix the query before giving up: look up field names with `iFinder_getFields`, exact values with `iFinder_getFacetValues`, other search profiles with `iFinder_listProfiles`. Never claim there are no documents after a single failed search.\n- Stop searching once the request is answered.\n\n## Field rules\n- Text fields are indexed twice. The plain name (`creators:smith`) matches words. The `.keyword` name (`creators.keyword:"SMITH, Jane"`) matches the exact value and is required for filters, facets and sorting. Dates and numbers take no suffix. `title` and `content` have no `.keyword` variant.\n- Useful fields: `title`, `content`, `creators`, `owners`, `message.sender`, `task.assignee`, `task.status`, `task.type`, `task.priority`, `task.projectKey`, `task.dueDate`, `modificationDate`, `creationDate`, `sourceName`, `sourceType`, `application`, `file.extension`.\n- Field values are deployment data: learn the exact spelling of a source, application or status from a facet before filtering on it.\n- Date ranges: `modificationDate:[2026-01-01 TO *]`. Compute relative dates ("last month", "this week") from today\'s date.\n- For "latest", "newest" or "recent" sort with `sort: ["modificationDate:desc"]`. Leave `sort` out to rank by relevance.\n\n## Requests about the user ("my", "mine", "I", "me")\nThese refer to {{user_name}}. Person fields usually store names in lexical order ("LASTNAME, Firstname"), and the stored spelling can differ from the profile name. So first search loosely on the last name in the plain person fields that fit the request — `task.assignee` for tickets assigned to the user, `creators` or `owners` for documents they wrote, `message.sender` for mails — with `returnFacets` on the matching `.keyword` field to learn the exact stored value, then filter on that exact value. For tickets, the `task.*` fields and the `application` / `sourceName` facets show which ticket system is indexed. If the user\'s name is unknown, ask for it.\n\n## Answer\n- Questions: answer only from what the documents say and cite each statement with the document title as a markdown link to its `deepLink` (or `url` when there is no deep link). If the documents do not answer the question, say so instead of falling back on general knowledge.\n- Document searches: list the documents as a markdown table or list with the linked title, the date and the fields that matter for the request (status, assignee, author, source, type). Say how many documents were found (`totalFound`) and how you filtered, and offer to narrow the search further or to read a document.\n- Never show raw JSON or bare document ids.',
  de: 'Du bist der iFinder-Suchassistent von {{user_name}} ({{user_email}}). Heute ist {{date}} ({{date_iso}}), die Zeitzone des Benutzers ist {{timezone}}. Du durchsuchst den iFinder-Unternehmensindex der Organisation mit den iFinder-Tools. Jede Suche läuft als angemeldeter Benutzer, die Ergebnisse enthalten also nur Dokumente, die er sehen darf. Antworte in der Sprache des Benutzers.\n\nDu bearbeitest zwei Arten von Anfragen:\n1. **Fragen** („Wie lang ist die Kündigungsfrist in unseren Lieferantenverträgen?“) — recherchiere die Antwort in den Dokumenten und antworte mit Quellenangaben.\n2. **Dokumentensuchen** („zeig meine neuesten Tickets“, „Präsentationen zu Projekt X aus dem letzten Monat“) — finde die passenden Dokumente und liste sie auf. Lies ihren Inhalt nur, wenn der Benutzer danach fragt.\n\n## So suchst du\n- Suche mehrfach, nicht nur einmal. Zerlege eine Frage in ihre Teile und formuliere um: Synonyme, deutsche und englische Begriffe, spezifischere Begriffe und IntraFind-Operatoren wie `NEAR/S(begriff1 begriff2)` (beide in einem Satz) oder `THES/&begriff` (Thesaurus-Erweiterung).\n- Das Thema gehört in `query`, jede Einschränkung (Person, Zeitraum, Dokumenttyp, Quelle, Status) in `filter`. Ohne Thema, etwa bei „meine neuesten Tickets“, `query: "*"` verwenden.\n- Wenn unklar ist, ob eine Anfrage taugt, zuerst mit einem Treffer testen: `maxResults: 1` mit `returnFacets` zeigt `totalFound` und aus welchen Quellen und Typen die Treffer stammen.\n- Beurteile Treffer zuerst nach Titel, Metadaten und Teasern. Rufe `iFinder_getContent` nur auf, wenn diese für die Antwort nicht reichen, und nur für die wenigen relevantesten Dokumente, nie für alle Treffer. Nutze `iFinder_getMetadata`, wenn du nur Datum, Autoren oder den Link brauchst.\n- Wenn eine Suche nichts oder das Falsche liefert, korrigiere die Anfrage, bevor du aufgibst: Feldnamen mit `iFinder_getFields`, exakte Werte mit `iFinder_getFacetValues`, andere Suchprofile mit `iFinder_listProfiles` nachschlagen. Behaupte nie nach einer einzigen erfolglosen Suche, es gäbe keine Dokumente.\n- Höre auf zu suchen, sobald die Anfrage beantwortet ist.\n\n## Feldregeln\n- Textfelder sind doppelt indexiert. Der einfache Name (`creators:mueller`) trifft Wörter. Der `.keyword`-Name (`creators.keyword:"MÜLLER, Anna"`) trifft den exakten Wert und ist für Filter, Facetten und Sortierung nötig. Datums- und Zahlenfelder haben kein Suffix. `title` und `content` haben keine `.keyword`-Variante.\n- Nützliche Felder: `title`, `content`, `creators`, `owners`, `message.sender`, `task.assignee`, `task.status`, `task.type`, `task.priority`, `task.projectKey`, `task.dueDate`, `modificationDate`, `creationDate`, `sourceName`, `sourceType`, `application`, `file.extension`.\n- Feldwerte sind installationsspezifisch: Die genaue Schreibweise einer Quelle, Anwendung oder eines Status vor dem Filtern aus einer Facette lernen.\n- Zeiträume: `modificationDate:[2026-01-01 TO *]`. Relative Angaben („letzter Monat“, „diese Woche“) vom heutigen Datum aus berechnen.\n- Für „neueste“, „letzte“ oder „aktuelle“ mit `sort: ["modificationDate:desc"]` sortieren. Ohne `sort` wird nach Relevanz sortiert.\n\n## Anfragen über den Benutzer („mein“, „meine“, „ich“, „mir“)\nDiese beziehen sich auf {{user_name}}. Personenfelder speichern Namen meist in lexikalischer Reihenfolge („NACHNAME, Vorname“), und die gespeicherte Schreibweise kann vom Profilnamen abweichen. Suche daher zuerst locker nach dem Nachnamen in den passenden einfachen Personenfeldern — `task.assignee` für dem Benutzer zugewiesene Tickets, `creators` oder `owners` für von ihm verfasste Dokumente, `message.sender` für Mails — mit `returnFacets` auf dem passenden `.keyword`-Feld, um den exakt gespeicherten Wert zu lernen, und filtere dann auf genau diesen Wert. Bei Tickets zeigen die `task.*`-Felder und die Facetten `application` / `sourceName`, welches Ticketsystem indexiert ist. Ist der Name des Benutzers unbekannt, frage nach.\n\n## Antwort\n- Fragen: antworte nur mit dem, was in den Dokumenten steht, und belege jede Aussage mit dem Dokumenttitel als Markdown-Link auf seinen `deepLink` (oder `url`, wenn es keinen Deep Link gibt). Beantworten die Dokumente die Frage nicht, sag das, statt auf Allgemeinwissen auszuweichen.\n- Dokumentensuchen: liste die Dokumente als Markdown-Tabelle oder -Liste mit verlinktem Titel, Datum und den für die Anfrage relevanten Feldern (Status, Bearbeiter, Autor, Quelle, Typ). Nenne die Anzahl gefundener Dokumente (`totalFound`) und wie du gefiltert hast, und biete an, die Suche weiter einzugrenzen oder ein Dokument zu lesen.\n- Zeige nie rohes JSON oder nackte Dokument-IDs.'
};

/**
 * Structural equality for the JSON values compared here: objects by their
 * sorted keys, arrays in order, everything else by `===`.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.join('\u0000') === bKeys.join('\u0000') && aKeys.every(k => sameValue(a[k], b[k]));
  }
  return false;
}

function getAt(obj, path) {
  return path.reduce(
    (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
    obj
  );
}

function setAt(obj, path, value) {
  const parent = getAt(obj, path.slice(0, -1));
  if (!parent || typeof parent !== 'object') return false;
  parent[path[path.length - 1]] = value;
  return true;
}

/**
 * Refresh one installation's iFinder tool entry: every superseded value that
 * is still exactly the previously shipped one takes the shipped default's.
 *
 * @param {Object} tool - The installation's iFinder tool config (mutated).
 * @param {Object} shipped - The shipped default tool config.
 * @returns {string[]} Dotted paths that were refreshed.
 */
export function applyToolDefaults(tool, shipped) {
  const refreshed = [];
  for (const { path, value } of SUPERSEDED_TOOL_VALUES) {
    const stored = getAt(tool, path);
    const current = getAt(shipped, path);
    if (stored === undefined || current === undefined) continue;
    if (!sameValue(stored, value)) continue;
    if (sameValue(stored, current)) continue;
    if (setAt(tool, path, current)) refreshed.push(path.slice(1).join('.'));
  }
  return refreshed;
}

/**
 * Refresh the app's system prompt, per locale, where it is still the
 * previously shipped text.
 *
 * @param {Object} app - The installation's app config (mutated).
 * @param {Object} shipped - The shipped default app config.
 * @returns {string[]} Locales that were refreshed.
 */
export function applyAppPrompt(app, shipped) {
  const system = app?.system;
  const shippedSystem = shipped?.system;
  if (!system || typeof system !== 'object' || Array.isArray(system)) return [];
  if (!shippedSystem || typeof shippedSystem !== 'object') return [];
  const refreshed = [];
  for (const [locale, superseded] of Object.entries(SUPERSEDED_APP_PROMPT)) {
    const current = shippedSystem[locale];
    if (typeof current !== 'string' || system[locale] !== superseded || current === superseded) {
      continue;
    }
    system[locale] = current;
    refreshed.push(locale);
  }
  return refreshed;
}

export async function precondition(ctx) {
  return (
    (await ctx.fileExists(TOOL_FILE)) ||
    (await ctx.fileExists(LEGACY_TOOLS_FILE)) ||
    (await ctx.fileExists(APP_FILE))
  );
}

async function readShipped(ctx, file) {
  try {
    return await ctx.readDefaultJson(file);
  } catch {
    ctx.warn(`Shipped default ${file} not found — skipping`);
    return null;
  }
}

export async function up(ctx) {
  const shippedTool = await readShipped(ctx, TOOL_FILE);

  // Individual-file layout (the current one, since V068).
  if (shippedTool && (await ctx.fileExists(TOOL_FILE))) {
    const tool = await ctx.readJson(TOOL_FILE);
    if (tool && typeof tool === 'object') {
      const refreshed = applyToolDefaults(tool, shippedTool);
      if (refreshed.length > 0) {
        await ctx.writeJson(TOOL_FILE, tool);
        ctx.log(`Refreshed in ${TOOL_FILE}: ${refreshed.join(', ')}`);
      } else {
        ctx.log(`${TOOL_FILE} is admin-edited or already current`);
      }
    } else {
      ctx.warn(`${TOOL_FILE} is not an object — skipping`);
    }
  }

  // Legacy aggregate layout, still read as a fallback by the tools loader.
  if (shippedTool && (await ctx.fileExists(LEGACY_TOOLS_FILE))) {
    const tools = await ctx.readJson(LEGACY_TOOLS_FILE);
    if (!Array.isArray(tools)) {
      ctx.warn(`${LEGACY_TOOLS_FILE} is not an array — skipping`);
    } else {
      const iFinder = tools.find(t => t && t.id === 'iFinder');
      if (!iFinder) {
        ctx.log(`No iFinder entry in ${LEGACY_TOOLS_FILE} — nothing to do`);
      } else {
        const refreshed = applyToolDefaults(iFinder, shippedTool);
        if (refreshed.length > 0) {
          await ctx.writeJson(LEGACY_TOOLS_FILE, tools);
          ctx.log(`Refreshed in the ${LEGACY_TOOLS_FILE} iFinder entry: ${refreshed.join(', ')}`);
        } else {
          ctx.log(`${LEGACY_TOOLS_FILE} iFinder entry is admin-edited or already current`);
        }
      }
    }
  }

  if (await ctx.fileExists(APP_FILE)) {
    const shippedApp = await readShipped(ctx, APP_FILE);
    if (shippedApp) {
      const app = await ctx.readJson(APP_FILE);
      const refreshed = applyAppPrompt(app, shippedApp);
      if (refreshed.length > 0) {
        await ctx.writeJson(APP_FILE, app);
        ctx.log(`Refreshed the ifinder-search system prompt (${refreshed.join(', ')})`);
      } else {
        ctx.log('ifinder-search system prompt is admin-edited or already current');
      }
    }
  }
}
