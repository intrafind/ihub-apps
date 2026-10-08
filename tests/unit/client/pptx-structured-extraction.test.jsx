/**
 * PowerPoint decks in extracted text (concepts/document-extraction/, release 2, WP-D):
 * slides in the order of the presentation (not of the file names), the title as a heading,
 * tables as Markdown, hidden slides flagged, speaker notes only when an app asks for them
 * (decision A3). The behaviour of before — also asserted by pptx-file-extraction.test.jsx —
 * stays whenever the admin switch is off or the deck has no slide list.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

jest.mock('../../../shared/documentExtraction/pptx.js', () => {
  const actual = jest.requireActual('../../../shared/documentExtraction/pptx.js');
  return { ...actual, extractPptxText: jest.fn(actual.extractPptxText) };
});

const config = require('../../../client/src/api/endpoints/config');
const { extractPptxText } = require('../../../shared/documentExtraction/pptx.js');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const { makeFile } = require('../../utils/officeFixtures');
const {
  extractionOptionsOf
} = require('../../../client/src/features/upload/utils/extractionOptions');
const {
  processCloudFile
} = require('../../../client/src/features/upload/utils/cloudFileProcessing');
const { useFileUploadHandler } = require('../../../client/src/shared/hooks/useFileUploadHandler');
const { renderHook } = require('@testing-library/react');
const JSZip = require('jszip');

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const run = text => `<a:r><a:t>${text}</a:t></a:r>`;
const para = (...runs) => `<a:p>${runs.map(r => (r.startsWith('<') ? r : run(r))).join('')}</a:p>`;
const shape = (paragraphs, ph) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${
    ph ? `<p:ph type="${ph}"/>` : ''
  }</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${paragraphs.join('')}</p:txBody></p:sp>`;
const cell = (text, attrs = '') =>
  `<a:tc ${attrs}><a:txBody><a:bodyPr/>${[]
    .concat(text)
    .map(t => para(t))
    .join('')}</a:txBody></a:tc>`;
const table = (rows, tblPr = 'firstRow="1"') =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
  `<a:tblPr ${tblPr}/><a:tblGrid/>${rows.map(r => `<a:tr h="370840">${r.join('')}</a:tr>`).join('')}` +
  '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
const slide = (shapes, attrs = '') =>
  `${XML}<p:sld ${NS} ${attrs}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

/**
 * A deck. `slides` are slide XML strings in creation order (slide1.xml, slide2.xml, …);
 * `order` lists them as the presentation shows them, by index into `slides` (omit for no slide
 * list at all); `notes` maps an index to the XML of its notes slide.
 */
async function buildDeck({ slides, order, notes = {}, presentation }, name = 'deck.pptx') {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  );
  const sldIds = (order || []).map(
    (index, n) => `<p:sldId id="${256 + n}" r:id="rIdS${index + 1}"/>`
  );
  zip.file(
    'ppt/presentation.xml',
    presentation ??
      `${XML}<p:presentation ${NS}>${order ? `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>` : ''}</p:presentation>`
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      slides
        .map(
          (_, i) =>
            `<Relationship Id="rIdS${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`
        )
        .join('') +
      '</Relationships>'
  );
  slides.forEach((xml, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        (notes[i]
          ? `<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`
          : '') +
        '</Relationships>'
    );
    if (notes[i]) zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, notes[i]);
  });
  return makeFile(await zip.generateAsync({ type: 'arraybuffer' }), name, PPTX_MIME);
}

const extract = async (spec, options) =>
  (await processDocumentFile(await buildDeck(spec), options)).content;

beforeEach(() => {
  config.fetchPlatformConfig.mockReset();
  config.fetchPlatformConfig.mockResolvedValue({ features: [] });
  extractPptxText.mockClear();
});

