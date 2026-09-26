import { describe, it, expect } from '@jest/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  processAttachment,
  resolveMimeType,
  isSupportedMimeType,
  decodeDataUrl,
  extractPdfText,
  AttachmentError
} from '../services/api/attachmentProcessing.js';
import { ApiAttachmentStore, isAttachmentId } from '../services/api/attachmentStore.js';

/**
 * App API attachments: how uploads become the chat's `fileData` / `imageData`,
 * and the store that keeps them until a message references them.
 */

async function textPdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = doc.addPage([400, 200]);
    page.drawText(line, { x: 20, y: 100, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

describe('media types', () => {
  it('trusts a specific declared type, falls back to the extension for generic ones', () => {
    expect(resolveMimeType('application/pdf', 'x.bin')).toBe('application/pdf');
    expect(resolveMimeType('application/octet-stream', 'report.PDF')).toBe('application/pdf');
    expect(resolveMimeType(undefined, 'notes.md')).toBe('text/markdown');
    expect(resolveMimeType('text/plain; charset=utf-8', 'a.txt')).toBe('text/plain');
    expect(resolveMimeType('', 'archive.zip')).toBe('application/octet-stream');
  });

  it('supports PDFs, text formats and web images only', () => {
    expect(isSupportedMimeType('application/pdf')).toBe(true);
    expect(isSupportedMimeType('text/csv')).toBe(true);
    expect(isSupportedMimeType('application/json')).toBe(true);
    expect(isSupportedMimeType('application/ld+json')).toBe(true);
    expect(isSupportedMimeType('image/webp')).toBe(true);
    expect(isSupportedMimeType('application/zip')).toBe(false);
    expect(
      isSupportedMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    ).toBe(false);
  });

  it('decodes base64 data URLs and nothing else', () => {
    const decoded = decodeDataUrl('data:image/png;base64,iVBORw0KGgo=');
    expect(decoded.mimeType).toBe('image/png');
    expect(decoded.buffer.toString('base64')).toBe('iVBORw0KGgo=');
    expect(decodeDataUrl('https://example.com/a.png')).toBeNull();
    expect(decodeDataUrl('data:text/plain,hello')).toBeNull();
  });
});

describe('processAttachment', () => {
  it('turns an image into imageData with a data URL', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const out = await processAttachment({ buffer: png, mimeType: 'image/png', fileName: 'p.png' });
    expect(out.kind).toBe('image');
    expect(out.imageData).toEqual({
      type: 'image',
      base64: `data:image/png;base64,${png.toString('base64')}`,
      fileName: 'p.png',
      fileSize: png.length,
      fileType: 'image/png'
    });
  });

  it('turns a text file into a document with its content and bytes', async () => {
    const buffer = Buffer.from('id,name\n1,Ada\n', 'utf8');
    const out = await processAttachment({ buffer, mimeType: 'text/csv', fileName: 'people.csv' });
    expect(out.kind).toBe('document');
    expect(out.fileData).toMatchObject({
      type: 'document',
      source: 'api',
      fileName: 'people.csv',
      fileSize: buffer.length,
      fileType: 'text/csv',
      displayType: 'CSV',
      content: 'id,name\n1,Ada\n'
    });
    expect(out.fileData.base64.startsWith('data:text/csv;base64,')).toBe(true);
  });

  it('extracts the text of a PDF page by page', async () => {
    const pdf = await textPdf(['Quarterly report', 'Revenue grew twelve percent']);
    const { text, pages } = await extractPdfText(pdf);
    expect(pages).toBe(2);
    expect(text).toContain('Quarterly report');
    expect(text).toContain('Revenue grew twelve percent');

    const out = await processAttachment({
      buffer: pdf,
      mimeType: 'application/octet-stream',
      fileName: 'q.pdf'
    });
    expect(out.kind).toBe('document');
    expect(out.fileData.fileType).toBe('application/pdf');
    expect(out.fileData.displayType).toBe('PDF');
    expect(out.fileData.content).toContain('Quarterly report');
  });

  it('refuses a PDF without a text layer, broken PDFs, unsupported and empty files', async () => {
    const blank = await textPdf([]);
    const blankDoc = await PDFDocument.create();
    blankDoc.addPage();
    const blankPdf = Buffer.from(await blankDoc.save());
    await expect(
      processAttachment({ buffer: blankPdf, mimeType: 'application/pdf', fileName: 'scan.pdf' })
    ).rejects.toMatchObject({ code: 'PDF_WITHOUT_TEXT', status: 415 });
    expect(blank.length).toBeGreaterThan(0);
    await expect(
      processAttachment({
        buffer: Buffer.from('not a pdf'),
        mimeType: 'application/pdf',
        fileName: 'x.pdf'
      })
    ).rejects.toMatchObject({ code: 'INVALID_PDF', status: 400 });
    await expect(
      processAttachment({
        buffer: Buffer.from('zip'),
        mimeType: 'application/zip',
        fileName: 'x.zip'
      })
    ).rejects.toBeInstanceOf(AttachmentError);
    await expect(
      processAttachment({ buffer: Buffer.alloc(0), mimeType: 'text/plain', fileName: 'e.txt' })
    ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });
});

describe('ApiAttachmentStore (memory mode)', () => {
  it('stores an upload for its owner and forgets it after its TTL', async () => {
    let now = 1_000_000;
    const store = new ApiAttachmentStore({ documents: null, blobs: null, now: () => now });
    const meta = await store.put({
      ownerId: 'alice',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hi')
    });
    expect(isAttachmentId(meta.id)).toBe(true);
    expect(meta).toMatchObject({
      ownerId: 'alice',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      size: 2
    });
    expect(meta.sha256).toHaveLength(64);

    const mine = await store.get(meta.id, 'alice');
    expect(mine.data.toString()).toBe('hi');
    expect(await store.get(meta.id, 'bob')).toBeNull();
    expect(await store.get('att_nope', 'alice')).toBeNull();

    now += 25 * 60 * 60 * 1000;
    expect(await store.get(meta.id, 'alice')).toBeNull();
    expect(await store.sweep()).toBe(0); // already evicted by the read
  });

  it('a stranger cannot delete, the owner can', async () => {
    const store = new ApiAttachmentStore({ documents: null, blobs: null });
    const meta = await store.put({
      ownerId: 'alice',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hi')
    });
    expect(await store.delete(meta.id, 'bob')).toBe(false);
    expect(await store.get(meta.id, 'alice')).not.toBeNull();
    expect(await store.delete(meta.id, 'alice')).toBe(true);
    expect(await store.get(meta.id, 'alice')).toBeNull();
  });

  it('persists through the document and blob facets when a provider is available', async () => {
    const docs = new Map();
    const blobs = new Map();
    const documents = {
      put: async (ns, key, data, opts) => docs.set(`${ns}/${key}`, { data, ownerId: opts.ownerId }),
      get: async (ns, key) => docs.get(`${ns}/${key}`) || null,
      delete: async (ns, key) => docs.delete(`${ns}/${key}`),
      list: async () => ({
        items: [...docs.entries()].map(([k, v]) => ({ key: k.split('/')[1], data: v.data })),
        nextCursor: null
      })
    };
    const blobStore = {
      put: async (ns, key, data) => blobs.set(`${ns}/${key}`, Buffer.from(data)),
      get: async (ns, key) =>
        blobs.has(`${ns}/${key}`) ? { key, data: blobs.get(`${ns}/${key}`), bytes: 2 } : null,
      delete: async (ns, key) => blobs.delete(`${ns}/${key}`)
    };
    let now = 5_000;
    const store = new ApiAttachmentStore({ documents, blobs: blobStore, now: () => now });
    const meta = await store.put({
      ownerId: 'alice',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hi')
    });
    expect(store.memory.size).toBe(0);
    expect(docs.get(`api-attachments/${meta.id}`).ownerId).toBe('alice');

    // A second store (another worker) reads it back.
    const other = new ApiAttachmentStore({ documents, blobs: blobStore, now: () => now });
    const read = await other.get(meta.id, 'alice');
    expect(read.data.toString()).toBe('hi');
    expect(await other.get(meta.id, 'mallory')).toBeNull();

    now += 25 * 60 * 60 * 1000;
    expect(await other.sweep()).toBe(1);
    expect(docs.size).toBe(0);
    expect(blobs.size).toBe(0);
  });
});
