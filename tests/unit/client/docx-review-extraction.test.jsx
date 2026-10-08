/**
 * Tracked changes and comments of Word documents in extracted text (concepts/document-extraction/,
 * release 2, WP-B). Both are opt-in per app (decision A3): by default the model reads the
 * accepted view without comments, exactly as before. With `trackedChanges: 'markup'` insertions
 * and deletions are written as CriticMarkup (`{++added++}`, `{--removed--}`), with
 * `comments: 'inline'` every comment follows the text it is attached to (`{>>Author: text<<}`).
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue || key)
  })
}));

const { render, fireEvent, waitFor } = require('@testing-library/react');
const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const config = require('../../../client/src/api/endpoints/config');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const {
  extractionOptionsOf
} = require('../../../client/src/features/upload/utils/extractionOptions');
const {
  processCloudFile
} = require('../../../client/src/features/upload/utils/cloudFileProcessing');
const {
  buildFileDataFromMailAttachments
} = require('../../../client/src/features/office/utilities/buildChatApiMessages');
const { useFileUploadHandler } = require('../../../client/src/shared/hooks/useFileUploadHandler');
const { renderHook } = require('@testing-library/react');
const {
  buildDocxFile,
  p,
  partOverride,
  relationship,
  tbl,
  tc,
  HEADING_STYLES,
  HEADING_NUMBERING,
  numPr,
  lvl,
  DOCX_MIME
} = require('../../utils/officeFixtures');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const ATTRS = (id, author = 'Anna Beispiel') =>
  `w:id="${id}" w:author="${author}" w:date="2026-01-01T10:00:00Z"`;

const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const ins = (text, id = 1) => `<w:ins ${ATTRS(id)}>${run(text)}</w:ins>`;
const del = (text, id = 2) =>
  `<w:del ${ATTRS(id)}><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
const para = (...parts) => `<w:p>${parts.join('')}</w:p>`;
const paraWithMark = (mark, ...parts) =>
  `<w:p><w:pPr><w:rPr>${mark}</w:rPr></w:pPr>${parts.join('')}</w:p>`;

const comment = (id, text, author = 'Anna Beispiel') =>
  `<w:comment ${ATTRS(id, author)} w:initials="AB"><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:comment>`;
const commentsPart = (...comments) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>${comments.join('')}</w:comments>`;
const commented = (id, text) =>
  `<w:commentRangeStart w:id="${id}"/>${run(text)}<w:commentRangeEnd w:id="${id}"/>` +
  `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
const withComments = (body, ...comments) => ({
  body,
  parts: { 'word/comments.xml': commentsPart(...comments) },
  rels: relationship('rIdC', 'comments', 'comments.xml'),
  contentTypes: partOverride('/word/comments.xml', COMMENTS_TYPE)
});

// jsdom's File has no arrayBuffer(), and the buffer a FileReader hands out belongs to another
// realm, which JSZip does not recognize: copy it into a buffer of this realm (the add-in turns
// a base64 attachment into such a File).
beforeAll(() => {
  if (typeof File.prototype.arrayBuffer !== 'function') {
    File.prototype.arrayBuffer = function arrayBuffer() {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const copy = new ArrayBuffer(reader.result.byteLength);
          new Uint8Array(copy).set(new Uint8Array(reader.result));
          resolve(copy);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(this);
      });
    };
  }
});

const MARKUP = { trackedChanges: 'markup' };
const INLINE = { comments: 'inline' };
const extract = async (spec, options, name) =>
  (await processDocumentFile(await buildDocxFile(spec, name), options)).content;

describe('tracked changes', () => {
  beforeEach(() => {
    config.fetchPlatformConfig.mockReset();
    config.fetchPlatformConfig.mockResolvedValue({ features: [] });
  });

  it('T-WPB-01: by default the accepted view — insertions in, deletions out, no marks', async () => {
    const spec = {
      body: para(run('Der Vertrag '), del('endet nicht '), ins('endet '), run('am Montag.'))
    };
    expect(await extract(spec)).toBe('Der Vertrag endet am Montag.');
    expect(await extract(spec, {})).toBe('Der Vertrag endet am Montag.');
    expect(await extract(spec, { trackedChanges: 'accepted' })).toBe(
      'Der Vertrag endet am Montag.'
    );
  });

  it('T-WPB-02: markup shows insertions and deletions as CriticMarkup', async () => {
    const spec = {
      body: para(run('Der Vertrag '), del('endet nicht '), ins('endet '), run('am Montag.'))
    };
    expect(await extract(spec, MARKUP)).toBe(
      'Der Vertrag {--endet nicht --}{++endet ++}am Montag.'
    );
  });

  it('a pure insertion and a pure deletion', async () => {
    expect(await extract({ body: para(run('Alt '), ins('neu')) }, MARKUP)).toBe('Alt {++neu++}');
    expect(await extract({ body: para(run('Alt '), del('weg')) }, MARKUP)).toBe('Alt {--weg--}');
  });

  it('a paragraph whose mark is deleted stays a paragraph of its own (the accepted view merges it)', async () => {
    const body =
      paraWithMark(`<w:del ${ATTRS(3)}/>`, del('Gestrichener Absatz.')) + p('Der naechste Absatz.');
    expect(await extract({ body }, MARKUP)).toBe(
      '{--Gestrichener Absatz.--}\n\nDer naechste Absatz.'
    );
    expect(await extract({ body })).toBe('Der naechste Absatz.');
  });

  it('an inserted paragraph', async () => {
    const body = p('Erster.') + paraWithMark(`<w:ins ${ATTRS(3)}/>`, ins('Neuer Absatz.'));
    expect(await extract({ body }, MARKUP)).toBe('Erster.\n\n{++Neuer Absatz.++}');
    expect(await extract({ body })).toBe('Erster.\n\nNeuer Absatz.');
  });

  it('T-WPB-03: a deleted numbered heading takes no number and the numbers after it do not move', async () => {
    const styles = HEADING_STYLES;
    const numbering = HEADING_NUMBERING;
    const heading = (inner, mark = '') =>
      `<w:p><w:pPr><w:pStyle w:val="berschrift1"/>${mark ? `<w:rPr>${mark}</w:rPr>` : ''}</w:pPr>${inner}</w:p>`;
    const body =
      heading(run('Geltungsbereich')) +
      heading(del('Gestrichenes Kapitel'), `<w:del ${ATTRS(3)}/>`) +
      heading(run('Laufzeit'));
    const markup = await extract({ body, styles, numbering }, MARKUP);
    const accepted = await extract({ body, styles, numbering });
    expect(accepted).toBe('# 1. Geltungsbereich\n\n# 2. Laufzeit');
    expect(markup).toBe('# 1. Geltungsbereich\n\n# {--Gestrichenes Kapitel--}\n\n# 2. Laufzeit');
  });

  it('a deleted numbered list item does not become a list item or take a number', async () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
      `${lvl(0, 'decimal', '%1.')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const item = (inner, mark = '') =>
      `<w:p><w:pPr>${numPr(1)}${mark ? `<w:rPr>${mark}</w:rPr>` : ''}</w:pPr>${inner}</w:p>`;
    const body = item(run('eins')) + item(del('zwei'), `<w:del ${ATTRS(3)}/>`) + item(run('drei'));
    expect(await extract({ body, numbering }, MARKUP)).toBe('1. eins\n\n{--zwei--}\n\n2. drei');
  });

  it('a deleted table row stays in the table, its cells marked as deleted', async () => {
    const cell = inner => tc(`<w:p>${inner}</w:p>`);
    const row = (cells, trPr = '') =>
      `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells.join('')}</w:tr>`;
    const body =
      `<w:tbl><w:tblPr/><w:tblGrid/>` +
      row([cell(run('Name')), cell(run('Frist'))]) +
      row([cell(del('Kuendigung')), cell(del('3 Monate'))], `<w:del ${ATTRS(5)}/>`) +
      row([cell(run('Miete')), cell(ins('1000'))]) +
      `</w:tbl>`;
    expect(await extract({ body }, MARKUP)).toBe(
      [
        '| Name | Frist |',
        '| --- | --- |',
        '| {--Kuendigung--} | {--3 Monate--} |',
        '| Miete | {++1000++} |'
      ].join('\n')
    );
    // The accepted view drops the deleted row, as before.
    expect(await extract({ body })).not.toContain('Kuendigung');
  });

  it('a deleted space is gone, not shown as a space', async () => {
    expect(await extract({ body: para(run('a'), del(' '), run('b')) }, MARKUP)).toBe('ab');
  });

  it('whitespace only changes leave no marks', async () => {
    expect(await extract({ body: para(run('a'), del(' '), ins(' '), run('b')) }, MARKUP)).toBe(
      'a b'
    );
  });

  it('moved text is a deletion where it was and an insertion where it is', async () => {
    const moveFrom = `<w:moveFrom ${ATTRS(7)}>${run('Der Umzug.')}</w:moveFrom>`;
    const moveTo = `<w:moveTo ${ATTRS(8)}>${run('Der Umzug.')}</w:moveTo>`;
    const body = para(run('Erster. '), moveFrom) + p('Zweiter.') + para(moveTo);
    expect(await extract({ body }, MARKUP)).toBe(
      'Erster. {--Der Umzug.--}\n\nZweiter.\n\n{++Der Umzug.++}'
    );
    // Accepted: once, at the new position.
    expect(await extract({ body })).toBe('Erster.\n\nZweiter.\n\nDer Umzug.');
  });

  it('deleted field codes and formatting changes leave no trace', async () => {
    const deletedField =
      `<w:del ${ATTRS(9)}><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      '<w:r><w:delInstrText xml:space="preserve"> PAGE </w:delInstrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:del>';
    const formatted = `<w:r><w:rPr><w:rPrChange ${ATTRS(10)}><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>nicht mehr fett</w:t></w:r>`;
    expect(await extract({ body: para(run('a '), deletedField, formatted) }, MARKUP)).toBe(
      'a nicht mehr fett'
    );
  });

  it('markup characters in the text do not matter, and a change next to a link stays inside it', async () => {
    const rel = relationship('rIdL', 'hyperlink', 'https://example.org/', true);
    const link = `<w:hyperlink r:id="rIdL" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${ins('Link')}</w:hyperlink>`;
    expect(await extract({ body: para(run('Siehe '), link), rels: rel }, MARKUP)).toBe(
      'Siehe [{++Link++}](https://example.org/)'
    );
  });

  it('T-WPB-04: with the admin switch off nothing changes — plain text, no marks', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const spec = withComments(
      para(run('Alt '), ins('neu'), del(' weg'), commented(1, ' Text')),
      comment(1, 'Hinweis')
    );
    const text = await extract(spec, { trackedChanges: 'markup', comments: 'inline' });
    expect(text).not.toContain('{');
  });

  it('unknown option values mean the default', async () => {
    const spec = { body: para(run('a'), del('b'), ins('c')) };
    expect(await extract(spec, { trackedChanges: 'everything', comments: 42 })).toBe('ac');
  });
});

describe('comments', () => {
  it('T-WPB-05: by default comments are not sent', async () => {
    const spec = withComments(
      para(run('Vorher '), commented(1, 'markiert'), run(' nachher')),
      comment(1, 'Bitte pruefen')
    );
    expect(await extract(spec)).toBe('Vorher markiert nachher');
    expect(await extract(spec, { comments: 'ignore' })).toBe('Vorher markiert nachher');
  });

  it('T-WPB-06: inline puts the comment, with its author, right after the text it is attached to', async () => {
    const spec = withComments(
      para(run('Vorher '), commented(1, 'markiert'), run(' nachher')),
      comment(1, 'Bitte pruefen')
    );
    expect(await extract(spec, INLINE)).toBe(
      'Vorher markiert{>>Anna Beispiel: Bitte pruefen<<} nachher'
    );
  });

  it('replies follow in order; a comment without author has no prefix; text of several paragraphs is joined', async () => {
    const twoParagraphs =
      `<w:comment ${ATTRS(2, 'Bernd')}><w:p><w:r><w:t>Erste Zeile.</w:t></w:r></w:p>` +
      '<w:p><w:r><w:t>Zweite Zeile.</w:t></w:r></w:p></w:comment>';
    const anonymous = '<w:comment w:id="3"><w:p><w:r><w:t>Ohne Autor</w:t></w:r></w:p></w:comment>';
    const body = para(
      run('Text '),
      `<w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:commentRangeStart w:id="3"/>${run('hier')}` +
        '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>' +
        '<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r>' +
        '<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>'
    );
    const spec = withComments(body, comment(1, 'Frage?'), twoParagraphs, anonymous);
    expect(await extract(spec, INLINE)).toBe(
      'Text hier{>>Anna Beispiel: Frage?<<}{>>Bernd: Erste Zeile. Zweite Zeile.<<}{>>Ohne Autor<<}'
    );
  });

  it('a comment in a table cell and in a heading', async () => {
    const body =
      `<w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr>${commented(1, 'Kapitel')}</w:p>` +
      tbl([tc(`<w:p>${run('A')}</w:p>`), tc(`<w:p>${commented(2, 'B')}</w:p>`)]);
    const spec = {
      ...withComments(body, comment(1, 'zu kurz'), comment(2, 'falsch')),
      styles: HEADING_STYLES,
      numbering: null
    };
    expect(await extract(spec, INLINE)).toBe(
      '# Kapitel{>>Anna Beispiel: zu kurz<<}\n\n| A | B{>>Anna Beispiel: falsch<<} |\n| --- | --- |'
    );
  });

  it('a comment that cannot break the marker: closing sequence, line breaks and length', async () => {
    const text = `Ende &lt;&lt;} danach\nneue Zeile ${'x'.repeat(3000)}`;
    const spec = withComments(para(commented(1, 'Text')), comment(1, text));
    const out = await extract(spec, INLINE);
    expect(out.startsWith('Text{>>Anna Beispiel: Ende < <} danach neue Zeile x')).toBe(true);
    expect(out.endsWith('…<<}')).toBe(true);
    expect(out.match(/<<\}/g)).toHaveLength(1);
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThan(2200);
  });

  it('references to missing or empty comments leave no trace', async () => {
    const body = para(run('a'), commented(7, 'b'), run('c'), commented(1, 'd'));
    const spec = withComments(body, comment(1, '   '));
    expect(await extract(spec, INLINE)).toBe('abcd');
  });

  it('a package without a comments part is fine', async () => {
    expect(await extract({ body: para(run('a'), commented(1, 'b')) }, INLINE)).toBe('ab');
  });

  it('a comments part without comments, or with comments without an id, is fine', async () => {
    const spec = {
      ...withComments(
        para(run('a'), commented(1, 'b')),
        '<w:comment w:author="X"><w:p/></w:comment>'
      ),
      body: para(run('a'), commented(1, 'b'))
    };
    expect(await extract(spec, INLINE)).toBe('ab');
  });

  it('both options together', async () => {
    const spec = withComments(
      para(run('Der Preis '), del('100'), ins('120'), commented(1, ' Euro')),
      comment(1, 'Mit Kunde abgestimmt')
    );
    expect(await extract(spec, { trackedChanges: 'markup', comments: 'inline' })).toBe(
      'Der Preis {--100--}{++120++} Euro{>>Anna Beispiel: Mit Kunde abgestimmt<<}'
    );
  });
});

describe('per-app options reach every way a document gets in', () => {
  const spec = withComments(
    para(run('Preis '), del('100'), ins('120'), commented(1, ' Euro')),
    comment(1, 'Abgestimmt')
  );
  const OPTED_IN = 'Preis {--100--}{++120++} Euro{>>Anna Beispiel: Abgestimmt<<}';
  const PLAIN = 'Preis 120 Euro';
  const fileUpload = { enabled: true, trackedChanges: 'markup', comments: 'inline' };

  it('extractionOptionsOf: the default for a missing block and for values that are not options', () => {
    expect(extractionOptionsOf(undefined)).toMatchObject({
      trackedChanges: 'accepted',
      comments: 'ignore'
    });
    expect(extractionOptionsOf({ trackedChanges: 'x', comments: 'y' })).toMatchObject({
      trackedChanges: 'accepted',
      comments: 'ignore'
    });
    expect(extractionOptionsOf(fileUpload)).toMatchObject({
      trackedChanges: 'markup',
      comments: 'inline'
    });
  });

  it('createUploadConfig carries the options of the app, and only those of the app', () => {
    const { result } = renderHook(() => useFileUploadHandler());
    const withOptions = result.current.createUploadConfig({ upload: { fileUpload } }, null);
    expect(withOptions.fileUpload).toMatchObject({ trackedChanges: 'markup', comments: 'inline' });
    const without = result.current.createUploadConfig(
      { upload: { fileUpload: { enabled: true } } },
      null
    );
    expect(extractionOptionsOf(without.fileUpload)).toMatchObject({
      trackedChanges: 'accepted',
      comments: 'ignore'
    });
  });

  it('the uploader (chat, start form, workflow) extracts with the options of the app', async () => {
    const upload = async fileUploadConfig => {
      const onFileSelect = jest.fn();
      const { container } = render(
        <UnifiedUploader
          onFileSelect={onFileSelect}
          config={{
            imageUploadEnabled: false,
            audioUploadEnabled: false,
            videoUploadEnabled: false,
            fileUpload: { supportedFormats: [DOCX_MIME], ...fileUploadConfig }
          }}
        >
          <div />
        </UnifiedUploader>
      );
      const input = container.querySelector('input[type="file"]');
      fireEvent.change(input, { target: { files: [await buildDocxFile(spec, 'vertrag.docx')] } });
      await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
      return onFileSelect.mock.calls[0][0].content;
    };
    expect(await upload(fileUpload)).toBe(OPTED_IN);
    expect(await upload({ enabled: true })).toBe(PLAIN);
  });

  it('the cloud file picker (and the Nextcloud embed) extract with the options of the app', async () => {
    const file = await buildDocxFile(spec, 'vertrag.docx');
    expect((await processCloudFile(file, { fileUpload })).content).toBe(OPTED_IN);
    expect((await processCloudFile(file, { fileUpload: { enabled: true } })).content).toBe(PLAIN);
    expect((await processCloudFile(file, {})).content).toBe(PLAIN);
  });

  it('attachments of the Outlook add-in extract with the options of the selected app', async () => {
    const file = await buildDocxFile(spec, 'vertrag.docx');
    const attachment = {
      name: 'vertrag.docx',
      contentType: DOCX_MIME,
      size: 1,
      isInline: false,
      content: {
        format: 'base64',
        content: Buffer.from(await file.arrayBuffer()).toString('base64')
      }
    };
    const [opted] = await buildFileDataFromMailAttachments([attachment], fileUpload);
    expect(opted.content).toBe(OPTED_IN);
    const [plain] = await buildFileDataFromMailAttachments([attachment]);
    expect(plain.content).toBe(PLAIN);
  });
});