describe('slide order', () => {
  it('T-PPT-01: slides are numbered and ordered as the presentation shows them, not as the files are named', async () => {
    const slides = [
      slide([shape([para('Erstellt zuerst')])]),
      slide([shape([para('Zweite Datei')])]),
      slide([shape([para('Dritte Datei')])])
    ];
    // The author moved the third slide to the front.
    expect(await extract({ slides, order: [2, 0, 1] })).toBe(
      '[Slide 1]\nDritte Datei\n\n[Slide 2]\nErstellt zuerst\n\n[Slide 3]\nZweite Datei'
    );
  });

  it('a deck without a slide list is read in the order of the file names, numbered by them (as before)', async () => {
    const slides = [slide([shape([para('eins')])]), slide([shape([para('zwei')])])];
    expect(await extract({ slides })).toBe('[Slide 1]\neins\n\n[Slide 2]\nzwei');
  });

  it('an unreadable presentation part costs the order, not the text', async () => {
    const slides = [slide([shape([para('eins')])]), slide([shape([para('zwei')])])];
    expect(await extract({ slides, presentation: '<p:presentation' })).toBe(
      '[Slide 1]\neins\n\n[Slide 2]\nzwei'
    );
  });

  it('a slide that is listed but missing keeps its place in the numbering', async () => {
    const zip = new JSZip();
    const file = await buildDeck({
      slides: [slide([shape([para('a')])]), slide([shape([para('b')])])],
      order: [0, 1]
    });
    const loaded = await JSZip.loadAsync(await file.arrayBuffer());
    loaded.remove('ppt/slides/slide1.xml');
    expect(zip).toBeDefined();
    const broken = makeFile(
      await loaded.generateAsync({ type: 'arraybuffer' }),
      'd.pptx',
      PPTX_MIME
    );
    expect((await processDocumentFile(broken)).content).toBe('[Slide 2]\nb');
  });

  it('a slide list whose relationships are gone falls back to the file names instead of reading nothing', async () => {
    const file = await buildDeck({
      slides: [slide([shape([para('eins')])]), slide([shape([para('zwei')])])],
      order: [1, 0]
    });
    const loaded = await JSZip.loadAsync(await file.arrayBuffer());
    loaded.remove('ppt/_rels/presentation.xml.rels');
    const broken = makeFile(
      await loaded.generateAsync({ type: 'arraybuffer' }),
      'd.pptx',
      PPTX_MIME
    );
    expect((await processDocumentFile(broken)).content).toBe('[Slide 1]\neins\n\n[Slide 2]\nzwei');
  });

  it('a Word file named .pptx is no deck — it is not read as a deck without text', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`
    );
    zip.file(
      '_rels/.rels',
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`
    );
    zip.file(
      'word/document.xml',
      `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`
    );
    const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(
      extractPptxText({ arrayBuffer, JSZip, DOMParser: window.DOMParser })
    ).rejects.toThrow(/not a presentation/);
    // A real deck that happens to have no slides is a deck without text, not an error.
    const empty = await buildDeck({ slides: [], order: [] });
    expect(
      await extractPptxText({
        arrayBuffer: await empty.arrayBuffer(),
        JSZip,
        DOMParser: window.DOMParser
      })
    ).toBe('');
  });

  it('slides with no text are skipped; a deck of pictures has no text', async () => {
    expect(await extract({ slides: [slide([shape([])]), slide([])], order: [0, 1] })).toBe('');
  });
});

