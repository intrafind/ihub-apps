/**
 * Document extraction through the inference API (concepts/document-extraction/, release 2, WP-E).
 *
 * The browser extracts documents before it sends; an API caller sends the file itself, so the
 * server extracts it — with the same shared code, so a Word file or PDF reads the same either
 * way: Markdown with headings, numbers and tables, `[Page N]` markers. Word files are accepted
 * here for the first time.
 *
 * Run: node --test server/tests/document-extraction-api.test.js
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import configCache from '../configCache.js';
import { InferenceApiError } from '../services/inference/errors.js';
import {
  documentFromInlineFile,
  messagesFromChatCompletions,
  messagesFromResponsesInput
} from '../services/inference/inputContent.js';
import { buildPdfBytes } from './helpers/structuredPdf.js';
import { DOCX_MIME, NUMBERED_HEADINGS, buildDocx, dataUrl, p } from './helpers/docxFile.js';

const PDF = 'application/pdf';

const setSwitch = enabled =>
  configCache.setCacheEntry(
    'config/features.json',
    enabled === undefined ? {} : { structuredDocumentExtraction: enabled }
  );

const rejects = (promise, { status = 400, code }) =>
  assert.rejects(promise, error => {
    assert.ok(error instanceof InferenceApiError, `InferenceApiError, got ${error}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

afterEach(() => setSwitch(undefined));

describe('Word documents through the API', () => {
  const contract = async () =>
    buildDocx({
      ...NUMBERED_HEADINGS,
      body:
        p('Geltungsbereich', '<w:pStyle w:val="Heading1"/>') +
        p('Dieser Vertrag gilt fuer alle Parteien.') +
        p('Laufzeit', '<w:pStyle w:val="Heading1"/>') +
        '<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc><w:p><w:r><w:t>Feld</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>Wert</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    });

  it('T-API-01: a .docx is accepted and read as Markdown with headings, numbers and tables', async () => {
    const file = await documentFromInlineFile(
      { data: dataUrl(await contract()), filename: 'vertrag.docx' },
      'input[0]'
    );
    assert.equal(file.fileType, DOCX_MIME);
    assert.equal(file.fileName, 'vertrag.docx');
    assert.equal(
      file.content,
      [
        '# 1. Geltungsbereich',
        '',
        'Dieser Vertrag gilt fuer alle Parteien.',
        '',
        '# 2. Laufzeit',
        '',
        '| Feld | Wert |',
        '| --- | --- |'
      ].join('\n')
    );
  });

  it('the type comes from the file name when the request has none', async () => {
    const bytes = await contract();
    for (const data of [
      Buffer.from(bytes).toString('base64'),
      `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`
    ]) {
      const file = await documentFromInlineFile({ data, filename: 'Vertrag.DOCX' }, 'input');
      assert.equal(file.fileType, DOCX_MIME);
      assert.match(file.content, /^# 1\. Geltungsbereich/);
    }
  });

  it('headers and footers come before the text; defaults without review marks', async () => {
    const hdr =
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:r><w:t>Entwurf Nr. 7</w:t></w:r></w:p></w:hdr>';
    const bytes = await buildDocx({
      body:
        p('Text.') +
        '<w:p><w:del w:id="1" w:author="A"><w:r><w:delText>weg</w:delText></w:r></w:del></w:p>' +
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
      parts: { 'word/header1.xml': hdr },
      rels: '<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
      contentTypes:
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
    });
    const file = await documentFromInlineFile({ data: dataUrl(bytes), filename: 'a.docx' }, 'f');
    assert.equal(file.content, '[Header] Entwurf Nr. 7\n\nText.');
  });

  it('a package that is not a Word document is an invalid file, not a server error', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hello');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await rejects(
      documentFromInlineFile({ data: dataUrl(bytes), filename: 'a.docx' }, 'input[0]'),
      { code: 'invalid_file' }
    );
    await rejects(
      documentFromInlineFile(
        { data: dataUrl(Buffer.from('not a zip at all')), filename: 'a.docx' },
        'input'
      ),
      { code: 'invalid_file' }
    );
  });

  it('a Word file without text is reported like a PDF without text', async () => {
    const bytes = await buildDocx({ body: '<w:p/>' });
    await rejects(documentFromInlineFile({ data: dataUrl(bytes), filename: 'leer.docx' }, 'x'), {
      code: 'file_has_no_text'
    });
  });

  it('reaches the chat messages of a Chat Completions request and of a Responses request', async () => {
    const data = dataUrl(await contract());
    const [message] = await messagesFromChatCompletions([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Fasse zusammen' },
          { type: 'file', file: { filename: 'vertrag.docx', file_data: data } }
        ]
      }
    ]);
    assert.equal(message.fileData[0].fileType, DOCX_MIME);
    assert.match(message.fileData[0].content, /# 2\. Laufzeit/);

    const [responsesMessage] = await messagesFromResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Fasse zusammen' },
          { type: 'input_file', filename: 'vertrag.docx', file_data: data }
        ]
      }
    ]);
    assert.equal(responsesMessage.fileData[0].fileType, DOCX_MIME);
    assert.equal(responsesMessage.fileData[0].content, message.fileData[0].content);
  });
});

describe('limits for documents from strangers', () => {
  it('a package that would unpack to far more than it weighs is refused before it is read', async () => {
    // 60 MB of spaces compress to a few dozen kilobytes.
    const bomb = await buildDocx({
      body: `<w:p><w:r><w:t xml:space="preserve">${' '.repeat(60_000_000)}</w:t></w:r></w:p>`
    });
    assert.ok(bomb.length < 1_000_000, `the fixture is small (${bomb.length} bytes)`);
    const started = Date.now();
    await rejects(
      documentFromInlineFile({ data: dataUrl(bomb), filename: 'bomb.docx' }, 'input[0]'),
      {
        code: 'invalid_file'
      }
    );
    assert.ok(Date.now() - started < 5000);
  });

  it('a header that understates the size of a part does not get the part unpacked', async () => {
    const bomb = await buildDocx({
      body: `<w:p><w:r><w:t xml:space="preserve">${' '.repeat(40_000_000)}</w:t></w:r></w:p>`
    });
    // Rewrite the central directory entry of word/document.xml to claim 1,000 bytes.
    const name = Buffer.from('word/document.xml');
    let patched = false;
    for (let at = 0; at + 46 + name.length < bomb.length; at += 1) {
      if (
        bomb.readUInt32LE(at) === 0x02014b50 &&
        bomb.subarray(at + 46, at + 46 + name.length).equals(name)
      ) {
        bomb.writeUInt32LE(1000, at + 24);
        patched = true;
        break;
      }
    }
    assert.ok(patched, 'the entry was found');
    await rejects(documentFromInlineFile({ data: dataUrl(bomb), filename: 'lie.docx' }, 'x'), {
      code: 'invalid_file'
    });
  });

  it('a package whose end record understates its entries is refused, not read as the few it names', async () => {
    // JSZip reads every consecutive central-directory header, whatever the count says.
    const bomb = await buildDocx({
      body: `<w:p><w:r><w:t xml:space="preserve">${' '.repeat(40_000_000)}</w:t></w:r></w:p>`
    });
    const end = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end > 0 && bomb.readUInt16LE(end + 10) > 1, 'the package has several entries');
    for (const claimed of [0, 1]) {
      const lie = Buffer.from(bomb);
      lie.writeUInt16LE(claimed, end + 8);
      lie.writeUInt16LE(claimed, end + 10);
      await rejects(documentFromInlineFile({ data: dataUrl(lie), filename: 'lie.docx' }, 'x'), {
        code: 'invalid_file'
      });
    }
  });

  it('data in front of the zip, which shifts every offset for the unpacking library, is refused', async () => {
    const plain = await buildDocx({ body: p('Text') });
    const prefixed = Buffer.concat([Buffer.alloc(64, 0x41), plain]);
    await rejects(documentFromInlineFile({ data: dataUrl(prefixed), filename: 'a.docx' }, 'x'), {
      code: 'invalid_file'
    });
    // The same package without the prefix is read.
    const file = await documentFromInlineFile({ data: dataUrl(plain), filename: 'a.docx' }, 'x');
    assert.equal(file.content, 'Text');
  });

  it('a truncated or damaged package is refused', async () => {
    const bytes = await buildDocx({ body: p('Text.') });
    for (const damaged of [bytes.subarray(0, bytes.length - 40), bytes.subarray(0, 100)]) {
      await rejects(documentFromInlineFile({ data: dataUrl(damaged), filename: 'a.docx' }, 'x'), {
        code: 'invalid_file'
      });
    }
  });

  it('a package with a huge number of parts is refused', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    for (let i = 0; i < 6000; i += 1) zip.file(`word/media/${i}.txt`, 'x');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await rejects(documentFromInlineFile({ data: dataUrl(bytes), filename: 'many.docx' }, 'x'), {
      code: 'invalid_file'
    });
  });
});

describe('PDF through the API', () => {
  const pages = [
    [
      { text: 'Vertrag', role: 'H1', size: 20 },
      { text: 'Dieser Vertrag gilt fuer alle Parteien.' },
      {
        header: true,
        table: [
          ['Feld', 'Typ'],
          ['a', 'b']
        ]
      }
    ],
    [{ text: 'Zweite Seite' }]
  ];

  it('T-API-02: page markers, lines, headings and tables — the same text as in the browser', async () => {
    const bytes = await buildPdfBytes(pages);
    const file = await documentFromInlineFile(
      { data: dataUrl(bytes, PDF), filename: 'a.pdf' },
      'x'
    );
    assert.equal(
      file.content,
      [
        '[Page 1]',
        '# Vertrag',
        'Dieser Vertrag gilt fuer alle Parteien.',
        '',
        '| Feld | Typ |',
        '| --- | --- |',
        '| a | b |',
        '',
        '[Page 2]',
        'Zweite Seite'
      ].join('\n')
    );
  });

  it('a PDF without a text layer still is "file_has_no_text"', async () => {
    const bytes = await buildPdfBytes([[], []]);
    await rejects(documentFromInlineFile({ data: dataUrl(bytes, PDF), filename: 's.pdf' }, 'x'), {
      code: 'file_has_no_text'
    });
  });

  it('a file that is no PDF is an invalid file', async () => {
    await rejects(
      documentFromInlineFile(
        { data: dataUrl(Buffer.from('%PDF-nonsense'), PDF), filename: 'x.pdf' },
        'x'
      ),
      { code: 'invalid_file' }
    );
  });

  it('only the first pages are read, and reading stops once the text limit is reached', async () => {
    const many = Array.from({ length: 4 }, (_, n) => [{ text: `Seite ${n + 1}` }]);
    const bytes = await buildPdfBytes(many);
    const { extractPdfDocument } = await import('../services/documentExtraction.js');
    const text = await extractPdfDocument(bytes, { maxPages: 2 });
    assert.match(text, /Seite 2/);
    assert.doesNotMatch(text, /Seite 3/);
    const cut = await extractPdfDocument(bytes, { maxChars: 10 });
    assert.match(cut, /Seite 1/);
    assert.doesNotMatch(cut, /Seite 3/);
  });
});

describe('the admin switch', () => {
  it('T-API-03: off restores the previous behaviour — PDF text in one run, Word files not accepted', async () => {
    setSwitch(false);
    const pdf = await buildPdfBytes([
      [{ text: 'Vertrag', role: 'H1', size: 20 }, { text: 'Text.' }]
    ]);
    const file = await documentFromInlineFile({ data: dataUrl(pdf, PDF), filename: 'a.pdf' }, 'x');
    // The words of the page joined by spaces, as before (the empty item of a line end adds one).
    assert.equal(file.content, 'Vertrag  Text.');
    assert.ok(!file.content.includes('[Page'));
    await rejects(
      documentFromInlineFile(
        { data: dataUrl(await buildDocx({ body: p('x') })), filename: 'a.docx' },
        'x'
      ),
      { code: 'unsupported_file_type' }
    );
  });

  it('on (and unset) is the structured extraction', async () => {
    const bytes = await buildPdfBytes([[{ text: 'Text.' }]]);
    for (const state of [undefined, true]) {
      setSwitch(state);
      const file = await documentFromInlineFile(
        { data: dataUrl(bytes, PDF), filename: 'a.pdf' },
        'x'
      );
      assert.equal(file.content, '[Page 1]\nText.');
    }
  });
});

describe('what stays as it was', () => {
  it('other types are still refused, text files still read as text', async () => {
    await rejects(
      documentFromInlineFile(
        { data: 'data:application/zip;base64,UEsDBA==', filename: 'a.zip' },
        'x'
      ),
      { code: 'unsupported_file_type' }
    );
    const file = await documentFromInlineFile(
      {
        data: `data:text/plain;base64,${Buffer.from('Hallo').toString('base64')}`,
        filename: 'a.txt'
      },
      'x'
    );
    assert.equal(file.content, 'Hallo');
  });

  it('the message of an unsupported type names Word files', async () => {
    await assert.rejects(
      documentFromInlineFile(
        { data: 'data:application/zip;base64,UEsDBA==', filename: 'a.zip' },
        'x'
      ),
      error => /Word/.test(error.message)
    );
  });
});
