// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sizing result as a dashboard spec: built from the same analysis as the
 * Markdown report, accepted by the `dashboard` preset of `create_web_artifact`
 * and in the language asked for.
 *
 * Run: node --test server/tests/website-corpus-dashboard.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyseCorpus, windowFit } from '../services/websiteCorpus/stats.js';
import { buildDashboard } from '../services/websiteCorpus/dashboard.js';
import {
  checkDashboardSpec,
  renderDashboard
} from '../services/documents/webArtifacts/dashboardPreset.js';
import { inspectWebArtifact } from '../services/documents/webArtifacts/webArtifactTools.js';

const words = (count, tag = '') =>
  Array.from({ length: count }, (_v, i) => `wort${tag}${i % 17}`).join(' ');

const META = {
  crawlDate: '2026-11-09',
  siteUrl: 'https://a.test',
  prefix: '/de/',
  dropSelector: '',
  coverage: { inSitemap: 6, crawled: 6, failed: 0, blockedByRobots: 0, notHtml: 0, notCrawled: 0 }
};
const TOKENIZER = { method: 'heuristic', note: 'one token per 4 characters' };

async function input(extraPages = []) {
  const pages = [
    { url: 'https://a.test/de/blog/a', text: words(4000, 'a') },
    { url: 'https://a.test/de/blog/b', text: words(3000, 'b') },
    { url: 'https://a.test/de/news/x', text: words(2000, 'c') },
    { url: 'https://a.test/de/news/y', text: words(1500, 'd') },
    { url: 'https://a.test/de/kontakt', text: 'kurz' },
    { url: 'https://a.test/de/impressum', text: words(300, 'e') },
    ...extraPages
  ];
  const analysis = await analyseCorpus(pages, { countTokens: t => t.length, prefix: '/de/' });
  return {
    name: 'Test Corp',
    analysis,
    nearDuplicates: { total: 2, pairs: [] },
    tokenizer: TOKENIZER,
    meta: META
  };
}

