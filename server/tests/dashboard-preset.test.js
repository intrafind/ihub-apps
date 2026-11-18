// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The dashboard page: a spec the model writes as JSON is checked, put into the
 * fixed page of the `dashboard` system skill, and read back out of it for
 * `edit_dashboard`. The tools that hold the page are in `dashboard-tools.test.js`.
 *
 * Run: node --test server/tests/dashboard-preset.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import { SPEC_FIELDS } from '../services/documents/webArtifacts/dashboardSpec.js';
import {
  checkDashboardSpec,
  dashboardSourceOf,
  dashboardWarnings,
  prepareDashboard,
  renderDashboard
} from '../services/documents/webArtifacts/dashboardPreset.js';
import { inspectWebArtifact } from '../services/documents/webArtifacts/webArtifactTools.js';
import { getSkillContent, loadSkillsMetadata } from '../services/skillLoader.js';
import { systemSkillToolsFor } from '../services/systemSkillTools.js';

const spec = () => ({
  lang: 'de',
  title: 'Website <Korpus> & Co',
  summary: 'Die Website hat **471** Seiten.',
  asOf: '2026-11-09',
  kpis: [
    { label: 'Seiten', value: 471, note: '64 sehr kurze' },
    { label: 'Stand', value: 'heute' }
  ],
  blocks: [
    {
      type: 'bars',
      title: 'Tokens je Bereich',
      share: true,
      top: 2,
      source: 'sections',
      marks: [{ label: '128k', value: 131072 }],
      items: [
        { label: 'blog', value: 212004 },
        { label: 'news', value: 97529 },
        { label: 'kunden', value: 7007 },
        { label: 'node', value: 4494 }
      ]
    },
    {
      type: 'line',
      title: 'Verlauf',
      x: ['Jan', 'Feb', 'Mär'],
      series: [{ name: 'blog', values: [1, null, 3] }]
    },
    {
      type: 'table',
      title: 'Fenster',
      columns: [
        { key: 'name', label: 'Korpus' },
        { key: 'w128', label: '128k', format: 'status' }
      ],
      rows: [{ name: 'Gesamt', w128: { text: 'zu groß', status: 'critical' } }]
    },
    { type: 'text', paragraphs: ['Kurz **gesagt**.'] }
  ],
  method: { paragraphs: ['Sitemap, gecrawlt am 9. November 2026.'] },
  sources: [
    {
      id: 'sections',
      name: 'Tokens je Bereich',
      formula: 'SUM(tokens)',
      ref: 'Korpus-Bericht vom 9. November 2026',
      url: 'https://example.com/sitemap.xml'
    }
  ]
});

/** The spec the page reads, taken back out of the finished HTML. */
function embeddedSpec(html) {
  const match = /<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html
  );
  assert.ok(match, 'the page carries its data');
  return JSON.parse(match[1]);
}

const invalid = (value, pattern) =>
  assert.throws(
    () => renderDashboard(value),
    error => pattern.test(error.message)
  );

describe('dashboard page', () => {
  it('lays a valid spec into the fixed page without any sandbox warning', () => {
    const html = renderDashboard(JSON.stringify(spec()));
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="de">/);
    assert.deepEqual(inspectWebArtifact(html, 'html'), []);
    const embedded = embeddedSpec(html);
    assert.equal(embedded.kpis.length, 2);
    assert.equal(embedded.blocks.map(b => b.type).join(), 'bars,line,table,text');
    assert.equal(embedded.sources[0].id, 'sections');
  });

  it('accepts the spec as an object as well as JSON text', () => {
    assert.equal(
      embeddedSpec(renderDashboard(spec())).title,
      embeddedSpec(renderDashboard(JSON.stringify(spec()))).title
    );
  });

  it('escapes the title and cannot be closed from inside its data', () => {
    const hostile = spec();
    hostile.title = '</title><script>alert(1)</script>';
    hostile.summary = '</script><img src=x onerror=alert(1)> ';
    hostile.notes = ['{{DATA}} {{TITLE}}'];
    const html = renderDashboard(hostile);
    assert.ok(!html.includes('<script>alert(1)'), 'title markup is escaped');
    assert.equal(
      (html.match(/<script/g) || []).length,
      2,
      'only the two script elements of the page'
    );
    assert.equal((html.match(/<\/script>/g) || []).length, 2);
    assert.ok(!html.includes(' '));
    const embedded = embeddedSpec(html);
    assert.equal(embedded.title, '</title><script>alert(1)</script>');
    assert.equal(
      embedded.notes[0],
      '{{DATA}} {{TITLE}}',
      'a value is not expanded as a placeholder'
    );
  });

  it('drops fields it does not know and keeps the order of the blocks', () => {
    const extra = spec();
    extra.unknown = 'x';
    extra.blocks[0].html = '<b>x</b>';
    const embedded = embeddedSpec(renderDashboard(extra));
    assert.equal(embedded.unknown, undefined);
    assert.equal(embedded.blocks[0].html, undefined);
  });
});

