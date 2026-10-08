/**
 * OpenDocument text (.odt) in extracted text (concepts/document-extraction/, release 2, WP-C):
 * headings, paragraphs, lists with the numbers Writer computes, tables, footnotes, links,
 * images, page breaks. Expected numbers were checked against LibreOffice's own rendering
 * (`soffice --convert-to txt`) of the same documents. The behaviour of before stays whenever the
 * admin switch is off.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

jest.mock('../../../shared/documentExtraction/odf.js', () => {
  const actual = jest.requireActual('../../../shared/documentExtraction/odf.js');
  return { ...actual, extractOdfText: jest.fn(actual.extractOdfText) };
});

const config = require('../../../client/src/api/endpoints/config');
const { extractOdfText } = require('../../../shared/documentExtraction/odf.js');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const { buildOdfFile, odfP: p, odfH: h } = require('../../utils/officeFixtures');

const extract = async (spec, options, name) =>
  (await processDocumentFile(await buildOdfFile(spec, name), options)).content;

const paragraphStyle = (name, props = '', attrs = '') =>
  `<style:style style:name="${name}" style:family="paragraph" ${attrs}>${props}</style:style>`;
const textStyle = (name, props) =>
  `<style:style style:name="${name}" style:family="text"><style:text-properties ${props}/></style:style>`;

beforeEach(() => {
  config.fetchPlatformConfig.mockReset();
  config.fetchPlatformConfig.mockResolvedValue({ features: [] });
  extractOdfText.mockClear();
});

describe('text: paragraphs and headings', () => {
  it('T-ODF-01: headings by outline level, paragraphs separated by a blank line', async () => {
    const body =
      h('Vertrag', 1) +
      p('Dieser Vertrag gilt.') +
      h('Geltungsbereich', 2) +
      p('Alle Parteien.') +
      h('Tiefe', 9);
    expect(await extract({ body })).toBe(
      '# Vertrag\n\nDieser Vertrag gilt.\n\n## Geltungsbereich\n\nAlle Parteien.\n\n###### Tiefe'
    );
  });

  it('inline: spans, repeated spaces, tabs, line breaks, no glued words', async () => {
    const body = p(
      'Erste<text:s text:c="3"/>Zeile<text:line-break/>zweite<text:tab/>Zeile, <text:span text:style-name="B">fett</text:span> und <text:span>normal</text:span>.'
    );
    expect(await extract({ body })).toBe('Erste Zeile\nzweite Zeile, fett und normal.');
  });

  it('whitespace in the XML text collapses like in the document; empty paragraphs vanish', async () => {
    expect(await extract({ body: p('  viel\n      Platz  ') + p('') + p('   ') + p('Ende') })).toBe(
      'viel Platz\n\nEnde'
    );
  });

  it('hidden text and layout fields are not sent; other fields are', async () => {
    const automatic = textStyle('Hid', 'text:display="none"');
    const body =
      p('sichtbar <text:span text:style-name="Hid">versteckt</text:span>') +
      p('Seite <text:page-number>3</text:page-number> von <text:page-count>9</text:page-count>') +
      p('Titel: <text:title>Mein Titel</text:title>');
    expect(await extract({ body, automatic })).toBe('sichtbar\n\nSeite von\n\nTitel: Mein Titel');
  });

  it('a hidden paragraph (by its style) is gone', async () => {
    const automatic = paragraphStyle(
      'Hidden',
      '<style:text-properties text:display="none"/>',
      'style:parent-style-name="Standard"'
    );
    expect(await extract({ body: p('weg', 'Hidden') + p('da'), automatic })).toBe('da');
  });

  it('T-ODF-02: tracked changes — only the accepted text (the deleted text lives in text:tracked-changes)', async () => {
    const body =
      '<text:tracked-changes><text:changed-region text:id="ct1"><text:deletion><office:change-info/>' +
      '<text:p>Gestrichen</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
      p(
        'Der Preis <text:change-start text:change-id="ct1"/><text:change-end text:change-id="ct1"/>steht fest.'
      );
    expect(await extract({ body })).toBe('Der Preis steht fest.');
  });

  it('soft hyphens are removed', async () => {
    expect(await extract({ body: p('Vertrags­recht') })).toBe('Vertragsrecht');
  });
});

describe('links, notes, images', () => {
  it('links keep their target; internal links only their text', async () => {
    const body = p(
      'Siehe <text:a xlink:href="https://example.org/a" xlink:type="simple">die Seite</text:a> und <text:a xlink:href="#Kapitel1">Kapitel 1</text:a>.'
    );
    expect(await extract({ body })).toBe('Siehe [die Seite](https://example.org/a) und Kapitel 1.');
  });

  it('a target with parentheses, spaces or backslashes stays one target; brackets in the text stay in the text', async () => {
    const link = (href, text) => `<text:a xlink:href="${href}">${text}</text:a>`;
    const body =
      p(link('https://de.wikipedia.org/wiki/Foo_(bar)', 'Foo')) +
      p(link('file:///C:/Mein Ordner/x.odt', 'Datei')) +
      p(link('..\\docs\\x.odt', 'Pfad')) +
      p(link('https://example.org/a', 'Absatz [3] der Norm')) +
      p(link('https://example.org/b', 'Ordner C:\\x\\]'));
    expect(await extract({ body })).toBe(
      [
        '[Foo](https://de.wikipedia.org/wiki/Foo_%28bar%29)',
        '[Datei](file:///C:/Mein%20Ordner/x.odt)',
        '[Pfad](..%5Cdocs%5Cx.odt)',
        '[Absatz \\[3\\] der Norm](https://example.org/a)',
        '[Ordner C:\\\\x\\\\\\]](https://example.org/b)'
      ].join('\n\n')
    );
  });

  it('T-ODF-03: footnotes and endnotes are numbered in the text and listed at the end', async () => {
    const note = (cls, text) =>
      `<text:note text:note-class="${cls}"><text:note-citation>1</text:note-citation><text:note-body>${p(text)}</text:note-body></text:note>`;
    const body = p(
      `Erste Aussage.${note('footnote', 'Quelle A')} Zweite.${note('footnote', 'Quelle B')} Dritte.${note('endnote', 'Schluss')}`
    );
    expect(await extract({ body })).toBe(
      'Erste Aussage.[^1] Zweite.[^2] Dritte.[^e1]\n\n[^1]: Quelle A\n[^2]: Quelle B\n[^e1]: Schluss'
    );
  });

  it('images show their alt text; a text box follows its paragraph', async () => {
    const image = alt =>
      `<draw:frame draw:name="Bild"><draw:image xlink:href="Pictures/a.png"/><svg:title>${alt}</svg:title></draw:frame>`;
    const box = `<draw:frame draw:name="Box"><draw:text-box>${p('Im Textfeld')}</draw:text-box></draw:frame>`;
    const noAlt = '<draw:frame><draw:image xlink:href="Pictures/b.png"/></draw:frame>';
    const body = p(`Vor ${image('Logo der Firma')} nach ${noAlt}${box}`) + p('Danach');
    expect(await extract({ body })).toBe(
      'Vor [Image: Logo der Firma] nach\n\nIm Textfeld\n\nDanach'
    );
  });
});

describe('page breaks', () => {
  it('a break before or after a paragraph, by its own style or an inherited one; none before the first content', async () => {
    const automatic =
      paragraphStyle('PB', '<style:paragraph-properties fo:break-before="page"/>') +
      paragraphStyle('PA', '<style:paragraph-properties fo:break-after="page"/>') +
      paragraphStyle('Child', '', 'style:parent-style-name="PB"');
    const body =
      p('Titelseite', 'PB') +
      p('Text') +
      p('Ende der Seite', 'PA') +
      p('Neue Seite') +
      p('Geerbt', 'Child');
    expect(await extract({ body, automatic })).toBe(
      'Titelseite\n\nText\n\nEnde der Seite\n\n[Page break]\n\nNeue Seite\n\n[Page break]\n\nGeerbt'
    );
  });

  it('a paragraph that switches the page style starts a new page', async () => {
    const automatic = paragraphStyle('Landscape', '', 'style:master-page-name="Querformat"');
    expect(await extract({ body: p('Hochformat') + p('Quer', 'Landscape'), automatic })).toBe(
      'Hochformat\n\n[Page break]\n\nQuer'
    );
  });
});

describe('tables', () => {
  const cell = (text, attrs = '') => `<table:table-cell ${attrs}>${p(text)}</table:table-cell>`;
  const covered = '<table:covered-table-cell/>';
  const row = (...cells) => `<table:table-row>${cells.join('')}</table:table-row>`;
  const table = (...rows) => `<table:table table:name="T">${rows.join('')}</table:table>`;

  it('T-ODF-04: a table with header rows is a Markdown table; without them, rows only', async () => {
    const withHeader = table(
      `<table:table-header-rows>${row(cell('Name'), cell('Frist'))}</table:table-header-rows>`,
      row(cell('Miete'), cell('3 Monate'))
    );
    const without = table(row(cell('a'), cell('b')), row(cell('c'), cell('d')));
    expect(await extract({ body: p('Davor') + withHeader + without + p('Danach') })).toBe(
      [
        'Davor',
        '',
        '| Name | Frist |',
        '| --- | --- |',
        '| Miete | 3 Monate |',
        '',
        '| a | b |',
        '| c | d |',
        '',
        'Danach'
      ].join('\n')
    );
  });

  it('merged cells: a column span keeps its text in the first column, a row span repeats it', async () => {
    const merged = table(
      row(cell('Gruppe', 'table:number-columns-spanned="2"'), covered, cell('Wert')),
      row(cell('Alpha', 'table:number-rows-spanned="2"'), cell('x'), cell('1')),
      row(covered, cell('y'), cell('2'))
    );
    expect(await extract({ body: merged })).toBe(
      ['| Gruppe |  | Wert |', '| Alpha | x | 1 |', '| Alpha | y | 2 |'].join('\n')
    );
  });

  it('cell content: several paragraphs and lists on one line, pipes escaped, repeated cells', async () => {
    const complex = `<table:table-cell>${p('erste')}${p('zweite')}<text:list><text:list-item>${p('Punkt')}</text:list-item></text:list></table:table-cell>`;
    const t = table(row(complex, cell('a|b'), cell('leer', 'table:number-columns-repeated="2"')));
    expect(await extract({ body: t })).toBe('| erste zweite Punkt | a\\|b | leer | leer |');
  });

  it('a table inside a section and a hostile repeat count', async () => {
    const t = table(
      `<table:table-row table:number-rows-repeated="1000000">${cell('x')}</table:table-row>`
    );
    const text = await extract({ body: `<text:section text:name="S">${t}</text:section>` });
    expect(text.split('\n').length).toBeLessThanOrEqual(50);
  });
});

describe('lists', () => {
  const numbered = (name, levels) =>
    `<text:list-style style:name="${name}">${levels}</text:list-style>`;
  const level = (n, format, extra = '') =>
    `<text:list-level-style-number text:level="${n}" style:num-format="${format}" ${extra}/>`;
  const bullet = n => `<text:list-level-style-bullet text:level="${n}" text:bullet-char="•"/>`;
  const item = (text, attrs = '') => `<text:list-item ${attrs}>${p(text)}</text:list-item>`;

  it('T-ODF-05: bullets are - items, nested by indentation; the items of a list stay together', async () => {
    const styles = numbered('Bullets', bullet(1) + bullet(2));
    const body =
      p('Liste:') +
      `<text:list text:style-name="Bullets"><text:list-item>${p('eins')}<text:list>${item('eins-a')}${item('eins-b')}</text:list></text:list-item>${item('zwei')}</text:list>` +
      p('Danach');
    expect(await extract({ body, styles })).toBe(
      'Liste:\n\n- eins\n  - eins-a\n  - eins-b\n- zwei\n\nDanach'
    );
  });

  it('T-ODF-06: numbered lists show the label of the level: format, prefix, suffix', async () => {
    const styles =
      numbered(
        'Num',
        level(1, '1', 'style:num-suffix="."') + level(2, 'a', 'style:num-suffix=")"')
      ) + numbered('Roman', level(1, 'I', 'style:num-prefix="Teil " style:num-suffix=":"'));
    const body =
      `<text:list text:style-name="Num"><text:list-item>${p('Erstens')}<text:list>${item('a')}${item('b')}</text:list></text:list-item>${item('Zweitens')}</text:list>` +
      `<text:list text:style-name="Roman">${item('Anfang')}${item('Mitte')}</text:list>`;
    expect(await extract({ body, styles })).toBe(
      '1. Erstens\n  a) a\n  b) b\n2. Zweitens\n\nTeil I: Anfang\nTeil II: Mitte'
    );
  });

  it('a list restarts, unless it continues: continue-numbering, continue-list, start-value', async () => {
    const styles =
      numbered('N', level(1, '1', 'style:num-suffix="."')) +
      numbered('Other', level(1, 'A', 'style:num-suffix=")"'));
    const body =
      `<text:list xml:id="l1" text:style-name="N">${item('eins')}${item('zwei')}</text:list>` +
      p('Zwischentext') +
      `<text:list text:continue-list="l1" text:style-name="N">${item('drei')}</text:list>` +
      p('Noch ein Text') +
      `<text:list text:style-name="N">${item('neu eins')}</text:list>` +
      `<text:list text:continue-numbering="true" text:style-name="N">${item('neu zwei')}</text:list>` +
      p('Ende') +
      `<text:list text:style-name="N">${item('a')}${item('b', 'text:start-value="7"')}${item('c')}</text:list>`;
    expect(await extract({ body, styles })).toBe(
      [
        '1. eins\n2. zwei',
        'Zwischentext',
        '3. drei',
        'Noch ein Text',
        '1. neu eins',
        '2. neu zwei',
        'Ende',
        '1. a\n7. b\n8. c'
      ].join('\n\n')
    );
  });

  it('continue-numbering continues the list right before it, and only one of the same style (as Writer counts)', async () => {
    const styles =
      numbered('N', level(1, '1', 'style:num-suffix="."')) +
      numbered('Other', level(1, 'a', 'style:num-suffix=")"'));
    const body =
      `<text:list text:style-name="N">${item('eins')}${item('zwei')}</text:list>` +
      `<text:list text:style-name="Other">${item('x')}${item('y')}</text:list>` +
      `<text:list text:continue-numbering="true" text:style-name="N">${item('wieder eins')}</text:list>`;
    expect(await extract({ body, styles })).toBe(
      '1. eins\n2. zwei\n\na) x\nb) y\n\n1. wieder eins'
    );
  });

  it('every item counts for a list that continues, also those of a bullet level', async () => {
    const styles =
      '<text:list-style style:name="Dots"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>' +
      numbered('N', level(1, '1', 'style:num-suffix="."'));
    const body =
      `<text:list xml:id="d" text:style-name="Dots">${item('eins')}${item('zwei')}${item('drei')}</text:list>` +
      `<text:list text:continue-list="d" text:style-name="N">${item('vier')}</text:list>`;
    expect(await extract({ body, styles })).toBe('- eins\n- zwei\n- drei\n\n4. vier');
  });

  it('a list with a header item, and an overridden style next to a start value, get no numbers rather than doubtful ones', async () => {
    const styles =
      numbered('N', level(1, '1', 'style:num-suffix="."')) +
      numbered('Other', level(1, 'A', 'style:num-suffix=")"'));
    const body =
      `<text:list text:style-name="N"><text:list-header>${p('Kopfzeile')}</text:list-header>${item('a')}${item('b')}</text:list>` +
      `<text:list text:style-name="N">${item('c')}${item('d', 'text:style-override="Other" text:start-value="1"')}${item('e')}</text:list>`;
    expect(await extract({ body, styles })).toBe('Kopfzeile\na\nb\n\n1. c\nd\ne');
  });

  it('a level that is skipped shows its start; deeper levels restart after a shallower item', async () => {
    const styles = numbered(
      'M',
      level(1, '1', 'style:num-suffix="."') +
        level(2, '1', 'text:display-levels="2"') +
        level(3, '1', 'text:display-levels="3"')
    );
    const body =
      `<text:list text:style-name="M"><text:list-item>${p('A')}<text:list>${item('A1')}${item('A2')}</text:list></text:list-item>` +
      `<text:list-item>${p('B')}<text:list><text:list-item><text:list>${item('B-1-1')}</text:list></text:list-item>${item('B2')}</text:list></text:list-item></text:list>`;
    expect(await extract({ body, styles })).toBe(
      '1. A\n  1.1 A1\n  1.2 A2\n2. B\n    2.1.1 B-1-1\n  2.2 B2'
    );
  });

  it('T-ODF-07: numbered headings inside a list (how Writer saves chapter numbers from Word)', async () => {
    const styles = numbered(
      'Chapters',
      level(1, '1', 'style:num-suffix="."') + level(2, '1', 'text:display-levels="2"')
    );
    const head = (text, lvl) => `<text:list-item>${h(text, lvl)}`;
    const body =
      `<text:list xml:id="x" text:style-name="Chapters">${head('Geltungsbereich', 1)}<text:list>${head('Definitionen', 2)}</text:list-item>${head('Pflichten', 2)}</text:list-item></text:list></text:list-item>` +
      `${head('Laufzeit', 1)}</text:list-item></text:list>` +
      h('Unnummeriert', 1) +
      `<text:list text:continue-list="x" text:style-name="Chapters">${head('Kündigung', 1)}</text:list-item></text:list>`;
    expect(await extract({ body, styles })).toBe(
      '# 1. Geltungsbereich\n\n## 1.1 Definitionen\n\n## 1.2 Pflichten\n\n# 2. Laufzeit\n\n# Unnummeriert\n\n# 3. Kündigung'
    );
  });

  it('chapter numbering through the outline style: headings whose style is bound to it', async () => {
    const outline =
      '<text:outline-style style:name="Outline">' +
      '<text:outline-level-style text:level="1" style:num-format="1" style:num-suffix="."/>' +
      '<text:outline-level-style text:level="2" style:num-format="1" text:display-levels="2"/>' +
      '<text:outline-level-style text:level="3" style:num-format=""/>' +
      '</text:outline-style>';
    const styles =
      '<style:style style:name="Heading_20_1" style:family="paragraph" style:list-style-name="Outline"/>' +
      '<style:style style:name="Heading_20_2" style:family="paragraph" style:parent-style-name="Heading_20_1"/>' +
      '<style:style style:name="Plain" style:family="paragraph" style:list-style-name=""/>';
    const body =
      h('Einleitung', 1, 'Heading_20_1') +
      h('Ziel', 2, 'Heading_20_2') +
      h('Umfang', 2, 'Heading_20_2') +
      h('Ohne Nummer', 1, 'Plain') +
      h('Ausblick', 1, 'Heading_20_1') +
      h('Detail', 3, 'Heading_20_2') +
      h('Ohne Stil', 1);
    expect(await extract({ body, styles, outline })).toBe(
      '# 1. Einleitung\n\n## 1.1 Ziel\n\n## 1.2 Umfang\n\n# Ohne Nummer\n\n# 2. Ausblick\n\n### Detail\n\n# Ohne Stil'
    );
  });

  it('no label rather than a wrong one: a letter format past z with an unknown letter sync', async () => {
    const styles = numbered(
      'L',
      level(1, 'a', 'style:num-suffix=")" style:num-letter-sync="false"')
    );
    const items = Array.from({ length: 28 }, (_, i) => item(`p${i + 1}`)).join('');
    const text = await extract({
      body: `<text:list text:style-name="L">${items}</text:list>`,
      styles
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('a) p1');
    expect(lines[25]).toBe('z) p26');
    expect(lines[26]).toBe('p27');
  });

  it('a list without a style is a list without labels', async () => {
    expect(await extract({ body: `<text:list>${item('eins')}${item('zwei')}</text:list>` })).toBe(
      'eins\nzwei'
    );
  });

  it('an item with several paragraphs: the label belongs to the first', async () => {
    const styles = numbered('N', level(1, '1', 'style:num-suffix="."'));
    const body = `<text:list text:style-name="N"><text:list-item>${p('erster')}${p('Fortsetzung')}</text:list-item>${item('zweiter')}</text:list>`;
    expect(await extract({ body, styles })).toBe('1. erster\nFortsetzung\n2. zweiter');
  });
});

describe('the package', () => {
  it('the kind of document comes from the body, not from a mimetype entry', async () => {
    expect(await extract({ body: p('ohne mimetype'), noMimetype: true })).toBe('ohne mimetype');
  });

  it('not an OpenDocument package: the structured step fails, the plain text path answers', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('hello.txt', 'x');
    const { makeFile } = require('../../utils/officeFixtures');
    const file = makeFile(
      await zip.generateAsync({ type: 'arraybuffer' }),
      'kaputt.odt',
      'application/vnd.oasis.opendocument.text'
    );
    await expect(processDocumentFile(file)).rejects.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('T-ODF-08: switch off — every text node, paragraphs on their own line, as before', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const body =
      h('Titel', 1) +
      p('Text <text:s/>mit Raum') +
      `<text:list text:style-name="N"><text:list-item>${p('Punkt')}</text:list-item></text:list>`;
    const text = await extract({ body });
    expect(text.split('\n').filter(Boolean)).toEqual(['Titel', 'Text mit Raum', 'Punkt']);
    expect(extractOdfText).not.toHaveBeenCalled();
  });
});

describe('limits', () => {
  it('deeply nested lists and sections do not overflow the stack: the plain text answers', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let body = p('innen');
    for (let i = 0; i < 400; i += 1)
      body = `<text:section text:name="s${i}">${body}</text:section>`;
    const text = await extract({ body });
    expect(text).toContain('innen');
    warn.mockRestore();
  });

  it('a paragraph of a hundred thousand spaces is read in linear time (no regex that backtracks)', async () => {
    // `text:s text:c="100"` writes a hundred spaces; a file from an API caller can chain thousands.
    const body = p(`vorher${'<text:s text:c="100"/>'.repeat(1000)}nachher`);
    const started = Date.now();
    const text = await extract({ body });
    expect(text).toBe('vorher nachher');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('spaces around a line break are removed, a break stays a break', async () => {
    const body = p(
      'eins <text:s text:c="3"/><text:line-break/> <text:s/>zwei<text:line-break/><text:line-break/>drei'
    );
    expect(await extract({ body })).toBe('eins\nzwei\n\ndrei');
  });

  it('T-PERF-05: 3,000 paragraphs and a long list assemble quickly', async () => {
    const styles =
      '<text:list-style style:name="N"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/></text:list-style>';
    const paragraphs = Array.from({ length: 3000 }, (_, i) => p(`Absatz ${i}`)).join('');
    const items = Array.from(
      { length: 2000 },
      (_, i) => `<text:list-item>${p(`Punkt ${i}`)}</text:list-item>`
    ).join('');
    const started = Date.now();
    const text = await extract({
      body: `${paragraphs}<text:list text:style-name="N">${items}</text:list>`,
      styles
    });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(text).toContain('2000. Punkt 1999');
  });
});
