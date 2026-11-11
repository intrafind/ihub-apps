// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sizing result of a website corpus as a dashboard spec.
 *
 * The spec is what the `dashboard` system skill passes to `create_web_artifact`
 * (`preset: "dashboard"`, see `services/documents/webArtifacts/dashboardPreset.js`).
 * It is built here, from the same analysis as the Markdown report, so that the
 * model that presents the result hands it on unchanged instead of copying fifty
 * figures out of Markdown tables. Every number comes from
 * {@link module:services/websiteCorpus/stats}; this module only lays them out.
 *
 * @module services/websiteCorpus/dashboard
 */
import { THIN_CHARS, WINDOWS, percent, windowFit } from './stats.js';

/** Bars drawn before the rest is folded into one. */
const BAR_SECTIONS = 9;
/** Most sections listed; the dashboard allows 500 entries per block. */
const MAX_SECTIONS = 400;
const LARGEST_PAGES = 20;

/** How tokens were counted, by method and language; the report's own wording is English. */
const TOKENIZER_NOTES = {
  en: {
    o200k_base:
      'counted with the o200k_base tokenizer, exact for OpenAI models and typically within 10 to 20 percent for other model families; German text can need more',
    heuristic:
      'counted as one token per 4 characters, because this server has no tokenizer library installed; this is a rough approximation that can be off in either direction, so treat the figures as approximate'
  },
  de: {
    o200k_base:
      'gezählt mit dem Tokenizer o200k_base, exakt für OpenAI-Modelle und bei anderen Modellfamilien meist auf 10 bis 20 Prozent genau; deutscher Text kann mehr brauchen',
    heuristic:
      'gezählt als ein Token je 4 Zeichen, weil auf diesem Server keine Tokenizer-Bibliothek installiert ist; das ist eine grobe Näherung, die in beide Richtungen abweichen kann, die Zahlen sind daher ungefähr'
  }
};

