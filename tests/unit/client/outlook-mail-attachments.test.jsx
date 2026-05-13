import '@testing-library/jest-dom';

/**
 * Regression coverage for the Outlook attachment handling bug (#1451).
 *
 * The bug: opening the add-in on emails containing PDF / Word / .eml /
 * .msg attachments either threw or silently dropped the attachment because
 * `buildFileDataFromMailAttachments` blindly fed every non-image attachment
 * through `processDocumentFile` and swallowed errors.
 *
 * These tests pin down the new contract:
 *   - PDFs and Word docs are routed through the document pipeline.
 *   - .eml / attachmentType === 'item' attachments are surfaced as
 *     "unsupported" instead of being fed to a binary decoder.
 *   - Errors carry the attachment name / content type for logging.
 *   - Image attachments keep flowing through buildImageDataFromMailAttachments.
 */

jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  // Default mock just returns text content. Specific tests override per-call.
  processDocumentFile: jest.fn(async file => ({
    content: `extracted:${file.name}`,
    pageImages: undefined
  }))
}));

const {
  classifyMailAttachment,
  buildAttachmentStatuses,
  buildFileDataFromMailAttachments,
  buildImageDataFromMailAttachments,
  isImageAttachment
} = require('../../../client/src/features/office/utilities/buildChatApiMessages');

const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');

function pdfAttachment(overrides = {}) {
  return {
    id: 'att-pdf',
    name: 'report.pdf',
    contentType: 'application/pdf',
    size: 12345,
    attachmentType: 'file',
    content: { format: 'base64', content: btoa('%PDF-1.4 fake') },
    ...overrides
  };
}

function docxAttachment(overrides = {}) {
  return {
    id: 'att-docx',
    name: 'spec.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 6789,
    attachmentType: 'file',
    content: { format: 'base64', content: btoa('PK fake docx') },
    ...overrides
  };
}

function emlAttachment(overrides = {}) {
  // What Office.js actually returns for an attached email — format: 'eml',
  // attachmentType: 'item'. The old code piped this through base64ToFile +
  // processDocumentFile, which is exactly the documented root cause.
  return {
    id: 'att-eml',
    name: 'forwarded.eml',
    contentType: 'message/rfc822',
    size: 4096,
    attachmentType: 'item',
    content: { format: 'eml', content: 'From: someone@example.com\r\nSubject: hi\r\n\r\nhello' },
    ...overrides
  };
}

function pngAttachment(overrides = {}) {
  return {
    id: 'att-png',
    name: 'screenshot.png',
    contentType: 'image/png',
    size: 2048,
    attachmentType: 'file',
    content: { format: 'base64', content: btoa('fakePngBytes') },
    ...overrides
  };
}

describe('classifyMailAttachment', () => {
  test('routes PDFs to the document pipeline', () => {
    expect(classifyMailAttachment(pdfAttachment())).toEqual({ kind: 'document' });
  });

  test('routes DOCX to the document pipeline', () => {
    expect(classifyMailAttachment(docxAttachment())).toEqual({ kind: 'document' });
  });

  test('routes images out of the document pipeline', () => {
    expect(classifyMailAttachment(pngAttachment())).toEqual({ kind: 'image' });
  });

  test('flags .eml / attachmentType=item as unsupported instead of feeding to processDocumentFile', () => {
    const result = classifyMailAttachment(emlAttachment());
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('eml');
    expect(result.message).toMatch(/email/i);
  });

  test('passes through fetch errors from the host as kind=error', () => {
    const result = classifyMailAttachment({
      id: 'x',
      name: 'broken.pdf',
      contentType: 'application/pdf',
      error: 'boom'
    });
    expect(result).toEqual({ kind: 'error', message: 'boom' });
  });

  test('flags unknown MIME types as unsupported with a descriptive message', () => {
    const result = classifyMailAttachment({
      id: 'x',
      name: 'archive.zip',
      contentType: 'application/zip',
      content: { format: 'base64', content: 'AA==' }
    });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('unsupported-type');
    expect(result.message).toMatch(/application\/zip|zip/i);
  });

  test('respects the skipped flag set by the host context fetcher', () => {
    const result = classifyMailAttachment({
      id: 'x',
      name: 'note.eml',
      contentType: 'message/rfc822',
      skipped: true,
      skipReason: 'eml',
      skipMessage: 'Email items are not yet supported as attachments.'
    });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('eml');
    expect(result.message).toMatch(/email/i);
  });
});

describe('isImageAttachment', () => {
  test('matches image MIME types', () => {
    expect(isImageAttachment({ contentType: 'image/png', name: 'x.png' })).toBe(true);
    expect(isImageAttachment({ contentType: 'image/jpeg', name: 'x.jpg' })).toBe(true);
  });

  test('matches image extensions when content type is missing', () => {
    expect(isImageAttachment({ name: 'x.webp' })).toBe(true);
  });

  test('rejects documents', () => {
    expect(isImageAttachment(pdfAttachment())).toBe(false);
    expect(isImageAttachment(docxAttachment())).toBe(false);
  });
});