describe('dashboard spec check says what is wrong', () => {
  it('refuses what is not JSON or not a spec', () => {
    invalid('{ nope', /not valid JSON/);
    invalid('', /pass the dashboard spec/);
    invalid(undefined, /pass the dashboard spec/);
    invalid('[1]', /must be a JSON object/);
    const base = { asOf: '2026-11-09', sources: [{ id: 's', name: 'S' }] };
    invalid({ ...base, title: 'x' }, /at least one entry in "kpis" or "blocks"/);
    invalid({ ...base, kpis: [{ label: 'a', value: 1 }] }, /title is required/);
  });

  it('names the field of a bad block', () => {
    const bad = spec();
    bad.blocks[0].items[1].value = '97,529';
    invalid(bad, /blocks\[0\]\.items\[1\]\.value must be a number/);

    const unknownType = spec();
    unknownType.blocks[1].type = 'pie';
    invalid(unknownType, /blocks\[1\]\.type must be one of bars, line, table, text/);

    const lengths = spec();
    lengths.blocks[1].series[0].values = [1, 2];
    invalid(lengths, /blocks\[1\]\.series\[0\]\.values has 2 entries but blocks\[1\]\.x has 3/);

    const source = spec();
    source.blocks[0].source = 'nowhere';
    invalid(source, /blocks\[0\]\.source "nowhere" is not the id of an entry in "sources"/);

    const columns = spec();
    columns.blocks[2].columns[1].key = 'name';
    invalid(columns, /columns has a key twice/);

    const cell = spec();
    cell.blocks[2].rows[0].w128 = { status: 'good' };
    invalid(cell, /rows\[0\]\.w128 must be text, a number, null or \{text, status\}/);
  });

  it('keeps the size of a page in bounds', () => {
    const many = spec();
    many.blocks[0].items = Array.from({ length: 501 }, (_, i) => ({ label: `s${i}`, value: i }));
    invalid(many, /items has more than 500 entries/);

    const series = spec();
    series.blocks[1].series = Array.from({ length: 9 }, (_, i) => ({
      name: `s${i}`,
      values: [1, 2, 3]
    }));
    invalid(series, /series has more than 8 entries/);

    invalid(`{"title":"${'x'.repeat(1024 * 1024)}"}`, /larger than 1 MB/);
  });

  it('checks the language and the source ids', () => {
    invalid({ ...spec(), lang: '<b>' }, /lang must be a language code/);
    const ids = spec();
    ids.sources = [{ id: 'a b', name: 'x' }];
    invalid(ids, /sources\[0\]\.id must be letters, digits/);
  });

  it('checkDashboardSpec returns only what the page reads', () => {
    const checked = checkDashboardSpec({
      ...spec(),
      unknown: 1,
      notes: undefined,
      labels: { bad: 5, ok: 'x' }
    });
    assert.deepEqual(Object.keys(checked).sort(), [
      'asOf',
      'blocks',
      'kpis',
      'labels',
      'lang',
      'method',
      'sources',
      'summary',
      'title'
    ]);
    assert.deepEqual(checked.labels, { ok: 'x' });
  });
});

