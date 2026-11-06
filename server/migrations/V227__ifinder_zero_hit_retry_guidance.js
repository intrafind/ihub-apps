// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V227 — iFinder search app: retry after zero hits with fewer words
 *
 * The shipped `ifinder-search` prompt told the model to rephrase a search with
 * "more specific terms". After a search with no hits that is the one retry
 * certain to fail: up to three bare words must all match — in AND search
 * profiles and in the shipped OR profiles (`minimum_should_match: 3<-25%`)
 * alike — so "vacation policy" finding nothing means "vacation policy company"
 * finds nothing either. The new default drops "more specific terms" and adds a
 * bullet: after zero hits, or to find other documents, use fewer or different
 * words and an explicit OR; write AND or OR out when it matters, since how bare
 * words combine is a profile setting.
 *
 * `performInitialSetup` only copies files that are *missing* from contents/,
 * so existing installations keep the old wording until this migration runs.
 * The prompt is replaced ONLY when swapping the old bullet for the new one
 * gives exactly the text this release ships — an admin who changed anything
 * else in the prompt keeps their text.
 *
 * The `ifinder-search` skill (a managed default) and the iFinder search
 * action's model guidance (read from the shipped integration definition) carry
 * the same rule and reach every installation without a migration.
 */

export const version = '227';
export const description = 'ifinder_zero_hit_retry_guidance';

const APP_FILE = 'apps/ifinder-search.json';

/** The bullet each superseded prompt used → the bullets the new default uses. */
export const FRAGMENTS = Object.freeze({
  en: {
    from: '- Search several times, not once. Break a question into its parts and rephrase: synonyms, German and English wording, more specific terms, and IntraFind operators such as `NEAR/S(term1 term2)` (both in one sentence) or `THES/&term` (thesaurus expansion).',
    to:
      '- Search several times, not once. Break a question into its parts and rephrase: synonyms, German and English wording, and IntraFind operators such as `NEAR/S(term1 term2)` (both in one sentence) or `THES/&term` (thesaurus expansion).\n' +
      '- After 0 hits, or to find other documents, search with fewer or different words — synonyms, the other language, alternatives joined with an explicit OR — never with the same words plus more: up to three words must all match in every shipped search profile, so a query that found nothing finds nothing once it gets longer. Whether bare words combine with AND or OR is a setting of the search profile, so write `AND` or `OR` out when it matters; to narrow a result that is too large, use a filter, a phrase, `NEAR/S(…)` or an explicit `AND`.'
  },
  de: {
    from: '- Suche mehrfach, nicht nur einmal. Zerlege eine Frage in ihre Teile und formuliere um: Synonyme, deutsche und englische Begriffe, spezifischere Begriffe und IntraFind-Operatoren wie `NEAR/S(begriff1 begriff2)` (beide in einem Satz) oder `THES/&begriff` (Thesaurus-Erweiterung).',
    to:
      '- Suche mehrfach, nicht nur einmal. Zerlege eine Frage in ihre Teile und formuliere um: Synonyme, deutsche und englische Begriffe und IntraFind-Operatoren wie `NEAR/S(begriff1 begriff2)` (beide in einem Satz) oder `THES/&begriff` (Thesaurus-Erweiterung).\n' +
      '- Nach 0 Treffern oder um andere Dokumente zu finden, mit weniger oder anderen Wörtern suchen — Synonyme, die andere Sprache, Alternativen mit explizitem OR verknüpft — nie mit denselben Wörtern plus weiteren: Bis zu drei Wörter müssen in jedem ausgelieferten Suchprofil alle treffen, eine Suche ohne Treffer findet verlängert also nichts. Ob einfache Wörter mit UND oder ODER verknüpft werden, ist eine Einstellung des Suchprofils, daher `AND` oder `OR` ausschreiben, wenn es darauf ankommt; ein zu großes Ergebnis mit einem Filter, einer Phrase, `NEAR/S(…)` oder explizitem `AND` eingrenzen.'
  }
});

/**
 * The new default for `stored`, or `null` when it must be left alone.
 *
 * @param {*} stored - The installation's prompt in one language.
 * @param {*} shipped - The prompt this release ships in that language.
 * @param {{from: string, to: string}} fragment - The bullet swap for that language.
 * @returns {string|null}
 */
export function refreshedText(stored, shipped, fragment) {
  if (typeof stored !== 'string' || typeof shipped !== 'string' || !fragment) return null;
  if (stored === shipped) return null;
  const swapped = stored.split(fragment.from).join(fragment.to);
  return swapped !== stored && swapped === shipped ? shipped : null;
}

export async function precondition(ctx) {
  return ctx.fileExists(APP_FILE);
}

export async function up(ctx) {
  let shipped;
  try {
    shipped = await ctx.readDefaultJson(APP_FILE);
  } catch {
    ctx.warn(`No shipped default for ${APP_FILE} — left as is`);
    return;
  }
  const app = await ctx.readJson(APP_FILE);
  if (!app?.system || typeof app.system !== 'object') return;

  const updated = [];
  for (const [lang, fragment] of Object.entries(FRAGMENTS)) {
    const next = refreshedText(app.system[lang], shipped?.system?.[lang], fragment);
    if (next !== null) {
      app.system[lang] = next;
      updated.push(lang);
    } else if (typeof app.system[lang] === 'string' && app.system[lang].includes(fragment.from)) {
      ctx.warn(
        `${APP_FILE} system.${lang} was customized and still asks for "more specific terms" — left as is. ` +
          'After a search with no hits, adding words cannot find anything.'
      );
    }
  }
  if (updated.length > 0) {
    await ctx.writeJson(APP_FILE, app);
    ctx.log(`${APP_FILE}: retry guidance for searches with no hits (${updated.join(', ')})`);
  }
}
