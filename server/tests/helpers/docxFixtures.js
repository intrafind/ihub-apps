// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A set of Word documents that together exercise what mammoth's HTML can contain — headings,
 * lists, tables, links, images, inline formatting, footnotes, review marks — plus a large
 * 40-page-style document. Used by the output-equivalence test and the extraction benchmark.
 * Nothing is committed as a binary: every package is written here.
 */
import { buildDocx, lvl } from './docxFile.js';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const esc = text =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const run = (text, rpr = '') =>
  `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const style = (id, name, extra = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const HEADINGS =
  style('Heading1', 'heading 1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>') +
  style('Heading2', 'heading 2', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>') +
  style('Heading3', 'heading 3', '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>') +
  style('ListParagraph', 'List Paragraph');
const NUMBERING =
  `<w:abstractNum w:abstractNumId="0">${lvl(0, 'bullet', '•')}${lvl(1, 'bullet', 'o')}</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%2)')}</w:abstractNum>` +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
const item = (text, numId, ilvl = 0) =>
  para(run(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
const cell = (text, extra = '') =>
  `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${extra}</w:tcPr>${para(run(text))}</w:tc>`;
const row = cells => `<w:tr>${cells.join('')}</w:tr>`;
const table = rows =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows.join('')}</w:tbl>`;
const image = (rId, id) =>
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
  `<wp:extent cx="95250" cy="95250"/><wp:docPr id="${id}" name="Picture ${id}" descr="Alt text ${id}"/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="p${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco ' +
  'laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit.';

const imageParts = n => ({
  rels: Array.from(
    { length: n },
    (_, i) => `<Relationship Id="rIdImg${i}" Type="${R}/image" Target="media/image${i}.png"/>`
  ).join(''),
  parts: Object.fromEntries(Array.from({ length: n }, (_, i) => [`word/media/image${i}.png`, PNG])),
  contentTypes: '<Default Extension="png" ContentType="image/png"/>'
});

function largeBody(pages = 40) {
  const out = [];
  for (let page = 0; page < pages; page++) {
    out.push(para(run(`Chapter ${page + 1}: Section title`), '<w:pStyle w:val="Heading1"/>'));
    out.push(para(run(`Subsection ${page + 1}.1`), '<w:pStyle w:val="Heading2"/>'));
    for (let i = 0; i < 4; i++) {
      out.push(
        para(
          run(`${LOREM} `) +
            run('Bold part', '<w:b/>') +
            run(' and ') +
            run('italic part', '<w:i/>') +
            run(` ${LOREM} (${page}.${i})`)
        )
      );
    }
    out.push(item(`Point one of page ${page + 1}`, 1));
    out.push(item(`Point two with <special> & "chars"`, 1));
    out.push(item(`Step ${page + 1}`, 2));
    out.push(item(`Sub step`, 2, 1));
    out.push(
      table([
        row([cell('Name'), cell('Value'), cell('Note')]),
        row([cell(`Item ${page}`), cell(`${page * 3}`), cell('a | b')]),
        row([cell('Total'), cell(`${page * 7}`), cell('*star* _under_')])
      ])
    );
    out.push(para(run(LOREM)));
  }
  return out.join('');
}

/** @returns {Promise<Object<string, Buffer>>} fixture name → .docx bytes */
export async function buildWordFixtures() {
  const imgs = imageParts(2);
  const linkRels =
    `<Relationship Id="rIdL1" Type="${R}/hyperlink" Target="https://example.com/a?x=1&amp;y=2" TargetMode="External"/>` +
    `<Relationship Id="rIdL2" Type="${R}/hyperlink" Target="mailto:someone@example.com" TargetMode="External"/>`;
  const base = { styles: HEADINGS, numbering: NUMBERING };
  const fixtures = {
    headings: await buildDocx({
      ...base,
      body:
        para(run('Title level one'), '<w:pStyle w:val="Heading1"/>') +
        para(run(LOREM)) +
        para(run('Level two'), '<w:pStyle w:val="Heading2"/>') +
        para(run(LOREM)) +
        para(run('Level three'), '<w:pStyle w:val="Heading3"/>') +
        para(run('Ümläute, ß, 日本語 and emoji 😀 survive.'))
    }),
    lists: await buildDocx({
      ...base,
      body:
        item('Alpha', 1) +
        item('Beta', 1) +
        item('Nested bullet', 1, 1) +
        item('Gamma', 1) +
        para(run('Between the lists')) +
        item('First', 2) +
        item('Second', 2) +
        item('Nested letter', 2, 1) +
        item('Third', 2)
    }),
    tables: await buildDocx({
      ...base,
      body:
        para(run('Before')) +
        table([
          row([cell('Head A'), cell('Head B')]),
          row([cell('a1'), cell('b1 | pipe')]),
          row([cell('a2'), cell('b2')])
        ]) +
        table([row([cell('Merged', '<w:gridSpan w:val="2"/>')]), row([cell('x'), cell('y')])]) +
        para(run('After'))
    }),
    links: await buildDocx({
      ...base,
      rels: linkRels,
      body:
        para(
          run('See ') +
            `<w:hyperlink r:id="rIdL1">${run('the site', '<w:u w:val="single"/>')}</w:hyperlink>` +
            run(' or mail ') +
            `<w:hyperlink r:id="rIdL2">${run('us')}</w:hyperlink>` +
            run('. Anchor: ') +
            '<w:hyperlink w:anchor="target">' +
            run('jump') +
            '</w:hyperlink>'
        ) +
        para(
          '<w:bookmarkStart w:id="1" w:name="target"/>' +
            run('Target') +
            '<w:bookmarkEnd w:id="1"/>'
        )
    }),
    images: await buildDocx({
      ...base,
      ...imgs,
      body:
        para(run('Before image ') + image('rIdImg0', 1) + run(' after.')) +
        para(image('rIdImg1', 2))
    }),
    inline: await buildDocx({
      ...base,
      body:
        para(
          run('plain ') +
            run('bold', '<w:b/>') +
            run(' ') +
            run('italic', '<w:i/>') +
            run(' ') +
            run('both', '<w:b/><w:i/>') +
            run(' ') +
            run('strike', '<w:strike/>') +
            run(' ') +
            run('sup', '<w:vertAlign w:val="superscript"/>') +
            run(' ') +
            run('sub', '<w:vertAlign w:val="subscript"/>') +
            run(' markdown chars: * _ # [ ] ` \\ < > & ~') +
            '<w:r><w:br/></w:r>' +
            run('after break') +
            '<w:r><w:tab/></w:r>' +
            run('after tab')
        ) +
        para(run('  leading and trailing spaces  ')) +
        para('')
    }),
    review: await buildDocx({
      ...base,
      body: para(
        run('Kept ') +
          '<w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">' +
          run('inserted') +
          '</w:ins>' +
          '<w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>deleted</w:delText></w:r></w:del>'
      )
    }),
    large40: await buildDocx({
      ...base,
      body: largeBody(40)
    })
  };
  return fixtures;
}