describe('dashboard spec: every problem at once', () => {
  /** The text after the fixed lead, for a spec that fails. */
  const problemsOf = value => {
    try {
      renderDashboard(value);
    } catch (error) {
      return error.message.replace(/^Invalid dashboard "data": /, '');
    }
    assert.fail('the spec should have been refused');
  };

  it('keeps the one-line message for a single fault', () => {
    const bad = spec();
    bad.blocks[0].items[1].value = '97,529';
    assert.equal(problemsOf(bad), 'blocks[0].items[1].value must be a number (got "97,529").');
  });

  it('lists every fault in one message, so the model fixes them in one call', () => {
    const bad = spec();
    delete bad.asOf;
    delete bad.sources;
    bad.blocks[0].items[1].value = '97,529';
    bad.blocks[1].type = 'pie';
    bad.kpis = [{ label: 'a' }];
    const message = problemsOf(bad);
    assert.match(message, /^5 problems\. /);
    for (const problem of [
      'asOf is required.',
      'sources is required.',
      'blocks[0].items[1].value must be a number (got "97,529").',
      'blocks[1].type must be one of bars, line, table, text.',
      'kpis[0].value must be a number or a text.'
    ]) {
      assert.ok(message.includes(problem), `names: ${problem}`);
    }
    assert.match(message, /Fix all of them in the next call\.$/);
  });

  it('lists a fault once and at most eight, and says how many more there are', () => {
    const bad = spec();
    bad.blocks[0].items = Array.from({ length: 12 }, (_, i) => ({ label: `s${i}`, value: 'x' }));
    const message = problemsOf(bad);
    assert.match(message, /^12 problems \(4 more after these\)\. \(1\) /);
    assert.ok(!message.includes('(9)'), 'eight are shown');
  });

  it('checks the rules that look across fields once the fields themselves are sound', () => {
    const bad = spec();
    bad.sources.push({ id: 'sections', name: 'again' });
    bad.blocks[0].share = true;
    bad.blocks[0].items[1].value = -2;
    bad.blocks[1].series[0].values = [1, 2];
    bad.blocks[2].columns.push({ key: 'name', label: 'again' });
    bad.blocks[2].sort = { key: 'nope' };
    bad.blocks[2].rows[0].w128 = { status: 'good' };
    const message = problemsOf(bad);
    for (const problem of [
      'sources has an id twice.',
      'blocks[0].items[1].value is negative (-2), which "share" cannot show',
      'blocks[1].series[0].values has 2 entries but blocks[1].x has 3',
      'blocks[2].columns has a key twice.',
      'blocks[2].sort.key must be one of the column keys.',
      'blocks[2].rows[0].w128 must be text, a number, null or {text, status}.'
    ]) {
      assert.ok(message.includes(problem), `names: ${problem}`);
    }
    // A type fault elsewhere comes first: the cross-field rules wait for it.
    const both = spec();
    both.sources.push({ id: 'sections', name: 'again' });
    delete both.asOf;
    assert.equal(problemsOf(both), 'asOf is required.');
  });

  it('says what a block is when it is not an object', () => {
    const bad = spec();
    bad.blocks[0] = 'bars';
    assert.equal(
      problemsOf(bad),
      'blocks[0] must be an object whose "type" is one of bars, line, table, text.'
    );
  });
});

describe('dashboard spec: null is "not set", as it always was for most fields', () => {
  it('accepts null for top, sort, visibleRows and the sort of a table', () => {
    const lenient = spec();
    lenient.blocks[0].top = null;
    lenient.blocks[0].sort = null;
    lenient.blocks[2].visibleRows = null;
    lenient.blocks[2].sort = null;
    const checked = checkDashboardSpec(lenient);
    assert.equal(checked.blocks[0].top, undefined);
    assert.equal(checked.blocks[0].sort, undefined);
    assert.equal(checked.blocks[2].visibleRows, undefined);
    assert.equal(checked.blocks[2].sort, undefined);
  });

  it('still refuses a value that is set and wrong', () => {
    for (const [index, field, value, pattern] of [
      [0, 'top', 0, /top must be a whole number from 1 to 50/],
      [0, 'sort', 'asc', /sort must be "desc" \(default\) or "none"/],
      [2, 'visibleRows', 1.5, /visibleRows must be a whole number from 0/]
    ]) {
      const bad = spec();
      bad.blocks[index][field] = value;
      invalid(bad, pattern);
    }
  });
});

describe('dashboard spec: the schema and its reference agree', () => {
  const reference = fs.readFileSync(
    new URL('../systemSkills/dashboard/references/spec.md', import.meta.url),
    'utf8'
  );

  it('documents every field of the page and of each block type', () => {
    const missing = [];
    for (const [part, fields] of Object.entries(SPEC_FIELDS)) {
      for (const field of fields) {
        if (!reference.includes(`\`${field}\``)) missing.push(`${part}.${field}`);
      }
    }
    assert.deepEqual(missing, [], 'fields the schema takes but spec.md does not mention');
  });

  it('lists the fields of the schema in the order the reference and the page use', () => {
    assert.deepEqual(SPEC_FIELDS.page.slice(0, 3), ['lang', 'title', 'summary']);
    assert.deepEqual(SPEC_FIELDS.bars.slice(0, 5), [
      'type',
      'title',
      'description',
      'source',
      'items'
    ]);
  });
});

