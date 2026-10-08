/**
 * Word list numbering in extracted text (issue #2751, PR 2) — concepts/document-extraction/.
 *
 * Word computes `1.`, `1.1`, `a)`, `Teil I` from numbering.xml; the file does not store the
 * label, so extracted text lost chapter and clause numbers. The expectations below follow
 * Word's rules and were checked against LibreOffice as an independent renderer, which also
 * rendered several thousand random numbering structures identically (see the Test Plan).
 * Test IDs refer to "2026-10-08 Test Plan.md".
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const { formatNumber } = require('../../../shared/documentExtraction/ooxml/numbering.js');
const { buildDocxFile, p, tbl, tc, lvl, numPr } = require('../../utils/officeFixtures');

const extract = async spec => (await processDocumentFile(await buildDocxFile(spec))).content;

const heading = (id, name, ppr = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
  `${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}</w:style>`;

/** A list definition; `levels` are raw <w:lvl> XML. */
const abstractNum = (id, levels, extra = '') =>
  `<w:abstractNum w:abstractNumId="${id}">${extra}${levels}</w:abstractNum>`;
const num = (id, abstractId, overrides = '') =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>${overrides}</w:num>`;
const startOverride = (ilvl, value) =>
  `<w:lvlOverride w:ilvl="${ilvl}"><w:startOverride w:val="${value}"/></w:lvlOverride>`;
/** A level that is linked to a paragraph style (Word writes this for heading numbering). */
const linkedLvl = (ilvl, numFmt, text, styleId) =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>` +
  `<w:pStyle w:val="${styleId}"/><w:lvlText w:val="${text}"/></w:lvl>`;

const HEADINGS =
  heading(
    'berschrift1',
    'heading 1',
    '<w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/>'
  ) +
  heading(
    'berschrift2',
    'heading 2',
    '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="1"/>'
  );
const HEADING_LIST =
  abstractNum(
    0,
    linkedLvl(0, 'decimal', '%1.', 'berschrift1') + linkedLvl(1, 'decimal', '%1.%2', 'berschrift2')
  ) + num(1, 0);

describe('formatNumber', () => {
  it('formats like Word and like LibreOffice', () => {
    expect(formatNumber(1, 'decimal')).toBe('1');
    expect(formatNumber(7, 'decimalZero')).toBe('07');
    expect(formatNumber(12, 'decimalZero')).toBe('12');
    expect(formatNumber(4, 'lowerRoman')).toBe('iv');
    expect(formatNumber(49, 'upperRoman')).toBe('XLIX');
    expect(formatNumber(4000, 'upperRoman')).toBe('4000');
    expect(formatNumber(26, 'lowerLetter')).toBe('z');
    // Word repeats the letter instead of counting in base 26.
    expect(formatNumber(27, 'lowerLetter')).toBe('aa');
    expect(formatNumber(28, 'lowerLetter')).toBe('bb');
    expect(formatNumber(53, 'upperLetter')).toBe('AAA');
    expect(formatNumber(1, 'ordinal')).toBe('1st');
    expect(formatNumber(12, 'ordinal')).toBe('12th');
    expect(formatNumber(22, 'ordinal')).toBe('22nd');
    // A format that is not implemented counts in decimals, never throws.
    expect(formatNumber(3, 'chineseCounting')).toBe('3');
    expect(formatNumber(3, undefined)).toBe('3');
  });
});