describe('buildDashboard', () => {
  it('builds a spec the dashboard preset accepts and renders without warnings', async () => {
    const spec = buildDashboard(await input());
    assert.doesNotThrow(() => checkDashboardSpec(spec));
    const html = renderDashboard(spec);
    assert.deepEqual(inspectWebArtifact(html, 'html'), []);
  });

  it('carries the figures of the analysis and computes none of its own', async () => {
    const data = await input();
    const { totals, sections } = data.analysis;
    const spec = buildDashboard(data);
    assert.equal(spec.title, 'Test Corp Website Corpus');
    assert.deepEqual(
      spec.kpis.map(k => k.value),
      [totals.pages, totals.tokens, totals.tokensDedup, totals.chars]
    );
    assert.equal(spec.asOf, '2026-11-09');
    const bars = spec.blocks.find(b => b.title === 'Tokens by section');
    assert.deepEqual(
      bars.items.map(i => [i.label, i.value]),
      sections.map(s => [s.section, s.tokens])
    );
    assert.equal(bars.share, true);
    const fitBars = spec.blocks.find(b => b.title === 'Does it fit in one context window?');
    assert.deepEqual(
      fitBars.marks.map(m => m.value),
      [131072, 262144, 1048576]
    );
    assert.equal(fitBars.items[0].value, totals.tokens);
    assert.equal(fitBars.items[1].value, totals.tokensDedup);
    // Blog and news are found, so the core rows are there.
    assert.equal(fitBars.items.length, 4);
    assert.equal(fitBars.items[2].value, data.analysis.core.tokens);
  });

  it('marks what fits and what does not with a status and a word', async () => {
    const data = await input();
    const spec = buildDashboard(data);
    const table = spec.blocks.find(b => b.title === 'Fit per window');
    const full = table.rows[0];
    const fit = windowFit(data.analysis.totals.tokens);
    for (const cell of fit) {
      const shown = full[cell.label];
      assert.equal(shown.status, cell.fits ? 'good' : 'critical');
      assert.match(shown.text, cell.fits ? /\(fits\)$/ : /\(\d+ windows\)$/);
    }
  });

  it('lists the largest pages by path and the sections with their dedup saving', async () => {
    const spec = buildDashboard(await input());
    const largest = spec.blocks.find(b => b.title === 'Largest pages');
    assert.equal(largest.rows[0].path, '/de/blog/a');
    assert.ok(largest.rows.every(row => !row.path.includes('https://')));
    const all = spec.blocks.find(b => b.title === 'All sections');
    assert.ok(all.rows.every(row => row.saving === null || typeof row.saving === 'number'));
  });

  it('speaks German when asked, with German number formats', async () => {
    const spec = buildDashboard({ ...(await input()), language: 'de' });
    assert.equal(spec.lang, 'de');
    assert.equal(spec.title, 'Test Corp Website-Korpus');
    assert.match(spec.summary, /Seiten mit \*\*\d/);
    assert.ok(spec.blocks.some(b => b.title === 'Passt er in ein Kontextfenster?'));
    assert.ok(spec.method.paragraphs[0].startsWith('Seiten:'));
    // Ratios use the decimal comma, and the tokenizer note is German too.
    const fit = spec.blocks.find(b => b.title === 'Passt je Fenster');
    assert.match(JSON.stringify(fit.rows), /\d,\d\d \((passt|\d+ Fenster)\)/);
    assert.ok(
      spec.notes.some(note =>
        /^Die Tokens sind Schätzungen \(gezählt als ein Token je 4 Zeichen/.test(note)
      )
    );
    assert.doesNotThrow(() => checkDashboardSpec(spec));
    // Anything but "de" is English.
    assert.equal(buildDashboard({ ...(await input()), language: 'fr' }).lang, 'en');
  });

  it('says so when the crawl is incomplete and leaves out core rows without blog or news', async () => {
    const data = await input();
    data.meta = { ...META, coverage: { ...META.coverage, notCrawled: 4 } };
    const spec = buildDashboard(data);
    assert.ok(spec.notes.some(note => /incomplete: 4 pages have not been crawled/.test(note)));

    const plain = await analyseCorpus(
      [
        { url: 'https://a.test/de/x/1', text: words(200) },
        { url: 'https://a.test/de/x/2', text: words(300) }
      ],
      { countTokens: t => t.length, prefix: '/de/' }
    );
    const noNews = buildDashboard({ ...data, analysis: plain });
    const fitBars = noNews.blocks.find(b => b.title === 'Does it fit in one context window?');
    assert.equal(fitBars.items.length, 2);
  });

  it('keeps an unusually large site within the limits of a dashboard block', async () => {
    const pages = Array.from({ length: 450 }, (_v, i) => ({
      url: `https://a.test/de/s${i}/1`,
      text: words(20 + (i % 7), String(i))
    })).flatMap(page => [page, { ...page, url: page.url.replace('/1', '/2') }]);
    const spec = buildDashboard(await input(pages));
    assert.doesNotThrow(() => checkDashboardSpec(spec));
    const bars = spec.blocks.find(b => b.title === 'Tokens by section');
    assert.equal(bars.items.length, 401, '400 sections and one entry for the rest');
    assert.match(bars.items.at(-1).label, /smaller sections$/);
  });

  it('lets a section name from the site stay text', async () => {
    const hostile = [
      { url: 'https://a.test/de/%3Cimg%20src=x%20onerror=alert(1)%3E/1', text: words(50, 'z') },
      { url: 'https://a.test/de/%3Cimg%20src=x%20onerror=alert(1)%3E/2', text: words(60, 'y') }
    ];
    const html = renderDashboard(buildDashboard(await input(hostile)));
    assert.equal((html.match(/<script/g) || []).length, 2);
    assert.ok(!html.includes('<img src=x'));
  });
});
