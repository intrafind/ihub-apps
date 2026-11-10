// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sizing report of a website corpus, as Markdown.
 *
 * Every number comes from {@link module:services/websiteCorpus/stats}; this
 * module only lays them out, so the model that presents the report copies it
 * instead of adding anything up. The report holds the summary, how many 128k,
 * 256k and 1M context windows the corpus fills (all pages, after dedup, and
 * "core" pages without news-like sections), tokens by section (a table and a
 * Mermaid bar chart), the largest pages, duplicates, how much of the sitemap
 * was crawled, and the method.
 *
 * @module services/websiteCorpus/report
 */
import { THIN_CHARS, WINDOWS, percent, windowFit } from './stats.js';

/** Sections drawn in the chart; the rest are one bar. */
const CHART_SECTIONS = 10;
const LARGEST_PAGES = 20;

const n = value => Number(value).toLocaleString('en-US');
// Backslashes first: otherwise a backslash in the text would swallow the one added before a pipe.
const md = text => String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
// Text that comes from the crawled site (a section name, a page path) also loses its link,
// emphasis, code and HTML syntax: a path such as /[docs](https://other.example)/x would otherwise
// put a link of the site operator's choice into a report the chat shows to the user.
const mdSite = text => String(text).replace(/[\\|[\]()*_`<>!~]/g, '\\$&');

function share(part, whole) {
  const value = percent(part, whole);
  return value === null ? '-' : `${value.toFixed(1)}%`;
}

function windowCell({ ratio, windows, fits }) {
  const shown = ratio < 0.005 ? '<0.01' : ratio.toFixed(2);
  return fits ? `${shown} (fits)` : `${shown} (${windows} windows)`;
}

/** A page link whose label is its path. */
function link(url) {
  let path = '/';
  try {
    path = new URL(url).pathname || '/';
  } catch {
    // Keep the slash.
  }
  const label = path.length <= 70 ? path : `${path.slice(0, 67)}...`;
  // The destination: nothing that ends it, opens a title or starts markup.
  const safe = url.replace(
    /[|()<>`\s]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
  return `[${mdSite(label)}](${safe})`;
}