describe('Word numbering in extracted text', () => {
  it('T-DOCX-03: chapter numbers of heading styles, also when the level comes from the style link', async () => {
    const content = await extract({
      styles: HEADINGS,
      numbering: HEADING_LIST,
      body:
        p('Geltungsbereich', '<w:pStyle w:val="berschrift1"/>') +
        p('Definitionen', '<w:pStyle w:val="berschrift2"/>') +
        p('Pflichten', '<w:pStyle w:val="berschrift2"/>') +
        p('Laufzeit', '<w:pStyle w:val="berschrift1"/>') +
        p('1.1 Manuell getippt') +
        p('Mischfall', '<w:pStyle w:val="berschrift1"/><w:numPr><w:ilvl w:val="1"/></w:numPr>')
    });
    expect(content).toBe(
      [
        '# 1. Geltungsbereich',
        '## 1.1 Definitionen',
        '## 1.2 Pflichten',
        '# 2. Laufzeit',
        '1.1 Manuell getippt', // typed by hand: already text, no second label
        '# 2.1 Mischfall' // numId from the style, ilvl from the paragraph
      ].join('\n\n')
    );
  });

  it('T-DOCX-03: a level that only the numbering definition links to the style', async () => {
    const content = await extract({
      styles:
        heading('Kapitel', 'Kapitel', '<w:numPr><w:numId w:val="1"/></w:numPr>') +
        heading('Unter', 'Unter', '<w:numPr><w:numId w:val="1"/></w:numPr>'),
      numbering:
        abstractNum(
          0,
          linkedLvl(0, 'decimal', '%1.', 'Kapitel') + linkedLvl(1, 'decimal', '%1.%2', 'Unter')
        ) + num(1, 0),
      body:
        p('Eins', '<w:pStyle w:val="Kapitel"/>') +
        p('Eins eins', '<w:pStyle w:val="Unter"/>') +
        p('Zwei', '<w:pStyle w:val="Kapitel"/>')
    });
    expect(content).toBe('1. Eins\n\n1.1 Eins eins\n\n2. Zwei');
  });

  it('T-DOCX-04: numId 0 switches the numbering off and the sequence goes on', async () => {
    const content = await extract({
      styles: HEADINGS,
      numbering: HEADING_LIST,
      body:
        p('A', '<w:pStyle w:val="berschrift1"/>') +
        p(
          'Unnummeriert',
          '<w:pStyle w:val="berschrift1"/><w:numPr><w:numId w:val="0"/></w:numPr>'
        ) +
        p('B', '<w:pStyle w:val="berschrift1"/>')
    });
    expect(content).toBe('# 1. A\n\n# Unnummeriert\n\n# 2. B');
  });

  const letterList = abstractNum(0, lvl(0, 'lowerLetter', '%1)'));
  const item = (text, numId = 1, ilvl = 0) => p(text, numPr(numId, ilvl));

  it('T-DOCX-07: a start override restarts the list', async () => {
    const content = await extract({
      numbering:
        letterList + num(1, 0) + num(2, 0, startOverride(0, 1)) + num(3, 0, startOverride(0, 5)),
      body: item('erster') + item('zweiter') + item('neu gestartet', 2) + item('bei fünf', 3)
    });
    expect(content).toBe('a) erster\n\nb) zweiter\n\na) neu gestartet\n\ne) bei fünf');
  });

  it('T-DOCX-07: an override on one level does not restart a list first used at another level', async () => {
    const content = await extract({
      numbering:
        abstractNum(0, lvl(0, 'upperLetter', '%1.') + lvl(1, 'decimal', '%2)')) +
        num(1, 0) +
        num(2, 0, startOverride(0, 4)),
      body: item('A', 1, 0) + item('eins', 1, 1) + item('zwei', 1, 1) + item('weiter unten', 2, 1)
    });
    expect(content).toBe('A. A\n\n1) eins\n\n2) zwei\n\n3) weiter unten');
  });

  it('T-DOCX-08: two lists with one definition continue each other', async () => {
    const content = await extract({
      numbering: letterList + num(1, 0) + num(2, 0),
      body: item('eins', 1) + item('zwei', 1) + item('drei', 2)
    });
    expect(content).toBe('a) eins\n\nb) zwei\n\nc) drei');
  });

  it('T-DOCX-09: formats, prefixes and suffixes', async () => {
    const levels = [
      ['decimalZero', '%1.'],
      ['lowerLetter', '%1)'],
      ['upperLetter', '%1)'],
      ['lowerRoman', '%1.'],
      ['upperRoman', 'Teil %1'],
      ['decimal', '§ %1'],
      ['decimal', '(%1)'],
      ['none', '%1.'],
      ['chineseCounting', '%1.'],
      ['ordinal', '%1']
    ];
    const content = await extract({
      numbering: levels
        .map(([format, text], i) => abstractNum(i, lvl(0, format, text)) + num(i + 1, i))
        .join(''),
      body: levels.map(([format], i) => item(`${format} Punkt`, i + 1)).join('')
    });
    expect(content.split('\n\n')).toEqual([
      '01. decimalZero Punkt',
      'a) lowerLetter Punkt',
      'A) upperLetter Punkt',
      'i. lowerRoman Punkt',
      'Teil I upperRoman Punkt',
      '§ 1 decimal Punkt',
      '(1) decimal Punkt',
      'none Punkt', // numFmt none: no label
      '1. chineseCounting Punkt', // not implemented: decimal
      '1st ordinal Punkt'
    ]);
  });

  it('T-DOCX-09: letters repeat after z, roman numerals follow the usual rules', async () => {
    const content = await extract({
      numbering: letterList + num(1, 0) + abstractNum(1, lvl(0, 'lowerRoman', '%1.')) + num(2, 1),
      body:
        Array.from({ length: 28 }, (_, i) => item(`b${i + 1}`)).join('') +
        Array.from({ length: 9 }, (_, i) => item(`r${i + 1}`, 2)).join('')
    });
    const lines = content.split('\n\n');
    expect(lines[25]).toBe('z) b26');
    expect(lines[26]).toBe('aa) b27');
    expect(lines[27]).toBe('bb) b28');
    expect(lines[28]).toBe('i. r1');
    expect(lines[31]).toBe('iv. r4');
    expect(lines[36]).toBe('ix. r9');
  });

  it('T-DOCX-10: deeper levels start over when a higher level continues', async () => {
    const content = await extract({
      numbering: abstractNum(0, lvl(0, 'decimal', '%1.') + lvl(1, 'decimal', '%1.%2')) + num(1, 0),
      body: item('a', 1, 0) + item('b', 1, 1) + item('c', 1, 1) + item('d', 1, 0) + item('e', 1, 1)
    });
    expect(content).toBe('1. a\n\n1.1 b\n\n1.2 c\n\n2. d\n\n2.1 e');
  });

  it('T-DOCX-11: a skipped level shows its start value', async () => {
    const content = await extract({
      numbering:
        abstractNum(
          0,
          lvl(0, 'decimal', '%1.') + lvl(1, 'decimal', '%1.%2') + lvl(2, 'decimal', '%1.%2.%3')
        ) + num(1, 0),
      body: item('a', 1, 0) + item('tief', 1, 2) + item('b', 1, 0)
    });
    expect(content).toBe('1. a\n\n1.1.1 tief\n\n2. b');
  });

  it('T-DOCX-12: legal numbering shows every level as an Arabic number', async () => {
    const content = await extract({
      numbering:
        abstractNum(
          0,
          lvl(0, 'upperRoman', '%1.') +
            '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>'
        ) + num(1, 0),
      body:
        item('Teil', 1, 0) +
        item('Unterteil', 1, 1) +
        item('Teil zwei', 1, 0) +
        item('wieder', 1, 1)
    });
    expect(content).toBe('I. Teil\n\n1.1 Unterteil\n\nII. Teil zwei\n\n2.1 wieder');
  });

  it('T-DOCX-12: a level with its own restart rule gets no label — a wrong number is worse than none', async () => {
    const content = await extract({
      numbering:
        abstractNum(
          0,
          lvl(0, 'decimal', '%1.') +
            '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlRestart w:val="0"/><w:lvlText w:val="%2)"/></w:lvl>' +
            lvl(2, 'decimal', '%1.%2.%3')
        ) + num(1, 0),
      body:
        item('Eins', 1, 0) +
        item('ohne Neustart', 1, 1) +
        item('verweist darauf', 1, 2) +
        item('Zwei', 1, 0)
    });
    // The first level is unaffected; the level with the rule and the one that shows it are not numbered.
    expect(content).toBe('1. Eins\n\nohne Neustart\n\nverweist darauf\n\n2. Zwei');
  });

  it('a level that a list instance overrides in full follows the override: restart rule and style link', async () => {
    const restartLevel =
      '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlRestart w:val="0"/><w:lvlText w:val="%1.%2"/></w:lvl>';
    const styledLevel =
      '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:pStyle w:val="Unterpunkt"/><w:lvlText w:val="%2)"/></w:lvl>';
    const content = await extract({
      styles: heading('Unterpunkt', 'Unterpunkt'),
      numbering:
        abstractNum(0, lvl(0, 'decimal', '%1.') + lvl(1, 'decimal', '%1.%2')) +
        // Instance 1 replaces level 1 by one with a custom restart rule: no label there.
        `<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="1">${restartLevel}</w:lvlOverride></w:num>` +
        // Instance 2 links level 1 to a paragraph style; the abstract definition does not.
        `<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="1">${styledLevel}</w:lvlOverride></w:num>`,
      body:
        p('Eins', numPr(1, 0)) +
        p('Unterpunkt ohne Nummer', numPr(1, 1)) +
        p('Zwei', numPr(1, 0)) +
        // A paragraph that only names the style and the list: level 1 comes from the override.
        p(
          'Gebundener Unterpunkt',
          `<w:pStyle w:val="Unterpunkt"/><w:numPr><w:numId w:val="2"/></w:numPr>`
        )
    });
    expect(content).toBe(
      '1. Eins\n\nUnterpunkt ohne Nummer\n\n2. Zwei\n\na) Gebundener Unterpunkt'
    );
  });

  it("T-DOCX-13: a list that is defined by a numbering style uses that style's list", async () => {
    const content = await extract({
      styles:
        '<w:style w:type="numbering" w:styleId="ListStyle"><w:name w:val="ListStyle"/>' +
        '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>',
      numbering:
        abstractNum(0, '', '<w:numStyleLink w:val="ListStyle"/>') +
        abstractNum(
          1,
          lvl(0, 'lowerLetter', '%1)') + lvl(1, 'decimal', '%1.%2'),
          '<w:styleLink w:val="ListStyle"/>'
        ) +
        num(1, 0) +
        num(2, 1),
      body: item('A1') + item('A2') + item('A21', 1, 1) + item('A3')
    });
    expect(content).toBe('a) A1\n\nb) A2\n\nb.1 A21\n\nc) A3');
  });

  it('T-DOCX-15: dangling references never throw and never invent a label', async () => {
    const content = await extract({
      numbering: letterList + num(1, 0) + '<w:num w:numId="2"><w:abstractNumId w:val="9"/></w:num>',
      body:
        item('ohne Definition', 7) + // numId without w:num
        item('Definition fehlt', 2) + // w:num points to a missing definition
        item('Ebene fehlt', 1, 5) + // ilvl the definition does not have
        item('normal', 1)
    });
    expect(content).toBe('ohne Definition\n\nDefinition fehlt\n\nEbene fehlt\n\na) normal');
  });

  it('T-DOCX-15: a list level without text and literal text without a placeholder', async () => {
    const content = await extract({
      numbering:
        abstractNum(
          0,
          lvl(0, 'decimal', 'Art. %1') + lvl(1, 'decimal', '') + lvl(2, 'decimal', 'x')
        ) + num(1, 0),
      body: item('C1', 1, 0) + item('ohne Zahl', 1, 1) + item('Literal', 1, 2) + item('C2', 1, 0)
    });
    expect(content).toBe('Art. 1 C1\n\nohne Zahl\n\nx Literal\n\nArt. 2 C2');
  });

  it('counts a numbered paragraph without text but shows no label for it', async () => {
    const content = await extract({
      numbering: abstractNum(0, lvl(0, 'decimal', '%1.')) + num(1, 0),
      body: item('B1') + `<w:p><w:pPr>${numPr(1, 0)}</w:pPr></w:p>` + item('B3')
    });
    expect(content).toBe('1. B1\n\n3. B3');
  });

  it('keeps bullet lists as lists, and shows a bullet under a numbered level as a plain dash', async () => {
    const content = await extract({
      numbering:
        abstractNum(0, lvl(0, 'bullet', '•') + lvl(1, 'bullet', '◦')) +
        num(1, 0) +
        abstractNum(1, lvl(0, 'decimal', '%1.') + lvl(1, 'bullet', '•')) +
        num(2, 1),
      body:
        item('Leistung', 1) +
        item('Vergütung', 1) +
        item('Unterpunkt', 1, 1) +
        p('trennt') +
        item('Klausel', 2, 0) +
        item('Spiegelstrich', 2, 1) +
        item('Klausel zwei', 2, 0)
    });
    expect(content).toBe(
      '- Leistung\n- Vergütung\n  - Unterpunkt\n\ntrennt\n\n1. Klausel\n\n- Spiegelstrich\n\n2. Klausel zwei'
    );
  });

  it('numbers paragraphs in table cells in document order', async () => {
    const content = await extract({
      numbering: abstractNum(0, lvl(0, 'decimal', '%1.')) + num(1, 0),
      body:
        item('vor der Tabelle') +
        tbl([tc(item('in der Zelle')), tc(p('rechts'))]) +
        item('nach der Tabelle')
    });
    expect(content).toBe(
      '1. vor der Tabelle\n\n| 2. in der Zelle | rechts |\n| --- | --- |\n\n3. nach der Tabelle'
    );
  });

  describe('paragraphs that are not part of the accepted view take no number', () => {
    const list = abstractNum(0, lvl(0, 'decimal', '%1.')) + num(1, 0);

    it('T-DOCX-20: a hidden numbered paragraph', async () => {
      const content = await extract({
        numbering: list,
        body:
          item('eins') +
          `<w:p><w:pPr>${numPr(1, 0)}<w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>versteckt</w:t></w:r></w:p>` +
          item('drei')
      });
      expect(content).toBe('1. eins\n\n2. drei');
    });

    it('T-DOCX-21: a numbered paragraph whose mark is a tracked deletion or a move away', async () => {
      const content = await extract({
        numbering: list,
        body:
          item('eins') +
          `<w:p><w:pPr>${numPr(1, 0)}<w:rPr><w:del w:id="1" w:author="A"/></w:rPr></w:pPr>` +
          '<w:del w:id="2" w:author="A"><w:r><w:delText>gelöscht</w:delText></w:r></w:del></w:p>' +
          `<w:p><w:pPr>${numPr(1, 0)}<w:rPr><w:moveFrom w:id="3" w:author="A"/></w:rPr></w:pPr>` +
          '<w:moveFrom w:id="4" w:author="A"><w:r><w:t>verschoben</w:t></w:r></w:moveFrom></w:p>' +
          item('zwei')
      });
      expect(content).toBe('1. eins\n\n2. zwei');
    });

    it('a numbered paragraph with only deleted text or a field code counts, but shows no label', async () => {
      const content = await extract({
        numbering: list,
        body:
          item('eins') +
          // The text was deleted, the paragraph mark was not: Word still numbers the empty paragraph.
          `<w:p><w:pPr>${numPr(1, 0)}</w:pPr><w:del w:id="2" w:author="A"><w:r><w:delText>weg</w:delText></w:r></w:del></w:p>` +
          `<w:p><w:pPr>${numPr(1, 0)}</w:pPr><w:r><w:instrText xml:space="preserve"> SEQ x </w:instrText></w:r></w:p>` +
          item('vier')
      });
      expect(content).toBe('1. eins\n\n4. vier');
    });
  });

  describe('values from the document are bounded (a crafted file must not stall or exhaust the tab)', () => {
    const started = () => Date.now();
    const quick = since => expect(Date.now() - since).toBeLessThan(3000);

    it("a list level far beyond Word's nine gets no label and costs nothing", async () => {
      const since = started();
      const content = await extract({
        numbering:
          abstractNum(0, lvl(0, 'decimal', '%1.') + lvl(2000000000, 'decimal', '%1.')) + num(1, 0),
        body: p('eins', numPr(1, 0)) + p('tief', numPr(1, 2000000000)) + p('zwei', numPr(1, 0))
      });
      quick(since);
      expect(content).toBe('1. eins\n\ntief\n\n2. zwei');
    });

    it('a start value no list has (letters from two billion) gets no label', async () => {
      const since = started();
      const content = await extract({
        numbering: abstractNum(0, lvl(0, 'lowerLetter', '%1)', 2000000000)) + num(1, 0),
        body: p('A', numPr(1, 0)) + p('B', numPr(1, 0))
      });
      quick(since);
      expect(content).toBe('A\n\nB');
    });

    it('a huge start override gets no label either', async () => {
      const since = started();
      const content = await extract({
        numbering:
          abstractNum(0, lvl(0, 'upperLetter', '%1.')) + num(1, 0, startOverride(0, 2000000000)),
        body: p('A', numPr(1, 0))
      });
      quick(since);
      expect(content).toBe('A');
    });

    it('label text of two million characters is not expanded for every paragraph', async () => {
      const since = started();
      const content = await extract({
        numbering: abstractNum(0, lvl(0, 'decimal', '%1'.repeat(2000000))) + num(1, 0),
        body: Array.from({ length: 50 }, (_, n) => p(`x${n}`, numPr(1, 0))).join('')
      });
      quick(since);
      expect(content.length).toBeLessThan(1000);
      expect(content).toContain('x0\n\nx1');
    });

    it('large but real letter values become decimals instead of long strings of one letter', () => {
      expect(formatNumber(26, 'lowerLetter')).toBe('z');
      expect(formatNumber(780, 'lowerLetter')).toHaveLength(30);
      expect(formatNumber(781, 'lowerLetter')).toBe('781');
      expect(formatNumber(1000000, 'upperLetter')).toBe('1000000');
    });
  });

  it('T-DOCX-28: numbering in a Strict OOXML document', async () => {
    const content = await extract({
      strict: true,
      styles: HEADINGS,
      numbering: HEADING_LIST,
      body:
        p('Geltungsbereich', '<w:pStyle w:val="berschrift1"/>') +
        p('Definitionen', '<w:pStyle w:val="berschrift2"/>')
    });
    expect(content).toBe('# 1. Geltungsbereich\n\n## 1.1 Definitionen');
  });

  it('is off with the admin switch: no labels, as before', async () => {
    const config = require('../../../client/src/api/endpoints/config');
    config.fetchPlatformConfig.mockResolvedValueOnce({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const content = await extract({
      styles: HEADINGS,
      numbering: HEADING_LIST,
      body: p('Geltungsbereich', '<w:pStyle w:val="berschrift1"/>') + p('Text')
    });
    expect(content).toBe('GeltungsbereichText');
  });
});
