// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `dashboard` preset of `create_web_artifact`: a spec the model writes as
 * JSON is checked, put into the fixed page of the `dashboard` system skill and
 * handed to the chat like any other web artifact.
 *
 * Run: node --test server/tests/dashboard-preset.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDashboardSpec,
  renderDashboard
} from '../services/documents/webArtifacts/dashboardPreset.js';
import {
  inspectWebArtifact,
  runCreateWebArtifact
} from '../services/documents/webArtifacts/webArtifactTools.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile
} from '../services/documents/generatedFiles.js';
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
  sources: [{ id: 'sections', name: 'Tokens je Bereich', formula: 'SUM(tokens)' }]
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

describe('dashboard preset: the page', () => {
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

describe('dashboard preset: the spec check says what is wrong', () => {
  it('refuses what is not JSON or not a spec', () => {
    invalid('{ nope', /not valid JSON/);
    invalid('', /pass the dashboard spec/);
    invalid(undefined, /pass the dashboard spec/);
    invalid('[1]', /must be a JSON object/);
    invalid({ title: 'x' }, /at least one entry in "kpis" or "blocks"/);
    invalid({ kpis: [{ label: 'a', value: 1 }] }, /title is required/);
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

describe('dashboard preset: create_web_artifact', () => {
  it('builds the page from preset and data and holds it like any web artifact', async () => {
    clearHeldGeneratedFiles();
    const user = { id: 'u-dash' };
    const res = await runCreateWebArtifact({
      filename: 'korpus',
      preset: 'dashboard',
      data: JSON.stringify(spec()),
      user,
      chatId: 'chat-dash'
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.warnings, undefined);
    assert.equal(res.file.name, 'korpus.html');
    assert.equal(res.file.mimeType, 'text/plain');
    const html = heldGeneratedFile(user, res.file.id, { chatId: 'chat-dash' }).data.toString(
      'utf8'
    );
    assert.match(html, /id="ihub-brand-tokens"/, 'the brand colours reach the page');
    assert.match(
      html,
      /"title":"Website \\u003cKorpus\\u003e & Co"|"title":"Website \\u003cKorpus\\u003e \\u0026 Co"/
    );
    clearHeldGeneratedFiles();
  });

  it('answers a bad spec with the message that names the field, and holds nothing', async () => {
    clearHeldGeneratedFiles();
    const user = { id: 'u-dash-bad' };
    const bad = spec();
    bad.blocks[0].items[0].value = 'many';
    const res = await runCreateWebArtifact({
      filename: 'bad.html',
      preset: 'dashboard',
      data: JSON.stringify(bad),
      user,
      chatId: 'chat-dash-bad'
    });
    assert.equal(res.success, false);
    assert.match(res.error, /blocks\[0\]\.items\[0\]\.value must be a number/);
    assert.equal(res.file, undefined);
  });

  it('refuses an unknown preset and still needs content without one', async () => {
    const unknown = await runCreateWebArtifact({
      filename: 'a.html',
      preset: 'report',
      data: '{}',
      user: { id: 'u' }
    });
    assert.equal(unknown.success, false);
    assert.match(unknown.error, /Unknown preset "report"/);
    const none = await runCreateWebArtifact({ filename: 'a.html', user: { id: 'u' } });
    assert.equal(none.success, false);
    assert.match(none.error, /"content", or a preset with its "data"/);
  });

  it('ignores "content" when a preset is given: the page comes from the spec', async () => {
    clearHeldGeneratedFiles();
    const user = { id: 'u-dash-content' };
    const res = await runCreateWebArtifact({
      filename: 'x.html',
      preset: 'dashboard',
      data: spec(),
      content: '<!DOCTYPE html><html><body><script src="./x.js"></script></body></html>',
      user,
      chatId: 'chat-dash-content'
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.warnings, undefined);
    clearHeldGeneratedFiles();
  });
});

describe('dashboard skill', () => {
  it('is a system skill that brings create_web_artifact', async () => {
    const skills = [...(await loadSkillsMetadata('/nonexistent-skills-dir')).values()];
    const dashboard = skills.find(skill => skill.name === 'dashboard');
    assert.ok(dashboard, 'the dashboard skill is shipped');
    assert.equal(dashboard.isSystem, true);
    assert.deepEqual(dashboard.providedTools, ['create_web_artifact']);
    const tools = systemSkillToolsFor([dashboard]);
    assert.deepEqual(
      tools.map(tool => tool.id),
      ['create_web_artifact']
    );
    const properties = tools[0].parameters.properties;
    assert.deepEqual(properties.preset.enum, ['dashboard']);
    assert.ok(properties.data);
    assert.deepEqual(tools[0].parameters.required, ['filename']);
  });

  it('ships its spec reference and the page', async () => {
    const content = await getSkillContent('dashboard', '/nonexistent-skills-dir');
    assert.equal(content.isSystem, true);
    assert.ok(content.references.includes('references/spec.md'));
    assert.match(content.body, /preset: "dashboard"/);
    assert.ok(content.assets.some(file => file.endsWith('dashboard.html')));
  });
});
