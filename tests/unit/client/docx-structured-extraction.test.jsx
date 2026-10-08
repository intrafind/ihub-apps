/**
 * Structured DOCX extraction (issue #2751, PR 1) — concepts/document-extraction/.
 *
 * Asserts on the exact string the model receives from processDocumentFile().
 * Test IDs refer to "2026-10-08 Test Plan.md".
 */
import '@testing-library/jest-dom';

// fileProcessing transitively imports the API client, which uses `import.meta.env`
// and cannot be parsed by babel-jest. Mock the endpoints it pulls in.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

// A seam for T-DOCX-27: the structured pipeline can be made to throw.
jest.mock('../../../shared/documentExtraction/docx.js', () => {
  const actual = jest.requireActual('../../../shared/documentExtraction/docx.js');
  return { ...actual, extractDocxMarkdown: jest.fn(actual.extractDocxMarkdown) };
});

const config = require('../../../client/src/api/endpoints/config');
const { extractDocxMarkdown } = require('../../../shared/documentExtraction/docx.js');
const {
  processDocumentFile,
  legacyDocxText
} = require('../../../client/src/features/upload/utils/fileProcessing');
const { renderUserMessage } = require('../../../shared/promptContext.js');
const {
  DOCX_MIME,
  buildDocxFile,
  p,
  tbl,
  tc,
  partOverride,
  relationship
} = require('../../utils/officeFixtures');

const extract = async spec => (await processDocumentFile(await buildDocxFile(spec))).content;