/** The label of a Mermaid axis entry: no quotes, which would end it. */
const axisLabel = text => String(text).replace(/"/g, "'");

/**
 * @param {Object} input
 * @param {string} input.name - The site's name, for the title
 * @param {Object} input.analysis - Result of `analyseCorpus`
 * @param {{total: number, pairs: Array<{similarity: number, urls: string[]}>}} input.nearDuplicates
 * @param {Object} input.meta - Where the corpus came from: `crawlDate`, `siteUrl`,
 *   `prefix`, `dropSelector`, `coverage` (`inSitemap`, `crawled`, `failed`,
 *   `blockedByRobots`, `notHtml`, `notCrawled`)
 * @param {{method: string, note: string}} input.tokenizer - How tokens were counted
 * @returns {string} Markdown
 */
export function renderReport({ name, analysis, nearDuplicates, meta, tokenizer }) {
  const { rows, sections, totals, core, newsFound, exactDuplicates } = analysis;
  const out = [];
  const w = line => out.push(line);

  const dedupFit = windowFit(totals.tokensDedup);
  const smallest = dedupFit.find(entry => entry.fits);
  w(`# ${name} Website Corpus`);
  w('');
  w(
    `${name}: ${n(totals.pages)} pages with ${n(totals.tokens)} tokens (${n(totals.tokensDedup)} after ` +
      `removing repeated lines). ` +
      (smallest
        ? `After dedup it fits in a single ${smallest.label} window.`
        : `After dedup it needs ${dedupFit.at(-1).windows} windows of 1M tokens: it does not fit in one.`)
  );
  w('');
  w(`Tokens are estimates (${tokenizer.note}).`);
  w('');
  w('| Pages crawled | Tokens | Tokens after dedup | Characters |');
  w('|---:|---:|---:|---:|');
  w(`| ${n(totals.pages)} | ${n(totals.tokens)} | ${n(totals.tokensDedup)} | ${n(totals.chars)} |`);
  w('');

  w('## Does it fit in one context window?');
  w('');
  w(
    'Tokens divided by the window size; below 1.00 the corpus fits in one window, above it the ' +
      'number of windows needed follows in brackets. ' +
      WINDOWS.map(({ label, size }) => `${label} = ${n(size)}`).join(', ') +
      ' tokens.'
  );
  w('');
  w(`| Corpus | Tokens | ${WINDOWS.map(({ label }) => label).join(' | ')} |`);
  w(`|---|---:|${WINDOWS.map(() => '---:').join('|')}|`);
  const fitRows = [
    ['Full corpus', totals.tokens],
    ['After dedup', totals.tokensDedup]
  ];
  if (newsFound.length) {
    fitRows.push(
      [`Core pages (no ${newsFound.join(', ')})`, core.tokens],
      ['Core pages after dedup', core.tokensDedup]
    );
  }
  for (const [label, tokens] of fitRows) {
    w(`| ${md(label)} | ${n(tokens)} | ${windowFit(tokens).map(windowCell).join(' | ')} |`);
  }
  w('');
  if (!newsFound.length) {
    w('No blog or news-like section was found, so there is no separate core-pages row.');
    w('');
  }

  w('## Tokens by section');
  w('');
  const top = sections.slice(0, CHART_SECTIONS);
  const rest = sections.slice(CHART_SECTIONS);
  const labels = top.map(entry => axisLabel(entry.section));
  let fulls = top.map(entry => entry.tokens);
  let deds = top.map(entry => entry.tokensDedup);
  if (rest.length) {
    labels.push(`other (${rest.length})`);
    fulls.push(rest.reduce((total, entry) => total + entry.tokens, 0));
    deds.push(rest.reduce((total, entry) => total + entry.tokensDedup, 0));
  }
  const thousands = Math.max(...fulls, 0) >= 20_000;
  const unit = thousands ? ' (thousands)' : '';
  if (thousands) {
    fulls = fulls.map(value => Math.round(value / 1000));
    deds = deds.map(value => Math.round(value / 1000));
  }
  w(
    `Tokens${thousands ? ' in thousands' : ''}, the largest sections first; both counts share one bar ` +
      'per section: the taller bar behind is the full count, the bar in front of it the count after dedup.'
  );
  w('');
  w('```mermaid');
  w('xychart-beta');
  w(`    title "Tokens by section${unit}: full vs. after dedup"`);
  w(`    x-axis [${labels.map(label => `"${label}"`).join(', ')}]`);
  w(`    y-axis "Tokens${unit}" 0 --> ${Math.max(...fulls, 1)}`);
  w(`    bar [${fulls.join(', ')}]`);
  w(`    bar [${deds.join(', ')}]`);
  w('```');
  w('');

  w('## All sections');
  w('');
  w(`Thin pages have under ${THIN_CHARS} characters of main text.`);
  w('');
  w('| Section | Pages | Thin pages | Characters | Tokens | Tokens after dedup | Dedup saving |');
  w('|---|---:|---:|---:|---:|---:|---:|');
  for (const entry of sections) {
    w(
      `| ${mdSite(entry.section)} | ${n(entry.pages)} | ${n(entry.thin)} | ${n(entry.chars)} | ` +
        `${n(entry.tokens)} | ${n(entry.tokensDedup)} | ${share(entry.tokens - entry.tokensDedup, entry.tokens)} |`
    );
  }
  w(
    `| **Total** | **${n(totals.pages)}** | **${n(totals.thin)}** | **${n(totals.chars)}** | ` +
      `**${n(totals.tokens)}** | **${n(totals.tokensDedup)}** | ` +
      `**${share(totals.tokens - totals.tokensDedup, totals.tokens)}** |`
  );
  w('');

  w('## Largest pages');
  w('');
  w('| # | Tokens | Section | Page |');
  w('|---:|---:|---|---|');
  [...rows]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LARGEST_PAGES)
    .forEach((row, index) => {
      w(`| ${index + 1} | ${n(row.tokens)} | ${mdSite(row.section)} | ${link(row.url)} |`);
    });
  w('');

  w('## Duplicates');
  w('');
  if (!exactDuplicates.length && !nearDuplicates.total) {
    w('No exact duplicate pages and no near-duplicate pages were found.');
  } else {
    w(
      `Exact duplicate page groups: ${exactDuplicates.length}` +
        (exactDuplicates.length
          ? `; the extra copies cost ${n(exactDuplicates.reduce((t, g) => t + g.extraTokens, 0))} tokens.`
          : '.')
    );
    for (const group of exactDuplicates.slice(0, 10)) {
      w(`- ${group.urls.map(link).join(' = ')} (${n(group.extraTokens)} extra tokens)`);
    }
    w('');
    w(
      `Near-duplicate page pairs (word 5-gram overlap of 0.80 or more): ${nearDuplicates.total}. ` +
        'Line-level dedup does not remove these, because their lines differ slightly.'
    );
    for (const pair of nearDuplicates.pairs.slice(0, 10)) {
      w(`- ${pair.similarity.toFixed(2)}: ${pair.urls.map(link).join(' and ')}`);
    }
  }
  w('');

  const coverage = meta.coverage;
  w('## Coverage');
  w('');
  w('| In the sitemap | Crawled | Failed | Blocked by robots.txt | Not HTML | Not yet crawled |');
  w('|---:|---:|---:|---:|---:|---:|');
  w(
    `| ${n(coverage.inSitemap)} | ${n(coverage.crawled)} | ${n(coverage.failed)} | ` +
      `${n(coverage.blockedByRobots)} | ${n(coverage.notHtml)} | ${n(coverage.notCrawled)} |`
  );
  w('');
  if (coverage.notCrawled > 0) {
    w(`The corpus is incomplete: ${n(coverage.notCrawled)} pages have not been crawled yet.`);
    w('');
  }

  const ratio = totals.chars && totals.tokens ? (totals.chars / totals.tokens).toFixed(2) : '-';
  w('## Method');
  w('');
  w(
    `- **Crawl:** URLs from the sitemap(s) of ${meta.siteUrl}` +
      `${meta.prefix ? `, only paths under ${meta.prefix}` : ''}, crawled on ${meta.crawlDate}. ` +
      'Pages missing from the sitemap are missing from the corpus.'
  );
  w(
    '- **Extraction:** the text of `<main>` (`<body>` if there is none). Scripts, styles, forms, ' +
      'buttons, iframes, `<nav>`' +
      `${meta.dropSelector ? ` and \`${meta.dropSelector}\`` : ''} are removed; headings and list items ` +
      'are kept; consecutive identical lines are dropped.'
  );
  w(`- **Tokens:** ${tokenizer.note}. The corpus averages ${ratio} characters per token.`);
  w(
    `- **Dedup:** a line of 40 or more characters is counted only on the first page where it ` +
      'appears, in sitemap order. Corpus totals do not depend on page order; per-section dedup numbers do.'
  );
  if (newsFound.length) w(`- **Core pages:** all sections except ${newsFound.join(', ')}.`);
  w('');
  return `${out.join('\n')}\n`;
}