const TEXTS = {
  en: {
    title: name => `${name} Website Corpus`,
    summary: ({ pages, tokens, dedup, fit }) =>
      `**${pages}** pages with **${tokens}** tokens (**${dedup}** after removing repeated lines). ${fit}`,
    fitsIn: label => `After dedup it fits in a single ${label} window.`,
    fitsNot: windows =>
      `After dedup it needs ${windows} windows of 1M tokens: it does not fit in one.`,
    crawled: ({ date, siteUrl, prefix }) =>
      `Crawled on ${date} from ${siteUrl}${prefix ? `, only paths under ${prefix}` : ''}.`,
    incomplete: n => `The corpus is incomplete: ${n} pages have not been crawled yet.`,
    tokensNote: note => `Tokens are estimates (${note}).`,
    pages: 'Pages',
    thinNote: n => `${n} with under ${THIN_CHARS} characters`,
    tokens: 'Tokens',
    tokensDedup: 'Tokens after dedup',
    chars: 'Characters',
    bySection: 'Tokens by section',
    bySectionText:
      'Tokens per section, largest first. A section is the first URL path segment; a section with one page is grouped as top-level pages.',
    sectionPages: (pages, dedup) => `${pages} pages · ${dedup} after dedup`,
    smaller: '{n} smaller sections',
    section: 'Section',
    fitTitle: 'Does it fit in one context window?',
    fitTable: 'Fit per window',
    fitText: sizes =>
      `Tokens of the corpus against common context sizes: ${sizes}. A bar that crosses a line is too large for that window, before counting the prompt and the answer.`,
    full: 'Full corpus',
    afterDedup: 'After dedup',
    core: names => `Core pages (no ${names})`,
    coreDedup: 'Core pages after dedup',
    corpus: 'Corpus',
    fits: 'fits',
    windowsNeeded: n => `${n} windows`,
    allSections: 'All sections',
    allSectionsText: 'Every section with its page count and size.',
    cPages: 'Pages',
    cThin: 'Thin pages',
    cChars: 'Characters',
    cTokens: 'Tokens',
    cDedup: 'After dedup',
    cSaving: 'Dedup saving',
    largest: 'Largest pages',
    largestText: n => `The ${n} pages with the most tokens. Path is relative to the site.`,
    page: 'Page',
    duplicates: 'Duplicates',
    exact: (groups, extra) =>
      `Exact duplicate page groups: **${groups}**; the extra copies cost **${extra}** tokens.`,
    near: (total, truncated) =>
      `Near-duplicate page pairs (word 5-gram overlap of 0.80 or more): **${truncated ? 'at least ' : ''}${total}**. Removing repeated lines does not remove these.`,
    method: 'How these numbers were made',
    mCrawl: ({ siteUrl, prefix, date }) =>
      `Pages: the URLs of the sitemap(s) of ${siteUrl}${prefix ? `, only paths under ${prefix}` : ''}, crawled on ${date}. Pages missing from the sitemap are missing from the corpus.`,
    mExtract:
      'Text: the main content of each page, without scripts, forms, navigation and the selectors named for the crawl; headings and list items are kept.',
    mTokens: ({ note, ratio }) =>
      `Tokens: ${note}. The corpus averages ${ratio} characters per token.`,
    mDedup:
      'Dedup: a line of 40 or more characters is counted only on the first page where it appears, in sitemap order. Corpus totals do not depend on the order; per-section numbers do.',
    mCore: names => `Core pages: all sections except ${names}.`,
    sSections: 'Tokens per section',
    sSectionsText: 'Sum of the tokens of the pages in each section, as counted by the crawl.',
    sSectionsFormula:
      'tokens(section) = SUM(tokens of its pages)\nshare(section) = tokens(section) / SUM(tokens of all sections) * 100',
    sWindows: 'Context windows',
    sWindowsText: 'The corpus compared with the size of a context window.',
    sWindowsFormula:
      `window sizes: ${WINDOWS.map(w => `${w.label} = ${w.size.toLocaleString('en-US')}`).join(', ')} tokens\n` +
      'ratio = tokens / window size\nfits: ratio <= 1; otherwise windows needed = ROUNDUP(ratio)',
    sDedup: 'Dedup',
    sDedupText: 'Tokens after repeated lines are removed.',
    sDedupFormula:
      'a line of 40+ characters counts on the first page (sitemap order) where it appears only',
    sPages: 'Pages and token counts',
    sPagesText: 'One row per crawled URL: its main text size in characters and tokens.'
  },
  de: {
    title: name => `${name} Website-Korpus`,
    summary: ({ pages, tokens, dedup, fit }) =>
      `**${pages}** Seiten mit **${tokens}** Tokens (**${dedup}** nach Entfernen wiederholter Zeilen). ${fit}`,
    fitsIn: label => `Nach der Bereinigung passt er in ein einzelnes ${label}-Fenster.`,
    fitsNot: windows =>
      `Nach der Bereinigung braucht er ${windows} Fenster zu 1M Tokens: er passt nicht in eines.`,
    crawled: ({ date, siteUrl, prefix }) =>
      `Gecrawlt am ${date} von ${siteUrl}${prefix ? `, nur Pfade unter ${prefix}` : ''}.`,
    incomplete: n => `Der Korpus ist unvollständig: ${n} Seiten wurden noch nicht gecrawlt.`,
    tokensNote: note => `Die Tokens sind Schätzungen (${note}).`,
    pages: 'Seiten',
    thinNote: n => `${n} mit unter ${THIN_CHARS} Zeichen`,
    tokens: 'Tokens',
    tokensDedup: 'Tokens nach Bereinigung',
    chars: 'Zeichen',
    bySection: 'Tokens je Bereich',
    bySectionText:
      'Tokens je Bereich, größte zuerst. Ein Bereich ist das erste Segment des URL-Pfads; ein Bereich mit einer Seite wird zu "top-level pages" zusammengefasst.',
    sectionPages: (pages, dedup) => `${pages} Seiten · ${dedup} nach Bereinigung`,
    smaller: '{n} kleinere Bereiche',
    section: 'Bereich',
    fitTitle: 'Passt er in ein Kontextfenster?',
    fitTable: 'Passt je Fenster',
    fitText: sizes =>
      `Tokens des Korpus im Vergleich zu gängigen Kontextgrößen: ${sizes}. Ein Balken, der eine Linie überschreitet, ist für dieses Fenster zu groß, noch ohne Prompt und Antwort.`,
    full: 'Gesamter Korpus',
    afterDedup: 'Nach Bereinigung',
    core: names => `Kernseiten (ohne ${names})`,
    coreDedup: 'Kernseiten nach Bereinigung',
    corpus: 'Korpus',
    fits: 'passt',
    windowsNeeded: n => `${n} Fenster`,
    allSections: 'Alle Bereiche',
    allSectionsText: 'Jeder Bereich mit Seitenzahl und Größe.',
    cPages: 'Seiten',
    cThin: 'Dünne Seiten',
    cChars: 'Zeichen',
    cTokens: 'Tokens',
    cDedup: 'Nach Bereinigung',
    cSaving: 'Ersparnis',
    largest: 'Größte Seiten',
    largestText: n => `Die ${n} Seiten mit den meisten Tokens. Der Pfad ist relativ zur Website.`,
    page: 'Seite',
    duplicates: 'Duplikate',
    exact: (groups, extra) =>
      `Gruppen exakt gleicher Seiten: **${groups}**; die zusätzlichen Kopien kosten **${extra}** Tokens.`,
    near: (total, truncated) =>
      `Paare fast gleicher Seiten (Überlappung von 5-Wort-Folgen ab 0,80): **${truncated ? 'mindestens ' : ''}${total}**. Das Entfernen wiederholter Zeilen entfernt diese nicht.`,
    method: 'So sind die Zahlen entstanden',
    mCrawl: ({ siteUrl, prefix, date }) =>
      `Seiten: die URLs der Sitemap(s) von ${siteUrl}${prefix ? `, nur Pfade unter ${prefix}` : ''}, gecrawlt am ${date}. Seiten, die in der Sitemap fehlen, fehlen im Korpus.`,
    mExtract:
      'Text: der Hauptinhalt jeder Seite, ohne Skripte, Formulare, Navigation und die für den Crawl genannten Selektoren; Überschriften und Listenpunkte bleiben erhalten.',
    mTokens: ({ note, ratio }) =>
      `Tokens: ${note}. Der Korpus hat im Schnitt ${ratio} Zeichen je Token.`,
    mDedup:
      'Bereinigung: eine Zeile mit 40 oder mehr Zeichen zählt nur auf der ersten Seite, auf der sie vorkommt, in Sitemap-Reihenfolge. Die Summen des Korpus hängen nicht von der Reihenfolge ab, die Zahlen je Bereich schon.',
    mCore: names => `Kernseiten: alle Bereiche außer ${names}.`,
    sSections: 'Tokens je Bereich',
    sSectionsText: 'Summe der Tokens der Seiten jedes Bereichs, wie der Crawl sie gezählt hat.',
    sSectionsFormula:
      'Tokens(Bereich) = SUMME(Tokens seiner Seiten)\nAnteil(Bereich) = Tokens(Bereich) / SUMME(Tokens aller Bereiche) * 100',
    sWindows: 'Kontextfenster',
    sWindowsText: 'Der Korpus im Vergleich zur Größe eines Kontextfensters.',
    sWindowsFormula:
      `Fenstergrößen: ${WINDOWS.map(w => `${w.label} = ${w.size.toLocaleString('de-DE')}`).join(', ')} Tokens\n` +
      'Verhältnis = Tokens / Fenstergröße\npasst: Verhältnis <= 1; sonst Fenster = AUFRUNDEN(Verhältnis)',
    sDedup: 'Bereinigung',
    sDedupText: 'Tokens, nachdem wiederholte Zeilen entfernt wurden.',
    sDedupFormula:
      'eine Zeile ab 40 Zeichen zählt nur auf der ersten Seite (Sitemap-Reihenfolge), auf der sie vorkommt',
    sPages: 'Seiten und Token-Zahlen',
    sPagesText: 'Eine Zeile je gecrawlter URL: Größe ihres Haupttexts in Zeichen und Tokens.'
  }
};