const style = (id, name, ppr = '', extra = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}` +
  `${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}</w:style>`;

describe('structured DOCX extraction', () => {
  beforeEach(() => {
    config.fetchPlatformConfig.mockResolvedValue({ features: [] });
    extractDocxMarkdown.mockClear();
  });

  it('T-DOCX-01: separates paragraphs (today they are glued together)', async () => {
    const content = await extract({ body: p('Titel') + p('Absatz eins') + p('Absatz zwei') });
    expect(content).toBe('Titel\n\nAbsatz eins\n\nAbsatz zwei');
  });

  describe('headings', () => {
    it('T-DOCX-02: built-in headings in any style ID, capitalised names, level 7 capped', async () => {
      const content = await extract({
        styles:
          style('berschrift1', 'heading 1') +
          style('berschrift2', 'heading 2') +
          style('Heading3', 'Heading 3') +
          style('Heading7', 'heading 7', '<w:outlineLvl w:val="6"/>'),
        body:
          p('Kapitel', '<w:pStyle w:val="berschrift1"/>') +
          p('Unterkapitel', '<w:pStyle w:val="berschrift2"/>') +
          p('Abschnitt', '<w:pStyle w:val="Heading3"/>') +
          p('Ebene sieben', '<w:pStyle w:val="Heading7"/>') +
          p('Text')
      });
      expect(content).toBe(
        '# Kapitel\n\n## Unterkapitel\n\n### Abschnitt\n\n###### Ebene sieben\n\nText'
      );
    });

    it('T-DOCX-05: custom styles with an outline level, inherited through basedOn; cycles are safe', async () => {
      const content = await extract({
        styles:
          style('IFKapitel', 'IF Kapitel', '<w:outlineLvl w:val="0"/>') +
          style(
            'IFUnter',
            'IF Unterkapitel',
            '<w:outlineLvl w:val="1"/>',
            '<w:basedOn w:val="IFKapitel"/>'
          ) +
          style('IFSub', 'IF Sub', '', '<w:basedOn w:val="IFUnter"/>') +
          style('CycleA', 'Cycle A', '', '<w:basedOn w:val="CycleB"/>') +
          style('CycleB', 'Cycle B', '', '<w:basedOn w:val="CycleA"/>'),
        body:
          p('Corporate', '<w:pStyle w:val="IFKapitel"/>') +
          p('Corporate sub', '<w:pStyle w:val="IFUnter"/>') +
          p('Inherited', '<w:pStyle w:val="IFSub"/>') +
          p('Cycle', '<w:pStyle w:val="CycleA"/>')
      });
      expect(content).toBe('# Corporate\n\n## Corporate sub\n\n## Inherited\n\nCycle');
    });

    it('T-DOCX-06: a paragraph with its own outline level; level 9 is body text', async () => {
      const content = await extract({
        styles: style('berschrift1', 'heading 1', '<w:outlineLvl w:val="0"/>'),
        body:
          p('Direct level two', '<w:outlineLvl w:val="1"/>') +
          p('Body level', '<w:outlineLvl w:val="9"/>') +
          p(
            'Heading with its own level',
            '<w:pStyle w:val="berschrift1"/><w:outlineLvl w:val="2"/>'
          )
      });
      expect(content).toBe('## Direct level two\n\nBody level\n\n### Heading with its own level');
    });
  });

  it('T-DOCX-14: packages without styles, numbering or content do not throw', async () => {
    expect(await extract({ styles: null, numbering: null, body: p('Eins') + p('Zwei') })).toBe(
      'Eins\n\nZwei'
    );
    expect(await extract({ body: '' })).toBe('');
  });

  describe('tables', () => {
    it('T-DOCX-16: merged cells keep their columns, rows stay self-contained', async () => {
      const content = await extract({
        body:
          tbl(
            [tc(p('Name')), tc(p('Wert'))],
            [tc(p('A')), tc(p('1'))],
            [tc(p('spans two'), '<w:gridSpan w:val="2"/>')],
            [tc(p('vmerge top'), '<w:vMerge w:val="restart"/>'), tc(p('B2'))],
            [tc(p(''), '<w:vMerge/>'), tc(p('B3'))]
          ) +
          p('between') +
          tbl(
            [tc(p('Feld')), tc(p('Inhalt'))],
            [tc(p('a | b')), tc(p('one') + p('two'))],
            [tc(p('nested')), tc(tbl([tc(p('N1')), tc(p('N2'))]) + '<w:p/>')]
          )
      });
      expect(content).toBe(
        [
          '| Name | Wert |',
          '| --- | --- |',
          '| A | 1 |',
          '| spans two |  |',
          '| vmerge top | B2 |',
          '| vmerge top | B3 |',
          '',
          'between',
          '',
          '| Feld | Inhalt |',
          '| --- | --- |',
          '| a \\| b | one<br>two |',
          '| nested | N1 / N2 |'
        ].join('\n')
      );
    });
  });

  describe('table cells with backslashes', () => {
    it('keeps a backslash in front of a pipe from escaping the pipe escape', async () => {
      const content = await extract({
        body: tbl(
          [tc(p('Pfad')), tc(p('Wert'))],
          [tc(p('C:\\dir\\|x')), tc(p('plain \\ backslash'))],
          [tc(p('a\\\\|b')), tc(p('c'))]
        )
      });
      const rows = content.split('\n').slice(2);
      // In a cell with a pipe every backslash is doubled, then the pipe is escaped: `\|` → `\\\|`.
      expect(rows[0]).toBe('| C:\\\\dir\\\\\\|x | plain \\ backslash |');
      expect(rows[1]).toBe('| a\\\\\\\\\\|b | c |');
      // A cell without a pipe keeps its backslashes as typed.
      expect(rows[0]).toContain('plain \\ backslash');
    });
  });

  describe('images, links, footnotes', () => {
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const drawing = alt =>
      '<w:r><w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<wp:inline><wp:extent cx="95250" cy="95250"/>' +
      `<wp:docPr id="1" name="Bild 1"${alt ? ` descr="${alt}"` : ''}/>` +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill><pic:spPr/></pic:pic>' +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

    it('T-DOCX-17: images become alt text, never base64', async () => {
      const content = await extract({
        body:
          `<w:p><w:r><w:t xml:space="preserve">Bild: </w:t></w:r>${drawing('Organigramm')}</w:p>` +
          `<w:p><w:r><w:t xml:space="preserve">Ohne Alt: </w:t></w:r>${drawing('')}</w:p>`,
        contentTypes: '<Default Extension="png" ContentType="image/png"/>',
        rels: relationship('rIdImg1', 'image', 'media/image1.png'),
        binaryParts: { 'word/media/image1.png': PNG }
      });
      expect(content).toBe('Bild: [Image: Organigramm]\n\nOhne Alt:');
      expect(content).not.toContain('data:');
    });

    it('T-DOCX-18: table-of-contents links lose their anchor, external links stay', async () => {
      const content = await extract({
        body:
          '<w:p><w:hyperlink w:anchor="_Toc1"><w:r><w:t>Kapitel</w:t></w:r></w:hyperlink></w:p>' +
          '<w:p><w:hyperlink r:id="rIdH"><w:r><w:t>Link</w:t></w:r></w:hyperlink></w:p>',
        rels: relationship('rIdH', 'hyperlink', 'https://example.com', true)
      });
      expect(content).toBe('Kapitel\n\n[Link](https://example.com)');
    });

    it('T-DOCX-19: footnotes become [^n] references and definitions', async () => {
      const footnotes =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
        '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Fussnote Text</w:t></w:r></w:p></w:footnote>' +
        '</w:footnotes>';
      const content = await extract({
        body: '<w:p><w:r><w:t>Text</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
        parts: { 'word/footnotes.xml': footnotes },
        contentTypes: partOverride(
          '/word/footnotes.xml',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml'
        ),
        rels: relationship('rIdF', 'footnotes', 'footnotes.xml')
      });
      expect(content).toBe('Text[^1]\n\n[^1]: Fussnote Text');
    });
  });

  describe('hidden text and tracked changes', () => {
    it('T-DOCX-20: hidden runs and paragraphs are not sent to the model', async () => {
      const content = await extract({
        styles:
          style('Versteckt', 'Hidden Para', '', '<w:rPr><w:vanish/></w:rPr>') +
          '<w:style w:type="character" w:styleId="HiddenChar"><w:name w:val="Hidden Char"/><w:rPr><w:vanish/></w:rPr></w:style>',
        body:
          '<w:p><w:r><w:t xml:space="preserve">Sichtbar </w:t></w:r>' +
          '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">geheim </w:t></w:r>' +
          '<w:r><w:t>Ende</w:t></w:r></w:p>' +
          p('Versteckter Absatz', '<w:rPr><w:vanish/></w:rPr>', '<w:vanish/>') +
          p('Per Absatzformat versteckt', '<w:pStyle w:val="Versteckt"/>') +
          '<w:p><w:r><w:t xml:space="preserve">Zeichenformat </w:t></w:r>' +
          '<w:r><w:rPr><w:rStyle w:val="HiddenChar"/></w:rPr><w:t>versteckt</w:t></w:r></w:p>' +
          p('Sichtbar trotz Stil', '<w:pStyle w:val="Versteckt"/>', '<w:vanish w:val="0"/>')
      });
      expect(content).toBe('Sichtbar Ende\n\nZeichenformat\n\nSichtbar trotz Stil');
    });

    it('T-DOCX-21: accepted view — insertions stay, deletions go, moved text appears once, no comments', async () => {
      const comments =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:comment w:id="0" w:author="B"><w:p><w:r><w:t>Geheimer Kommentar</w:t></w:r></w:p></w:comment>' +
        '</w:comments>';
      const content = await extract({
        body:
          '<w:p><w:r><w:t xml:space="preserve">Alt </w:t></w:r>' +
          '<w:ins w:id="1" w:author="A"><w:r><w:t>neu</w:t></w:r></w:ins>' +
          '<w:del w:id="2" w:author="A"><w:r><w:delText xml:space="preserve"> geloescht</w:delText></w:r></w:del></w:p>' +
          '<w:p><w:pPr><w:rPr><w:del w:id="3" w:author="A"/></w:rPr></w:pPr>' +
          '<w:del w:id="4" w:author="A"><w:r><w:delText>Ganzer Absatz weg</w:delText></w:r></w:del></w:p>' +
          p('Nachfolger') +
          '<w:p><w:r><w:t xml:space="preserve">Vorne </w:t></w:r>' +
          '<w:moveFrom w:id="5" w:author="A"><w:r><w:t>verschoben</w:t></w:r></w:moveFrom></w:p>' +
          '<w:p><w:moveTo w:id="6" w:author="A"><w:r><w:t>verschoben</w:t></w:r></w:moveTo>' +
          '<w:r><w:t xml:space="preserve"> Ziel</w:t></w:r></w:p>' +
          '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Kommentiert</w:t></w:r><w:commentRangeEnd w:id="0"/>' +
          '<w:r><w:commentReference w:id="0"/></w:r></w:p>',
        parts: { 'word/comments.xml': comments },
        contentTypes: partOverride(
          '/word/comments.xml',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
        ),
        rels: relationship('rIdC', 'comments', 'comments.xml')
      });
      expect(content).toBe('Alt neu\n\nNachfolger\n\nVorne\n\nverschoben Ziel\n\nKommentiert');
    });
  });

  describe('page breaks and whitespace', () => {
    it('T-DOCX-22: a page break never glues words; no page numbers are invented', async () => {
      const content = await extract({
        body:
          '<w:p><w:r><w:t>Before page break</w:t></w:r><w:r><w:br w:type="page"/></w:r>' +
          '<w:r><w:lastRenderedPageBreak/><w:t>after break</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>eins</w:t><w:cr/><w:t>zwei</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p>'
      });
      // Turndown folds whitespace runs: a tab becomes one space, which still separates.
      expect(content).toBe('Before page break\n[Page break]\nafter break\n\neins\nzwei\n\na b');
      expect(content).not.toMatch(/\[Page \d/);
    });

    it('T-DOCX-22: page-break-before and new-page section breaks are marked once, never before the first content', async () => {
      const sectionEnd = type =>
        `<w:pPr><w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}</w:sectPr></w:pPr>`;
      const content = await extract({
        body:
          p('Erste', '<w:pageBreakBefore/>') +
          p('Zweite', '<w:pageBreakBefore/>') +
          `<w:p>${sectionEnd()}<w:r><w:t>Abschnitt eins</w:t></w:r></w:p>` +
          `<w:p>${sectionEnd('continuous')}<w:r><w:t>Abschnitt zwei</w:t></w:r></w:p>` +
          p('Abschnitt drei') +
          '<w:sectPr/>'
      });
      expect(content).toBe(
        'Erste\n\n[Page break]\n\nZweite\n\nAbschnitt eins\n\nAbschnitt zwei\n\n[Page break]\n\nAbschnitt drei'
      );
    });

    it('T-DOCX-23: Markdown characters in the document are not escaped', async () => {
      const content = await extract({
        body:
          p('1. Absatz beginnt mit Zahl. Art. 5 [1] gilt *nicht* fuer a_b') +
          p('- Strich am Anfang')
      });
      expect(content).toBe(
        '1. Absatz beginnt mit Zahl. Art. 5 [1] gilt *nicht* fuer a_b\n\n- Strich am Anfang'
      );
      expect(content).not.toContain('\\');
    });

    it('T-DOCX-24: soft hyphens vanish, non-breaking spaces and hyphens stay usable', async () => {
      const content = await extract({
        body:
          '<w:p><w:r><w:t>Silben</w:t><w:softHyphen/><w:t>trennung</w:t></w:r></w:p>' +
          p('Ge\u00ADheim') +
          p('a\u00A0b') +
          '<w:p><w:r><w:t>c</w:t><w:noBreakHyphen/><w:t>d</w:t></w:r></w:p>'
      });
      expect(content).toBe('Silbentrennung\n\nGeheim\n\na\u00A0b\n\nc-d');
    });
  });

  describe('robustness', () => {
    const fixtures = [
      { body: p('Titel') + p('Absatz eins') + p('Absatz zwei') },
      {
        styles: style('berschrift1', 'heading 1'),
        body: p('Kapitel', '<w:pStyle w:val="berschrift1"/>') + p('Text')
      },
      { body: tbl([tc(p('A')), tc(p('B'))]) + p('danach') },
      { body: '<w:p><w:r><w:t>x</w:t><w:br w:type="page"/><w:t>y</w:t></w:r></w:p>' }
    ];

    it('T-DOCX-26: with the admin switch off the output is exactly the plain text of before', async () => {
      config.fetchPlatformConfig.mockResolvedValue({
        features: [{ id: 'structuredDocumentExtraction', enabled: false }]
      });
      expect(await extract(fixtures[0])).toBe('TitelAbsatz einsAbsatz zwei');
      for (const spec of fixtures) {
        const file = await buildDocxFile(spec);
        const { content } = await processDocumentFile(file);
        expect(content).toBe(await legacyDocxText(await file.arrayBuffer()));
      }
      expect(extractDocxMarkdown).not.toHaveBeenCalled();
    });

    it('T-DOCX-27: an error in the structured path falls back to the plain text, with one warning', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        extractDocxMarkdown.mockRejectedValueOnce(new Error('boom'));
        const content = await extract(fixtures[0]);
        expect(content).toBe('TitelAbsatz einsAbsatz zwei');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/structured extraction failed, using legacy/);
      } finally {
        warn.mockRestore();
      }
    });

    it('T-DOCX-27: well-formed but unusual style parts are tolerated', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const content = await extract({
          styles:
            '<w:style w:type="paragraph"/>' +
            '<w:style w:type="paragraph" w:styleId="Loop"><w:basedOn w:val="Loop"/><w:outlineLvl w:val="x"/></w:style>' +
            '<w:style w:type="paragraph" w:styleId="NoName"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>',
          body: p('Eins', '<w:pStyle w:val="Loop"/>') + p('Zwei', '<w:pStyle w:val="NoName"/>')
        });
        expect(content).toBe('Eins\n\n# Zwei');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('T-DOCX-28: Strict OOXML documents are read', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const content = await extract({
          strict: true,
          styles: style('Heading1', 'heading 1'),
          body: p('Kapitel', '<w:pStyle w:val="Heading1"/>') + p('Text')
        });
        expect(content).toBe('# Kapitel\n\nText');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('T-DOCX-29: text boxes, content controls and cached field results are kept', async () => {
      const content = await extract({
        body:
          '<w:p><w:r><w:t>Vor dem Feld</w:t></w:r><w:r><w:pict xmlns:v="urn:schemas-microsoft-com:vml">' +
          '<v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Im Textfeld</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape>' +
          '</w:pict></w:r></w:p>' +
          '<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>Aus Inhaltssteuerelement</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
          '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF _Ref1 \\h </w:instrText></w:r>' +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Abschnitt 2.1</w:t></w:r>' +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
      });
      expect(content).toContain('Vor dem Feld');
      expect(content).toContain('Im Textfeld');
      expect(content).toContain('Aus Inhaltssteuerelement');
      expect(content).toContain('Abschnitt 2.1');
      expect(content).not.toContain('REF _Ref1');
    });

    it('T-DOCX-30: text that looks like Markdown is output literally', async () => {
      const content = await extract({
        body: p('# not a heading') + p('| a | b |') + p('---')
      });
      expect(content).toBe('# not a heading\n\n| a | b |\n\n---');
    });
  });

  describe('downstream', () => {
    it('T-DOWN-01: Markdown with a table and <br> passes unchanged through the prompt', async () => {
      const markdown = await extract({
        styles: style('berschrift1', 'heading 1'),
        body:
          p('Kapitel', '<w:pStyle w:val="berschrift1"/>') +
          tbl([tc(p('Feld')), tc(p('Inhalt'))], [tc(p('a')), tc(p('one') + p('two'))])
      });
      expect(markdown).toContain('one<br>two');
      const rendered = renderUserMessage({
        content: 'Vergleiche',
        files: [{ fileName: 'a.docx', fileType: DOCX_MIME, displayType: 'DOCX', content: markdown }]
      });
      expect(rendered).toContain(
        `<content type="document" origin="upload" name="a.docx" format="DOCX">\n${markdown}\n</content>`
      );
    });
  });
});
