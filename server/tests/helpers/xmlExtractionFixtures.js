// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Generated PowerPoint and OpenDocument packages that exercise the XML parsing of the extraction
 * (namespaces, entities, whitespace, element order), plus malformed and hostile XML parts. No
 * binaries are committed. The expected text of each fixture is in `fixtures/xml-expected/`.
 */
import JSZip from 'jszip';
import { buildPptx, notesSlide, shape, slide } from './pptxFile.js';
import { buildOdf, p } from './odfFile.js';
import { buildDocx } from './docxFile.js';

const para = (...runs) => `<a:p>${runs.join('')}</a:p>`;
const run = t => `<a:r><a:t>${t}</a:t></a:r>`;
const cell = (t, attrs = '') =>
  `<a:tc ${attrs}><a:txBody><a:bodyPr/>${para(run(t))}</a:txBody></a:tc>`;
const frame = (rows, firstRow = true) =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="T"/></p:nvGraphicFramePr><a:graphic><a:graphicData>' +
  `<a:tbl><a:tblPr${firstRow ? ' firstRow="1"' : ''}/>${rows.map(r => `<a:tr>${r.join('')}</a:tr>`).join('')}</a:tbl>` +
  '</a:graphicData></a:graphic></p:graphicFrame>';

/** @returns {Promise<Object<string, Buffer>>} fixture name → file bytes (name carries the extension) */
export async function buildXmlFixtures() {
  const f = {};

  // ---- pptx ----
  f['pptx-basic.pptx'] = await buildPptx(
    [
      slide([
        shape(['Quarterly review'], 'title'),
        shape([
          'First point',
          'Second point with &lt;angle&gt; &amp; "quotes"',
          'Umlaute äöüß 日本語 😀'
        ])
      ]),
      slide([shape(['Second slide'], 'ctrTitle'), shape(['Body text'])], 'show="0"'),
      slide([])
    ],
    [0, 1, 2]
  );
  f['pptx-order-notes.pptx'] = await buildPptx(
    [
      slide([shape(['Slide A'], 'title'), shape(['a body'])]),
      slide([shape(['Slide B'], 'title'), shape(['b body'])]),
      slide([shape(['Slide C'], 'title')])
    ],
    [2, 0, 1],
    { 0: notesSlide(['Note for A', 'second note line']), 1: notesSlide(['Note for B']) }
  );
  f['pptx-table-group.pptx'] = await buildPptx(
    [
      slide([
        shape(['Table slide'], 'title'),
        frame([
          [cell('Head A'), cell('Head B | pipe'), cell('Head C')],
          [cell('a1', 'vMerge="1"'), cell('b1'), cell('c1')],
          [cell('Merged', 'gridSpan="2"'), cell('', 'hMerge="1"'), cell('c2')]
        ]),
        frame([[cell('No header row')], [cell('second')]], false),
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"/></p:nvGrpSpPr>${shape(['Grouped text'])}</p:grpSp>`,
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
          `<mc:Choice Requires="x">${shape(['Choice text'])}</mc:Choice><mc:Fallback>${shape(['Fallback text'])}</mc:Fallback></mc:AlternateContent>`
      ])
    ],
    [0]
  );
  const textBody = inner =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:bodyPr/>${inner}</p:txBody></p:sp>`;
  f['pptx-runs-fields-entities.pptx'] = await buildPptx(
    [
      slide([
        textBody(
          para(run('Split '), run('word'), '<a:br/>', run('after break')) +
            para(
              '<a:fld id="{1}" type="slidenum"><a:t>7</a:t></a:fld>',
              '<a:fld id="{2}" type="other"><a:t>field text</a:t></a:fld>',
              run('  many   spaces\tand\ttabs ')
            ) +
            para(
              run('&#65;&#x42;&#169; &amp;amp; &lt;b&gt; <![CDATA[<raw> & stuff]]>'),
              run('CRLF\r\nline\rbreak')
            ) +
            para(run('')) +
            para('<a:r><a:t xml:space="preserve">  leading and trailing  </a:t></a:r>')
        ),
        shape(['Footer', 'ignored'], 'sldNum'),
        shape(['Date'], 'dt')
      ])
    ],
    [0]
  );
  // Strict OOXML namespaces and a part with a BOM.
  const strictNs =
    'xmlns:a="http://purl.oclc.org/ooxml/drawingml/main" xmlns:p="http://purl.oclc.org/ooxml/presentationml/main" ' +
    'xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"';
  const strictSlide =
    `<?xml version="1.0"?><p:sld ${strictNs}><p:cSld><p:spTree>${shape(['Strict title'], 'title')}${shape(['Strict body'])}</p:spTree></p:cSld></p:sld>`.replaceAll(
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
      ''
    );
  f['pptx-strict-bom.pptx'] = await buildPptx(['﻿' + strictSlide], [0]);
  const manySlides = [];
  for (let i = 1; i <= 40; i++) {
    manySlides.push(
      slide([shape([`Slide ${i} title`], 'title'), shape([`Point ${i}.1`, `Point ${i}.2`])])
    );
  }
  f['pptx-many.pptx'] = await buildPptx(
    manySlides,
    manySlides.map((_, i) => i)
  );

  // ---- odf ----
  const cellS = t => `<table:table-cell office:value-type="string">${p(t)}</table:table-cell>`;
  const cellF = (v, extra = '') =>
    `<table:table-cell office:value-type="float" office:value="${v}" ${extra}>${p(v)}</table:table-cell>`;
  f['odt-rich.odt'] = await buildOdf(
    'text',
    '<text:h text:outline-level="1">Vertrag &amp; Bedingungen</text:h>' +
      p(
        'Plain, <text:span text:style-name="B">bold span</text:span> and <text:a xlink:href="https://example.com/a?x=1&amp;y=2">a link</text:a>.'
      ) +
      p('Spaces<text:s text:c="3"/>here, tab<text:tab/>stop, break<text:line-break/>next line.') +
      p('Entities &lt;x&gt; &#65; &#x263A; äöüß 日本語 😀 <![CDATA[cdata <x>]]>') +
      '<text:h text:outline-level="2">Listen</text:h>' +
      '<text:list><text:list-item>' +
      p('one') +
      '</text:list-item><text:list-item>' +
      p('two') +
      '<text:list><text:list-item>' +
      p('two.a') +
      '</text:list-item></text:list></text:list-item></text:list>' +
      '<table:table><table:table-header-rows><table:table-row>' +
      cellS('H1') +
      cellS('H2') +
      '</table:table-row></table:table-header-rows><table:table-row>' +
      cellS('a | pipe') +
      cellS('b') +
      '</table:table-row></table:table>' +
      p(
        'Note<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body>' +
          p('The footnote.') +
          '</text:note-body></text:note> end.'
      ) +
      '<office:annotation><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Me</dc:creator>' +
      p('An annotation') +
      '</office:annotation>' +
      p('<text:hidden-text text:is-hidden="true">hidden</text:hidden-text>visible') +
      p('Line<text:s/>\r\nCRLF in source\r\nend'),
    '<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>'
  );
  f['odt-empty.odt'] = await buildOdf('text', '');
  f['ods-sheet.ods'] = await buildOdf(
    'spreadsheet',
    '<table:table table:name="Sheet &amp; One"><table:table-row>' +
      cellS('Name') +
      cellS('Qty') +
      cellS('Note') +
      '</table:table-row><table:table-row>' +
      cellS('Apples') +
      cellF(3) +
      cellS('5 &lt; 6') +
      '</table:table-row><table:table-row table:number-rows-repeated="2">' +
      cellS('rep') +
      cellF(1.5) +
      '<table:table-cell table:number-columns-repeated="3"/></table:table-row></table:table>' +
      '<table:table table:name="Second"><table:table-row>' +
      cellS('x') +
      '</table:table-row></table:table>'
  );
  f['odp-slides.odp'] = await buildOdf(
    'presentation',
    '<draw:page draw:name="One"><draw:frame presentation:class="title"><draw:text-box>' +
      p('Titelfolie') +
      '</draw:text-box></draw:frame>' +
      '<draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item>' +
      p('Punkt &amp; eins') +
      '</text:list-item><text:list-item>' +
      p('Punkt zwei') +
      '</text:list-item></text:list></draw:text-box></draw:frame>' +
      '<presentation:notes><draw:frame presentation:class="notes"><draw:text-box>' +
      p('Speaker note') +
      '</draw:text-box></draw:frame></presentation:notes></draw:page>' +
      '<draw:page draw:name="Two"><draw:frame><draw:text-box>' +
      p('Zweite Folie') +
      '</draw:text-box></draw:frame></draw:page>'
  );

  // ---- hostile / malformed XML parts ----
  const hostilePptx = body => buildPptx([body], [0]);
  const sldNs =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const sld = (doctype, text) =>
    `<?xml version="1.0"?>${doctype}<p:sld ${sldNs}><p:cSld><p:spTree>${textBody(para(run(text)))}</p:spTree></p:cSld></p:sld>`;
  f['bad-pptx-extdtd.pptx'] = await hostilePptx(
    sld('<!DOCTYPE p:sld SYSTEM "http://127.0.0.1:9/evil.dtd">', 'dtd ref only')
  );
  f['bad-pptx-extentity.pptx'] = await hostilePptx(
    sld('<!DOCTYPE p:sld [<!ENTITY x SYSTEM "file:///etc/passwd">]>', '&x;')
  );
  f['bad-pptx-internalentity.pptx'] = await hostilePptx(
    sld('<!DOCTYPE p:sld [<!ENTITY x "boom">]>', '&x;')
  );
  const laughs =
    '<!DOCTYPE p:sld [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]>';
  f['bad-pptx-laughs.pptx'] = await hostilePptx(sld(laughs, '&d;&d;&d;&d;'));
  f['bad-pptx-undefined-entity.pptx'] = await hostilePptx(sld('', 'a&nbsp;b'));
  f['bad-pptx-mismatched.pptx'] = await hostilePptx(
    sld('', 'x').replace('</p:spTree>', '</p:cSld></p:spTree>')
  );
  f['bad-pptx-trailing.pptx'] = await hostilePptx(sld('', 'x') + 'garbage');
  f['bad-pptx-control-char.pptx'] = await hostilePptx(sld('', 'bad\u0001char'));
  f['bad-pptx-empty-slide.pptx'] = await hostilePptx('');
  f['bad-pptx-unbound-prefix.pptx'] = await hostilePptx(
    sld('', 'x').replace('<p:cSld>', '<q:cSld>')
  );
  const depth = 3000;
  f['bad-pptx-deep.pptx'] = await hostilePptx(
    `<?xml version="1.0"?><p:sld ${sldNs}><p:cSld><p:spTree>${'<p:grpSp>'.repeat(depth)}${textBody(para(run('deep')))}${'</p:grpSp>'.repeat(depth)}</p:spTree></p:cSld></p:sld>`
  );
  f['bad-pptx-wide.pptx'] = await hostilePptx(
    sld('', 'x').replace('</p:spTree>', `${textBody(para(run('w'))).repeat(20000)}</p:spTree>`)
  );
  const odfBase = await buildOdf('text', p('valid'));
  const brokenOdf = async content => {
    const zip = await JSZip.loadAsync(odfBase);
    zip.file('content.xml', content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  f['bad-odt-malformed.odt'] = await brokenOdf(
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body>'
  );
  f['bad-odt-extentity.odt'] = await brokenOdf(
    '<?xml version="1.0"?><!DOCTYPE office:document-content [<!ENTITY x SYSTEM "file:///etc/passwd">]><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>&x;</text:p></office:text></office:body></office:document-content>'
  );
  f['bad-odt-deep.odt'] = await brokenOdf(
    `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${'<text:section>'.repeat(5000)}<text:p>deep</text:p>${'</text:section>'.repeat(5000)}</office:text></office:body></office:document-content>`
  );

  // ---- docx (XML parts parsed and re-serialised) ----
  f['docx-entities-bom.docx'] = await buildDocx({
    body:
      '<w:p><w:r><w:t>Entities &lt;x&gt; &amp; &#65; &#x263A;</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">  spaces  </w:t><w:tab/><w:t>after tab</w:t><w:br/><w:t>after break</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>CRLF\r\nin text</w:t></w:r></w:p>'
  });
  f['bad-docx-extentity.docx'] = await buildDocx({
    body: '<w:p><w:r><w:t>&amp;</w:t></w:r></w:p>',
    parts: {}
  }).then(async bytes => {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml').async('string');
    zip.file(
      'word/document.xml',
      xml
        .replace('?>', '?><!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]>')
        .replace('&amp;', '&x;')
    );
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  });
  return f;
}