describe('dashboard spec: negative bars', () => {
  const withItems = items => {
    const s = spec();
    s.blocks[0] = { type: 'bars', title: 'Wachstum', format: 'percent', items };
    return s;
  };

  it('accepts negative values and keeps them as they are', () => {
    const embedded = embeddedSpec(
      renderDashboard(
        withItems([
          { label: 'Nord', value: 4.5 },
          { label: 'Süd', value: -3 },
          { label: 'Ost', value: 0 }
        ])
      )
    );
    assert.deepEqual(
      embedded.blocks[0].items.map(item => item.value),
      [4.5, -3, 0]
    );
  });

  it('still wants a number, and refuses a negative value under "share"', () => {
    invalid(withItems([{ label: 'a', value: '-3' }]), /items\[0\]\.value must be a number/);
    invalid(withItems([{ label: 'a', value: Number.NaN }]), /items\[0\]\.value must be a number/);
    const shared = withItems([
      { label: 'a', value: 5 },
      { label: 'b', value: -2 }
    ]);
    shared.blocks[0].share = true;
    invalid(shared, /items\[1\]\.value is negative \(-2\), which "share" cannot show/);
    shared.blocks[0].items[1].value = 2;
    assert.doesNotThrow(() => renderDashboard(shared), 'the same block with parts of a whole');
  });

  it('draws them left of a zero line in the page', () => {
    const html = renderDashboard(withItems([{ label: 'a', value: -3 }]));
    assert.match(html, /is-negative/);
    assert.match(html, /bar-zero/);
    assert.deepEqual(inspectWebArtifact(html, 'html'), []);
  });
});

describe('dashboard spec: the date and the sources are required', () => {
  it('needs asOf as a date', () => {
    const none = spec();
    delete none.asOf;
    invalid(none, /asOf is required/);
    for (const bad of [
      'yesterday',
      '9 November 2026',
      '2026-13-01',
      '2026-11-32',
      'Q3 2026',
      '2026-11T10:15',
      '2026-11-09T10:15 11:00',
      '2026-11-09Tnoon',
      '2026-11-09T25'
    ]) {
      invalid({ ...spec(), asOf: bad }, /asOf must be the date of the data as YYYY-MM-DD/);
    }
    for (const good of [
      '2026-11-09',
      '2026-11',
      '2026-11-09T10:15:00Z',
      '2026-11-09 10:15',
      '2026-11-09T10:15:00.250+02:00'
    ]) {
      assert.equal(checkDashboardSpec({ ...spec(), asOf: good }).asOf, good);
    }
  });

  it('needs at least one source', () => {
    const none = spec();
    delete none.sources;
    invalid(none, /sources is required/);
    invalid({ ...spec(), sources: [] }, /sources needs at least 1 entry/);
  });

  it("keeps a source's ref and url, and takes only an http(s) address", () => {
    const [source] = checkDashboardSpec(spec()).sources;
    assert.equal(source.ref, 'Korpus-Bericht vom 9. November 2026');
    assert.equal(source.url, 'https://example.com/sitemap.xml');
    for (const url of ['javascript:alert(1)', 'example.com', 'https://a b', 'ftp://x.de/y']) {
      const bad = spec();
      bad.sources[0].url = url;
      invalid(bad, /sources\[0\]\.url must be an http\(s\) address/);
    }
    const long = spec();
    long.sources[0].ref = 'x'.repeat(301);
    invalid(long, /sources\[0\]\.ref is longer than 300 characters/);
  });

  it('shows ref and url as plain text in "Sources and formulas"', () => {
    const html = renderDashboard(spec());
    assert.match(html, /source-ref/);
    assert.match(html, /source-url/);
    assert.ok(!/<a\b/i.test(html), 'the page has no links: it cannot open them');
  });
});

