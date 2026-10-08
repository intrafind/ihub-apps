/**
 * Headers and footers of Word documents in extracted text (issue #2751, PR 4) —
 * concepts/document-extraction/. mammoth has no reader for them; the extraction adds
 * `[Header] …` / `[Footer] …` lines before the body: visible text only, page-number fields
 * dropped, every distinct line once. Test IDs refer to "2026-10-08 Test Plan.md".
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

const config = require('../../../client/src/api/endpoints/config');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const { buildDocxFile, p, partOverride, relationship } = require('../../utils/officeFixtures');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const WPS = 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HDR_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const FTR_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const hdr = inner => `${XML}<w:hdr ${W} ${R} ${MC} ${WPS}>${inner}</w:hdr>`;
const ftr = inner => `${XML}<w:ftr ${W} ${R} ${MC} ${WPS}>${inner}</w:ftr>`;
const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const field = (instr, result) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  `${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const para = (...runs) => `<w:p>${runs.join('')}</w:p>`;

/** header parts as { 'word/<name>': xml } plus the relationships and content types for them. */
function packageOf(headers = {}, footers = {}) {
  const parts = {};
  let rels = '';
  let contentTypes = '';
  Object.entries(headers).forEach(([id, xml]) => {
    parts[`word/${id}.xml`] = xml;
    rels += relationship(id, 'header', `${id}.xml`);
    contentTypes += partOverride(`/word/${id}.xml`, HDR_TYPE);
  });
  Object.entries(footers).forEach(([id, xml]) => {
    parts[`word/${id}.xml`] = xml;
    rels += relationship(id, 'footer', `${id}.xml`);
    contentTypes += partOverride(`/word/${id}.xml`, FTR_TYPE);
  });
  return { parts, rels, contentTypes };
}

const ref = (kind, id, type = 'default') => `<w:${kind}Reference w:type="${type}" r:id="${id}"/>`;
const sectPr = (...children) => `<w:sectPr>${children.join('')}</w:sectPr>`;

const extract = async (spec, name) =>
  (await processDocumentFile(await buildDocxFile(spec, name))).content;