/** The path of a page, as the dashboard shows it. */
function pathOf(url) {
  let path = '/';
  try {
    path = decodeURIComponent(new URL(url).pathname) || '/';
  } catch {
    // Keep the slash.
  }
  return path.length <= 120 ? path : `${path.slice(0, 117)}...`;
}

/**
 * @param {Object} input
 * @param {string} input.name - The site's name, for the title
 * @param {Object} input.analysis - Result of `analyseCorpus`
 * @param {{total: number, truncated?: boolean}} input.nearDuplicates
 * @param {Object} input.meta - `crawlDate`, `siteUrl`, `prefix`, `dropSelector`, `coverage`
 * @param {{method: string, note: string}} input.tokenizer - How tokens were counted
 * @param {'en'|'de'} [input.language]
 * @returns {Object} A spec for `create_web_artifact` with `preset: "dashboard"`
 */
export function buildDashboard({ name, analysis, nearDuplicates, meta, tokenizer, language }) {
  const lang = language === 'de' ? 'de' : 'en';
  const t = TEXTS[lang];
  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  const n = value => Number(value).toLocaleString(locale);
  const { rows, sections, totals, core, newsFound, exactDuplicates } = analysis;
  const tokenizerNote = TOKENIZER_NOTES[lang][tokenizer.method] || tokenizer.note;
  const ratioText = value =>
    value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const dedupFit = windowFit(totals.tokensDedup);
  const smallest = dedupFit.find(entry => entry.fits);
  const coverage = meta.coverage;
  const charsPerToken =
    totals.chars && totals.tokens ? ratioText(totals.chars / totals.tokens) : '-';

  // Sections: the largest ones, the tail of an unusually large site folded into one entry.
  const listed = sections.slice(0, MAX_SECTIONS);
  const tail = sections.slice(MAX_SECTIONS);
  const sectionItems = listed.map(entry => ({
    label: entry.section,
    value: entry.tokens,
    note: t.sectionPages(n(entry.pages), n(entry.tokensDedup))
  }));
  if (tail.length) {
    sectionItems.push({
      label: t.smaller.replace('{n}', n(tail.length)),
      value: tail.reduce((total, entry) => total + entry.tokens, 0)
    });
  }
  const sectionRows = listed.map(entry => ({
    section: entry.section,
    pages: entry.pages,
    thin: entry.thin,
    chars: entry.chars,
    tokens: entry.tokens,
    dedup: entry.tokensDedup,
    saving: percent(entry.tokens - entry.tokensDedup, entry.tokens)
  }));

  const fitRows = [
    [t.full, totals.tokens],
    [t.afterDedup, totals.tokensDedup]
  ];
  if (newsFound.length) {
    fitRows.push([t.core(newsFound.join(', ')), core.tokens], [t.coreDedup, core.tokensDedup]);
  }
  const windowCell = ({ ratio: r, windows, fits }) => {
    const shown = r < 0.005 ? `<${ratioText(0.01)}` : ratioText(r);
    return fits
      ? { text: `${shown} (${t.fits})`, status: 'good' }
      : { text: `${shown} (${t.windowsNeeded(windows)})`, status: 'critical' };
  };

  const largest = [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, LARGEST_PAGES);

  const blocks = [
    {
      type: 'bars',
      title: t.bySection,
      description: t.bySectionText,
      source: 'sections',
      share: true,
      top: BAR_SECTIONS,
      otherLabel: t.smaller,
      labelHeader: t.section,
      valueHeader: t.tokens,
      items: sectionItems
    },
    {
      type: 'bars',
      title: t.fitTitle,
      description: t.fitText(WINDOWS.map(w => `${w.label} = ${n(w.size)}`).join(', ')),
      source: 'windows',
      sort: 'none',
      marks: WINDOWS.map(w => ({ label: w.label, value: w.size })),
      valueHeader: t.tokens,
      labelHeader: t.corpus,
      items: fitRows.map(([label, tokens]) => ({ label, value: tokens }))
    },
    {
      type: 'table',
      title: t.fitTable,
      source: 'windows',
      visibleRows: 0,
      columns: [
        { key: 'corpus', label: t.corpus },
        { key: 'tokens', label: t.tokens, format: 'int' },
        ...WINDOWS.map(w => ({ key: w.label, label: w.label, format: 'status' }))
      ],
      rows: fitRows.map(([label, tokens]) => ({
        corpus: label,
        tokens,
        ...Object.fromEntries(windowFit(tokens).map(cell => [cell.label, windowCell(cell)]))
      }))
    },
    {
      type: 'table',
      title: t.allSections,
      description: t.allSectionsText,
      source: 'sections',
      visibleRows: 10,
      sort: { key: 'tokens', dir: 'desc' },
      columns: [
        { key: 'section', label: t.section },
        { key: 'pages', label: t.cPages, format: 'int' },
        { key: 'thin', label: t.cThin, format: 'int' },
        { key: 'chars', label: t.cChars, format: 'int' },
        { key: 'tokens', label: t.cTokens, format: 'int' },
        { key: 'dedup', label: t.cDedup, format: 'int' },
        { key: 'saving', label: t.cSaving, format: 'percent' }
      ],
      rows: sectionRows
    },
    {
      type: 'table',
      title: t.largest,
      description: t.largestText(largest.length),
      source: 'pages',
      visibleRows: 10,
      columns: [
        { key: 'path', label: t.page },
        { key: 'section', label: t.section },
        { key: 'chars', label: t.cChars, format: 'int' },
        { key: 'tokens', label: t.cTokens, format: 'int' }
      ],
      rows: largest.map(row => ({
        path: pathOf(row.url),
        section: row.section,
        chars: row.chars,
        tokens: row.tokens
      }))
    }
  ];

  const duplicateParagraphs = [];
  if (exactDuplicates.length) {
    duplicateParagraphs.push(
      t.exact(
        n(exactDuplicates.length),
        n(exactDuplicates.reduce((total, group) => total + group.extraTokens, 0))
      )
    );
  }
  if (nearDuplicates.total || nearDuplicates.truncated) {
    duplicateParagraphs.push(t.near(n(nearDuplicates.total), nearDuplicates.truncated));
  }
  if (duplicateParagraphs.length) {
    blocks.push({ type: 'text', title: t.duplicates, paragraphs: duplicateParagraphs });
  }

  const notes = [
    t.crawled({ date: meta.crawlDate, siteUrl: meta.siteUrl, prefix: meta.prefix }),
    t.tokensNote(tokenizerNote)
  ];
  if (coverage.notCrawled > 0) notes.push(t.incomplete(n(coverage.notCrawled)));

  const method = [
    t.mCrawl({ siteUrl: meta.siteUrl, prefix: meta.prefix, date: meta.crawlDate }),
    t.mExtract,
    t.mTokens({ note: tokenizerNote, ratio: charsPerToken }),
    t.mDedup
  ];
  if (newsFound.length) method.push(t.mCore(newsFound.join(', ')));

  return {
    lang,
    title: t.title(name),
    summary: t.summary({
      pages: n(totals.pages),
      tokens: n(totals.tokens),
      dedup: n(totals.tokensDedup),
      fit: smallest ? t.fitsIn(smallest.label) : t.fitsNot(dedupFit.at(-1).windows)
    }),
    notes,
    asOf: meta.crawlDate,
    kpis: [
      { label: t.pages, value: totals.pages, note: t.thinNote(n(totals.thin)) },
      { label: t.tokens, value: totals.tokens },
      { label: t.tokensDedup, value: totals.tokensDedup },
      { label: t.chars, value: totals.chars }
    ],
    blocks,
    method: { title: t.method, paragraphs: method },
    sources: [
      {
        id: 'sections',
        name: t.sSections,
        description: t.sSectionsText,
        formula: t.sSectionsFormula
      },
      { id: 'windows', name: t.sWindows, description: t.sWindowsText, formula: t.sWindowsFormula },
      { id: 'dedup', name: t.sDedup, description: t.sDedupText, formula: t.sDedupFormula },
      { id: 'pages', name: t.sPages, description: t.sPagesText }
    ]
  };
}