describe('dashboardWarnings', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const warn = asOf => dashboardWarnings({ asOf }, { now });

  it('says nothing for data of the last months', () => {
    assert.deepEqual(warn('2026-11-09'), []);
    assert.deepEqual(warn('2026-11'), []);
    assert.deepEqual(warn('2026-08-18'), [], 'exactly three months');
    assert.deepEqual(warn('2026-11-19'), [], 'a day ahead is a time zone, not a mistake');
  });

  it('warns of a date more than three months back and says what to check', () => {
    const [old] = warn('2024-05-20');
    assert.match(old, /asOf "2024-05-20" is 29 months before today \(2026-11-18\)/);
    assert.match(old, /copied from the data/);
    assert.match(old, /from memory/);
    assert.equal(warn('2026-07-17').length, 1, 'four months');
  });

  it('warns of a date after today', () => {
    assert.match(warn('2027-01-05')[0], /is after today \(2026-11-18\)/);
    assert.equal(warn('2026-11-20').length, 1, 'two days ahead');
  });

  it('has nothing to say about a spec without a date', () => {
    assert.deepEqual(dashboardWarnings({}, { now }), []);
  });
});

describe('dashboard page: the spec in the page', () => {
  it('prepareDashboard returns the page and the checked spec', () => {
    const { html, spec: checked } = prepareDashboard(JSON.stringify({ ...spec(), unknown: 1 }));
    assert.match(html, /^<!doctype html>/i);
    assert.equal(checked.unknown, undefined);
    assert.equal(checked.title, 'Website <Korpus> & Co');
  });

  it('dashboardSourceOf reads the spec back, as the same text every time', () => {
    const html = renderDashboard(spec());
    const source = dashboardSourceOf(html);
    assert.deepEqual(source.spec, checkDashboardSpec(spec()));
    assert.equal(source.text, JSON.stringify(source.spec, null, 2));
    assert.match(
      source.text,
      /"title": "Website <Korpus> & Co"/,
      'unescaped, as the model writes it'
    );
    assert.equal(dashboardSourceOf(html)?.text, source.text);
  });

  it('dashboardSourceOf is null for a page that is no dashboard', () => {
    assert.equal(dashboardSourceOf('<!DOCTYPE html><html><body>x</body></html>'), null);
    assert.equal(
      dashboardSourceOf('<script id="dashboard-data" type="application/json">{nope</script>'),
      null
    );
    assert.equal(
      dashboardSourceOf('<script id="dashboard-data" type="application/json">[1]</script>'),
      null
    );
    assert.equal(dashboardSourceOf(undefined), null);
  });
});

describe('dashboard skill', () => {
  it('is a system skill that brings create_dashboard and edit_dashboard, and not the web artifact tools', async () => {
    const skills = [...(await loadSkillsMetadata('/nonexistent-skills-dir')).values()];
    const dashboard = skills.find(skill => skill.name === 'dashboard');
    assert.ok(dashboard, 'the dashboard skill is shipped');
    assert.equal(dashboard.isSystem, true);
    assert.deepEqual(dashboard.providedTools, ['create_dashboard', 'edit_dashboard']);
    const tools = systemSkillToolsFor([dashboard]);
    assert.deepEqual(
      tools.map(tool => tool.id),
      ['create_dashboard', 'edit_dashboard']
    );
    const [create, edit] = tools;
    assert.deepEqual(create.parameters.required, ['filename', 'data']);
    assert.equal(create.parameters.properties.preset, undefined);
    assert.equal(create.parameters.properties.content, undefined);
    assert.equal(create.outputKind, 'dashboard');
    assert.equal(create.name, 'Create dashboard');
    assert.equal(edit.name, 'Edit dashboard');
    assert.deepEqual(edit.parameters.required, ['filename', 'edits']);
    assert.equal(
      systemSkillToolsFor([dashboard], { language: 'de' })
        .map(tool => tool.name)
        .join(),
      'Dashboard erstellen,Dashboard bearbeiten'
    );
  });

  it('ships its spec reference and the page, and names its own tool', async () => {
    const content = await getSkillContent('dashboard', '/nonexistent-skills-dir');
    assert.equal(content.isSystem, true);
    assert.ok(content.references.includes('references/spec.md'));
    assert.match(content.body, /`create_dashboard`/);
    assert.match(content.body, /`edit_dashboard`/);
    assert.ok(!/preset/.test(content.body), 'no preset any more');
    assert.ok(!/create_web_artifact/.test(content.body));
    assert.ok(content.assets.some(file => file.endsWith('dashboard.html')));
  });
});