describe('DOCX headers and footers', () => {
  it('T-DOCX-25: default and first-page header, page-number footer, same header in two sections', async () => {
    const content = await extract({
      ...packageOf(
        {
          rIdH1: hdr(para(run('ACME GmbH'))),
          rIdH2: hdr(para(run('ACME GmbH – Titelseite')))
        },
        {
          rIdF1: ftr(
            para(run('Seite '), field('PAGE', '3'), run(' von '), field('NUMPAGES', '10'))
          ),
          rIdF2: ftr(para(run('Vertraulich'), field('PAGE \\* MERGEFORMAT', '7')))
        }
      ),
      body:
        p('Kapitel 1') +
        // First section ends here; the second section repeats the default header.
        `<w:p><w:pPr>${sectPr(ref('header', 'rIdH1'), ref('header', 'rIdH2', 'first'), ref('footer', 'rIdF1'), '<w:titlePg/>')}</w:pPr></w:p>` +
        p('Kapitel 2') +
        sectPr(ref('header', 'rIdH1'), ref('footer', 'rIdF2'), '<w:type w:val="continuous"/>')
    });
    expect(content).toBe(
      [
        '[Header] ACME GmbH',
        '[Header] ACME GmbH – Titelseite',
        '[Footer] Vertraulich',
        '',
        'Kapitel 1',
        '',
        'Kapitel 2'
      ].join('\n')
    );
    expect(content).not.toMatch(/PAGE|NUMPAGES|\b3\b|\b10\b|\b7\b/);
  });

  it('a footer that only holds a page number adds no block', async () => {
    const withFooter = await extract({
      ...packageOf({}, { rIdF1: ftr(para(field('PAGE', '4'))) }),
      body: p('Nur Text') + sectPr(ref('footer', 'rIdF1'))
    });
    expect(withFooter).toBe('Nur Text');
  });

  it('page-number lines keep their other content and lose the leftover words', async () => {
    const content = await extract({
      ...packageOf(
        {},
        {
          rIdF1: ftr(
            para(run('Vertrag Nr. 4711 – Seite '), field('PAGE', '3')) +
              para(run('Page '), field('PAGE', '1'), run(' of '), field('SECTIONPAGES', '2'))
          )
        }
      ),
      body: p('Text') + sectPr(ref('footer', 'rIdF1'))
    });
    expect(content).toBe('[Footer] Vertrag Nr. 4711 – Seite\n\nText');
  });

  it('a simple page field (w:fldSimple) is dropped like a complex one', async () => {
    const content = await extract({
      ...packageOf(
        {},
        {
          rIdF1: ftr(
            para(
              run('Entwurf'),
              '<w:fldSimple w:instr=" PAGE "><w:r><w:t>5</w:t></w:r></w:fldSimple>'
            )
          )
        }
      ),
      body: p('Text') + sectPr(ref('footer', 'rIdF1'))
    });
    expect(content).toBe('[Footer] Entwurf\n\nText');
  });

  it('other fields keep their result (a document title, a date)', async () => {
    const content = await extract({
      ...packageOf({
        rIdH1: hdr(
          para(field('TITLE', 'Rahmenvertrag'), run(' / Stand '), field('DATE', '08.10.2026'))
        )
      }),
      body: p('Text') + sectPr(ref('header', 'rIdH1'))
    });
    expect(content).toBe('[Header] Rahmenvertrag / Stand 08.10.2026\n\nText');
  });

  it('shows what Word shows: first-page header needs titlePg, even-page header needs the setting', async () => {
    const spec = {
      ...packageOf({
        rIdH1: hdr(para(run('Standard'))),
        rIdH2: hdr(para(run('Erste Seite'))),
        rIdH3: hdr(para(run('Gerade Seite')))
      }),
      body:
        p('Text') +
        sectPr(
          ref('header', 'rIdH1'),
          ref('header', 'rIdH2', 'first'),
          ref('header', 'rIdH3', 'even')
        )
    };
    expect(await extract(spec)).toBe('[Header] Standard\n\nText');

    const withSettings = await buildDocxFile({
      ...spec,
      parts: {
        ...spec.parts,
        'word/settings.xml': `${XML}<w:settings ${W}><w:evenAndOddHeaders/></w:settings>`
      },
      rels: spec.rels + relationship('rIdSet', 'settings', 'settings.xml'),
      contentTypes: spec.contentTypes
    });
    expect((await processDocumentFile(withSettings)).content).toBe(
      '[Header] Standard\n[Header] Gerade Seite\n\nText'
    );
  });

  it('keeps table text (cells joined with |), drops images, hidden text and deletions', async () => {
    const content = await extract({
      ...packageOf({
        rIdH1: hdr(
          '<w:tbl><w:tblPr/><w:tblGrid/><w:tr>' +
            `<w:tc>${para('<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"/></w:drawing></w:r>')}</w:tc>` +
            `<w:tc>${para(run('ACME'))}${para(run('Rechtsabteilung'))}</w:tc>` +
            `<w:tc>${para(run('Vertrag 4711'))}</w:tc>` +
            '</w:tr></w:tbl>' +
            para('<w:r><w:rPr><w:vanish/></w:rPr><w:t>versteckt</w:t></w:r>', run('sichtbar')) +
            para(
              '<w:del w:id="1" w:author="x"><w:r><w:delText>gelöscht</w:delText></w:r></w:del>',
              '<w:ins w:id="2" w:author="x"><w:r><w:t>neu</w:t></w:r></w:ins>'
            )
        )
      }),
      body: p('Text') + sectPr(ref('header', 'rIdH1'))
    });
    expect(content).toBe(
      '[Header] ACME Rechtsabteilung | Vertrag 4711\n[Header] sichtbar\n[Header] neu\n\nText'
    );
  });

  it('reads a letterhead text box once, although Word stores it twice', async () => {
    const box = text =>
      `<w:txbxContent>${para(run(text))}${para(run('10115 Berlin'))}</w:txbxContent>`;
    const content = await extract({
      ...packageOf({
        rIdH1: hdr(
          para(
            run('Briefkopf'),
            '<w:r><mc:AlternateContent>' +
              `<mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx>${box('Absender GmbH')}</wps:txbx></wps:wsp></w:drawing></mc:Choice>` +
              `<mc:Fallback><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox>${box('Absender GmbH')}</v:textbox></v:shape></w:pict></mc:Fallback>` +
              '</mc:AlternateContent></w:r>'
          )
        )
      }),
      body: p('Text') + sectPr(ref('header', 'rIdH1'))
    });
    expect(content).toBe(
      '[Header] Briefkopf\n[Header] Absender GmbH\n[Header] 10115 Berlin\n\nText'
    );
  });

  it('non-breaking hyphens and soft hyphens are normalised like body text', async () => {
    const content = await extract({
      ...packageOf({
        rIdH1: hdr(para(run('Ver­trag'), '<w:r><w:noBreakHyphen/><w:t>A</w:t></w:r>'))
      }),
      body: p('Text') + sectPr(ref('header', 'rIdH1'))
    });
    expect(content).toBe('[Header] Vertrag-A\n\nText');
  });

  it('ignores references it cannot resolve and a header part that is not valid XML', async () => {
    const content = await extract({
      ...packageOf({ rIdH1: '<w:hdr><broken' }, { rIdF1: ftr(para(run('Fußzeile'))) }),
      body:
        p('Text') +
        sectPr(
          ref('header', 'rIdH1'),
          ref('header', 'rIdMissing', 'first'),
          ref('footer', 'rIdF1'),
          '<w:titlePg/>'
        )
    });
    // A broken header costs the headers, never the body.
    expect(content).toBe('Text');
  });

  it('T-DOCX-26: with the admin switch off there are no header or footer lines', async () => {
    config.fetchPlatformConfig.mockResolvedValueOnce({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const file = await buildDocxFile({
      ...packageOf({ rIdH1: hdr(para(run('ACME GmbH'))) }),
      body: p('Text') + sectPr(ref('header', 'rIdH1'))
    });
    expect((await processDocumentFile(file)).content).toBe('Text');
  });

  it('a document without any header or footer is unchanged', async () => {
    expect(await extract({ body: p('Eins') + p('Zwei') })).toBe('Eins\n\nZwei');
  });
});