describe('buildImageDataFromMailAttachments', () => {
  test('extracts images and leaves documents alone', () => {
    const result = buildImageDataFromMailAttachments([
      pdfAttachment(),
      pngAttachment(),
      emlAttachment()
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fileName: 'screenshot.png',
      fileType: 'image/png',
      source: 'local'
    });
  });

  test('returns null when no images are present', () => {
    expect(buildImageDataFromMailAttachments([pdfAttachment(), emlAttachment()])).toBeNull();
  });
});

describe('buildFileDataFromMailAttachments', () => {
  beforeEach(() => {
    processDocumentFile.mockClear();
  });

  test('processes PDF + DOCX, skips .eml entirely (no processDocumentFile call)', async () => {
    const result = await buildFileDataFromMailAttachments([
      pdfAttachment(),
      docxAttachment(),
      emlAttachment(),
      pngAttachment() // images go through the other pipeline
    ]);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result.map(r => r.fileName).sort()).toEqual(['report.pdf', 'spec.docx']);

    // The bug was that .eml flowed through processDocumentFile. Pin it down:
    // only PDF + DOCX should reach processDocumentFile.
    expect(processDocumentFile).toHaveBeenCalledTimes(2);
    const seenNames = processDocumentFile.mock.calls.map(c => c[0].name).sort();
    expect(seenNames).toEqual(['report.pdf', 'spec.docx']);
  });

  test('does not throw when processDocumentFile rejects — surfaces structured error log instead', async () => {
    processDocumentFile.mockImplementationOnce(async () => {
      throw new Error('encrypted pdf');
    });

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    let result;
    await expect(
      (async () => {
        result = await buildFileDataFromMailAttachments([pdfAttachment(), docxAttachment()]);
      })()
    ).resolves.toBeUndefined();

    // The DOCX still makes it through; the PDF doesn't get into the payload.
    expect(result.map(r => r.fileName)).toEqual(['spec.docx']);

    // Structured log carries name + contentType + underlying message.
    const calls = consoleError.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('[outlook]')
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({
      fileName: 'report.pdf',
      contentType: 'application/pdf',
      error: expect.stringContaining('encrypted')
    });

    consoleError.mockRestore();
  });

  test('returns null when there are no document-class attachments', async () => {
    const result = await buildFileDataFromMailAttachments([emlAttachment(), pngAttachment()]);
    expect(result).toBeNull();
    expect(processDocumentFile).not.toHaveBeenCalled();
  });
});

describe('buildAttachmentStatuses', () => {
  test('reports a status for every attachment regardless of kind', () => {
    const statuses = buildAttachmentStatuses([
      pdfAttachment(),
      docxAttachment(),
      emlAttachment(),
      pngAttachment(),
      {
        id: 'x',
        name: 'broken.pdf',
        contentType: 'application/pdf',
        error: 'host failed to read attachment'
      }
    ]);

    expect(statuses).toHaveLength(5);
    expect(statuses.map(s => ({ name: s.name, status: s.status }))).toEqual([
      { name: 'report.pdf', status: 'attached' },
      { name: 'spec.docx', status: 'attached' },
      { name: 'forwarded.eml', status: 'unsupported' },
      { name: 'screenshot.png', status: 'attached' },
      { name: 'broken.pdf', status: 'failed' }
    ]);

    const eml = statuses.find(s => s.name === 'forwarded.eml');
    expect(eml.reason).toBe('eml');
    expect(eml.message).toMatch(/email/i);

    const failed = statuses.find(s => s.name === 'broken.pdf');
    expect(failed.message).toMatch(/host failed/);
  });

  test('returns an empty array for empty input', () => {
    expect(buildAttachmentStatuses([])).toEqual([]);
    expect(buildAttachmentStatuses(undefined)).toEqual([]);
  });
});

describe('regression: PDF + Word + .eml together', () => {
  // Mirrors the exact scenario from the bug report: an email with all three
  // attachment kinds. The add-in must not throw, must process PDF + DOCX, and
  // must produce a clear status entry for the .eml.
  test('builds a clean payload + per-attachment statuses for PDF/Word/eml/oversized', async () => {
    const oversized = {
      id: 'att-big',
      name: 'huge.bin',
      contentType: 'application/octet-stream',
      size: 50 * 1024 * 1024,
      attachmentType: 'file',
      content: { format: 'base64', content: 'AAAA' }
    };

    const attachments = [pdfAttachment(), docxAttachment(), emlAttachment(), oversized];

    // Should not throw.
    const fileData = await buildFileDataFromMailAttachments(attachments);
    expect(fileData.map(f => f.fileName).sort()).toEqual(['report.pdf', 'spec.docx']);

    const statuses = buildAttachmentStatuses(attachments);
    const byName = Object.fromEntries(statuses.map(s => [s.name, s]));
    expect(byName['report.pdf'].status).toBe('attached');
    expect(byName['spec.docx'].status).toBe('attached');
    expect(byName['forwarded.eml'].status).toBe('unsupported');
    expect(byName['huge.bin'].status).toBe('unsupported');
  });
});