describe('slide content', () => {
  it('T-PPT-02: the title is a heading and comes first; other text keeps its order', async () => {
    const slides = [
      slide([
        shape([para('Aufzaehlung ', 'eins'), para('zweiter Punkt')], 'body'),
        shape([para('Quartalsbericht')], 'title'),
        shape([para('Untertitel')], 'subTitle')
      ]),
      slide([shape([para('Kapitel'), para('Teil zwei')], 'ctrTitle')])
    ];
    expect(await extract({ slides, order: [0, 1] })).toBe(
      [
        '[Slide 1]',
        '# Quartalsbericht',
        'Aufzaehlung eins',
        'zweiter Punkt',
        'Untertitel',
        '',
        '[Slide 2]',
        '# Kapitel Teil zwei'
      ].join('\n')
    );
  });

  it('a line break inside a paragraph does not glue words; slide numbers and dates are dropped', async () => {
    const field = type => `<a:fld id="{1}" type="${type}"><a:t>‹#›</a:t></a:fld>`;
    const slides = [
      slide([
        shape([para('Zeile eins', '<a:br/>', 'Zeile zwei')], 'body'),
        shape([para(field('slidenum'))], 'sldNum'),
        shape([para(field('datetime1'))], 'dt'),
        shape([para('Vertraulich')], 'ftr'),
        shape([para('Seite ', field('slidenum'))])
      ])
    ];
    expect(await extract({ slides, order: [0] })).toBe(
      '[Slide 1]\nZeile eins Zeile zwei\nVertraulich\nSeite'
    );
  });

  it('text in grouped shapes is read once, also next to an alternate-content copy', async () => {
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>${shape([para('Gruppiert')])}</p:grpSp>`;
    const alternate =
      `<mc:AlternateContent><mc:Choice Requires="x">${shape([para('Neu')])}</mc:Choice>` +
      `<mc:Fallback>${shape([para('Alt (Rueckfall)')])}</mc:Fallback></mc:AlternateContent>`;
    expect(await extract({ slides: [slide([group, alternate])], order: [0] })).toBe(
      '[Slide 1]\nGruppiert\nNeu'
    );
  });

  it('a hidden slide is flagged and keeps its number', async () => {
    const slides = [
      slide([shape([para('sichtbar')])]),
      slide([shape([para('Reserve')])], 'show="0"'),
      slide([shape([para('wieder sichtbar')])])
    ];
    expect(await extract({ slides, order: [0, 1, 2] })).toBe(
      '[Slide 1]\nsichtbar\n\n[Slide 2 (hidden)]\nReserve\n\n[Slide 3]\nwieder sichtbar'
    );
  });
});

describe('tables', () => {
  it('T-PPT-03: a table becomes a Markdown table; the header row only when the table has one', async () => {
    const withHeader = table([
      [cell('Name'), cell('Frist')],
      [cell('Miete'), cell('3 Monate')]
    ]);
    const without = table(
      [
        [cell('a'), cell('b')],
        [cell('c'), cell('d')]
      ],
      ''
    );
    expect(
      await extract({
        slides: [slide([shape([para('Titel')], 'title'), withHeader]), slide([without])],
        order: [0, 1]
      })
    ).toBe(
      [
        '[Slide 1]',
        '# Titel',
        '',
        '| Name | Frist |',
        '| --- | --- |',
        '| Miete | 3 Monate |',
        '',
        '[Slide 2]',
        '| a | b |',
        '| c | d |'
      ].join('\n')
    );
  });

  it('merged cells: a column span keeps its text in the first column, a row span repeats it', async () => {
    const merged = table([
      [cell('Gruppe', 'gridSpan="2"'), cell('', 'hMerge="1"'), cell('Wert')],
      [cell('Alpha', 'rowSpan="2"'), cell('x'), cell('1')],
      [cell('', 'vMerge="1"'), cell('y'), cell('2')]
    ]);
    expect(await extract({ slides: [slide([merged])], order: [0] })).toBe(
      [
        '[Slide 1]',
        '| Gruppe |  | Wert |',
        '| --- | --- | --- |',
        '| Alpha | x | 1 |',
        '| Alpha | y | 2 |'
      ].join('\n')
    );
  });

  it('several paragraphs in a cell are one line; a pipe is escaped; text around the table stays apart', async () => {
    const t = table([[cell(['erste', 'zweite']), cell('a|b')]], '');
    expect(
      await extract({
        slides: [slide([shape([para('davor')]), t, shape([para('danach')])])],
        order: [0]
      })
    ).toBe('[Slide 1]\ndavor\n\n| erste zweite | a\\|b |\n\ndanach');
  });
});

describe('speaker notes (opt-in, decision A3)', () => {
  const notesSlide = body =>
    `${XML}<p:notes ${NS}><p:cSld><p:spTree>${shape([para('')], 'sldImg')}${shape(body, 'body')}${shape([para('7')], 'sldNum')}</p:spTree></p:cSld></p:notes>`;
  const spec = {
    slides: [slide([shape([para('Folie')])]), slide([shape([para('Ohne Notizen')])])],
    order: [0, 1],
    notes: { 0: notesSlide([para('Hier betonen:'), para('Preis')]) }
  };

  it('are not sent by default', async () => {
    expect(await extract(spec)).toBe('[Slide 1]\nFolie\n\n[Slide 2]\nOhne Notizen');
    expect(await extract(spec, { speakerNotes: 'ignore' })).toBe(
      '[Slide 1]\nFolie\n\n[Slide 2]\nOhne Notizen'
    );
  });

  it('follow their slide as [Notes] when the app opts in; only the notes text, not the slide image or number', async () => {
    expect(await extract(spec, { speakerNotes: 'include' })).toBe(
      '[Slide 1]\nFolie\n[Notes]\nHier betonen:\nPreis\n\n[Slide 2]\nOhne Notizen'
    );
  });

  it('a slide with notes but no text of its own is still skipped without the opt-in, shown with it', async () => {
    const onlyNotes = {
      slides: [slide([])],
      order: [0],
      notes: { 0: notesSlide([para('Nur Notizen')]) }
    };
    expect(await extract(onlyNotes)).toBe('');
    expect(await extract(onlyNotes, { speakerNotes: 'include' })).toBe(
      '[Slide 1]\n[Notes]\nNur Notizen'
    );
  });

  it('a notes part that cannot be read costs the notes only', async () => {
    const broken = { ...spec, notes: { 0: '<p:notes' } };
    expect(await extract(broken, { speakerNotes: 'include' })).toBe(
      '[Slide 1]\nFolie\n\n[Slide 2]\nOhne Notizen'
    );
  });
});

describe('the admin switch and the fallback', () => {
  const slides = [slide([shape([para('Titel')], 'title'), shape([para('Text')])])];

  it('T-PPT-04: switch off — the text of before: paragraphs in file order, no heading, no flags', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const hidden = [
      slide([shape([para('Titel')], 'title'), shape([para('Text')])], 'show="0"'),
      slide([shape([para('zwei')])])
    ];
    expect(await extract({ slides: hidden, order: [1, 0] }, { speakerNotes: 'include' })).toBe(
      '[Slide 1]\nTitel\nText\n\n[Slide 2]\nzwei'
    );
    expect(extractPptxText).not.toHaveBeenCalled();
  });

  it('a failing structured step falls back to the text of before, and the upload still works', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    extractPptxText.mockRejectedValueOnce(new Error('unexpected'));
    expect(await extract({ slides, order: [0] })).toBe('[Slide 1]\nTitel\nText');
    expect(warn).toHaveBeenCalledWith(
      '[fileProcessing] structured extraction failed, using legacy',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

describe('limits', () => {
  it('T-PERF-04: a deck of 300 slides with tables assembles quickly', async () => {
    const slides = Array.from({ length: 300 }, (_, n) =>
      slide([
        shape([para(`Folie ${n + 1}`)], 'title'),
        shape(
          Array.from({ length: 10 }, (__, l) => para(`Punkt ${l}`)),
          'body'
        ),
        table(Array.from({ length: 8 }, (__, r) => [cell(`a${r}`), cell(`b${r}`), cell(`c${r}`)]))
      ])
    );
    const started = Date.now();
    const text = await extract({ slides, order: slides.map((_, i) => i) });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(text.match(/^\[Slide \d+\]$/gm)).toHaveLength(300);
    expect(text).toContain('# Folie 300');
  });
});

describe('the speaker notes option reaches every way a deck gets in', () => {
  const notesSlide = text =>
    `${XML}<p:notes ${NS}><p:cSld><p:spTree>${shape([para(text)], 'body')}</p:spTree></p:cSld></p:notes>`;
  const spec = {
    slides: [slide([shape([para('Folie')])])],
    order: [0],
    notes: { 0: notesSlide('Notiz') }
  };
  const WITH_NOTES = '[Slide 1]\nFolie\n[Notes]\nNotiz';
  const WITHOUT = '[Slide 1]\nFolie';
  const fileUpload = { enabled: true, speakerNotes: 'include' };

  it('extractionOptionsOf: off for a missing block and for values that are not options', () => {
    expect(extractionOptionsOf(undefined).speakerNotes).toBe('ignore');
    expect(extractionOptionsOf({ speakerNotes: 'yes' }).speakerNotes).toBe('ignore');
    expect(extractionOptionsOf(fileUpload).speakerNotes).toBe('include');
  });

  it('createUploadConfig carries the option of the app', () => {
    const { result } = renderHook(() => useFileUploadHandler());
    expect(
      result.current.createUploadConfig({ upload: { fileUpload } }, null).fileUpload.speakerNotes
    ).toBe('include');
    expect(
      extractionOptionsOf(
        result.current.createUploadConfig({ upload: { fileUpload: { enabled: true } } }, null)
          .fileUpload
      ).speakerNotes
    ).toBe('ignore');
    // An app that only offers cloud storage hands the option to the cloud picks as well.
    const cloudOnly = result.current.createUploadConfig(
      {
        upload: {
          cloudStorageUpload: { enabled: true },
          fileUpload: { ...fileUpload, enabled: false }
        }
      },
      null
    );
    expect(cloudOnly.localUploadEnabled).toBe(false);
    expect(extractionOptionsOf(cloudOnly.fileUpload).speakerNotes).toBe('include');
  });

  it('the cloud file picker extracts the notes of an app that asks for them, and only then', async () => {
    const file = await buildDeck(spec);
    expect((await processCloudFile(file, { fileUpload })).content).toBe(WITH_NOTES);
    expect((await processCloudFile(file, { fileUpload: { enabled: true } })).content).toBe(WITHOUT);
    expect((await processCloudFile(file, {})).content).toBe(WITHOUT);
  });
});
