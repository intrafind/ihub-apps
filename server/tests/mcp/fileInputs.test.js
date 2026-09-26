import { describe, it, expect } from '@jest/globals';
import {
  FILE_INPUT_ERROR_CODES,
  describeAttachments,
  fileInputHint,
  findFileInputs,
  normalizeAttachments,
  resolveFileInputs,
  rewriteFileInputSchema,
  toFileData
} from '../../services/mcp/mcpFileInputs.js';

/**
 * File inputs of MCP tools: how `format: "file"` is found, what the model is
 * offered in its place, and how a reference becomes the FileData the server
 * expects.
 */

const LANGDOCK_FILE = {
  type: 'object',
  description: 'File to inspect',
  format: 'file',
  properties: {
    fileName: { type: 'string' },
    mimeType: { type: 'string' },
    base64: { type: 'string' },
    size: { type: 'number' }
  },
  required: ['fileName', 'mimeType', 'base64']
};

const SCHEMA = {
  type: 'object',
  properties: {
    file: LANGDOCK_FILE,
    note: { type: 'string', format: 'file' },
    untyped: { format: 'file', description: 'Any bytes' },
    files: { type: 'array', description: 'Several', items: { type: 'object', format: 'file' } },
    title: { type: 'string', description: 'A title' },
    tags: { type: 'array', items: { type: 'string' } }
  },
  required: ['file', 'title']
};

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

const ATTACHMENTS = [
  {
    type: 'document',
    fileName: 'Report.pdf',
    fileSize: 3,
    fileType: 'application/pdf',
    content: 'text of the report',
    base64: 'data:application/pdf;base64,JVBERg=='
  },
  {
    type: 'image',
    fileName: 'photo.png',
    fileSize: 8,
    fileType: 'image/png',
    base64: PNG_DATA_URL
  },
  {
    type: 'document',
    fileName: 'notes.txt',
    fileSize: 5,
    fileType: 'text/plain',
    content: 'hello'
  },
  {
    type: 'document',
    fileName: 'deck.pptx',
    fileSize: 9,
    fileType: 'application/x-pptx',
    content: 'x'
  }
];

describe('findFileInputs', () => {
  it('finds object, string, typeless and array file properties at the top level', () => {
    expect(findFileInputs(SCHEMA)).toEqual([
      { name: 'file', array: false, required: true },
      { name: 'note', array: false, required: false },
      { name: 'untyped', array: false, required: false },
      { name: 'files', array: true, required: false }
    ]);
  });

  it('ignores nested file inputs and schemas without properties', () => {
    const nested = {
      type: 'object',
      properties: {
        wrapper: { type: 'object', properties: { inner: { type: 'string', format: 'file' } } },
        deep: { type: 'array', items: { type: 'array', items: { format: 'file' } } }
      }
    };
    expect(findFileInputs(nested)).toEqual([]);
    expect(findFileInputs({ type: 'object' })).toEqual([]);
    expect(findFileInputs(undefined)).toEqual([]);
    expect(findFileInputs({ properties: ['not', 'an', 'object'] })).toEqual([]);
  });
});

describe('rewriteFileInputSchema', () => {
  it('offers the model a string per file, an array of strings per file array, and keeps required', () => {
    const rewritten = rewriteFileInputSchema(SCHEMA);
    expect(rewritten.required).toEqual(['file', 'title']);
    expect(rewritten.properties.file).toEqual({
      type: 'string',
      description: expect.stringContaining('File to inspect')
    });
    expect(rewritten.properties.file.description).toMatch(/exact file name of an attachment/);
    expect(rewritten.properties.file.description).toMatch(/`attachment:<n>`/);
    expect(rewritten.properties.note).toEqual({ type: 'string', description: expect.any(String) });
    expect(rewritten.properties.untyped.description).toMatch(/^Any bytes /);
    expect(rewritten.properties.files).toEqual({
      type: 'array',
      description: 'Several',
      items: { type: 'string', description: expect.stringContaining('attachment') }
    });
    // Nothing else moved; no `format` survives on a file property.
    expect(rewritten.properties.title).toEqual(SCHEMA.properties.title);
    expect(rewritten.properties.tags).toEqual(SCHEMA.properties.tags);
    expect(JSON.stringify(rewritten)).not.toContain('"format":"file"');
  });

  it('does not modify the server schema and copes with no schema at all', () => {
    const copy = structuredClone(SCHEMA);
    rewriteFileInputSchema(SCHEMA);
    expect(SCHEMA).toEqual(copy);
    expect(rewriteFileInputSchema(undefined)).toEqual({ type: 'object', properties: {} });
  });

  it('spells out the parameters in the description hint', () => {
    expect(fileInputHint([{ name: 'file' }])).toBe(
      'Attach the file to your message and pass its file name as `file`.'
    );
    expect(fileInputHint([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toContain(
      '`a`, `b` or `c`'
    );
  });
});

describe('toFileData', () => {
  it('strips the data-URL prefix and reports the delivered size', () => {
    expect(toFileData(ATTACHMENTS[1])).toEqual({
      fileName: 'photo.png',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
      size: 8
    });
  });

  it('computes the size from the bytes when the client sent none', () => {
    const { size, base64 } = toFileData({
      fileName: 'a.bin',
      fileType: 'application/x-bin',
      base64: 'AAEC'
    });
    expect(base64).toBe('AAEC');
    expect(size).toBe(3);
  });

  it('delivers a text document without bytes as the base64 of its text', () => {
    expect(toFileData(ATTACHMENTS[2])).toEqual({
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      base64: Buffer.from('hello', 'utf8').toString('base64'),
      size: 5
    });
  });

  it('prefers the bytes over the text and falls back on the media type fields', () => {
    expect(toFileData(ATTACHMENTS[0])).toMatchObject({
      fileName: 'Report.pdf',
      mimeType: 'application/pdf',
      base64: 'JVBERg=='
    });
    expect(
      toFileData({ name: 'x.bin', mimeType: 'application/x-bin', base64: 'AA==' })
    ).toMatchObject({ fileName: 'x.bin', mimeType: 'application/x-bin' });
    expect(toFileData({ fileName: 'x', type: 'image', base64: 'AA==' }).mimeType).toBe(
      'application/octet-stream'
    );
  });

  it('refuses a document whose bytes are not available', () => {
    expect(() => toFileData(ATTACHMENTS[3])).toThrow(
      expect.objectContaining({
        code: FILE_INPUT_ERROR_CODES.UNAVAILABLE,
        message: expect.stringMatching(/deck\.pptx.*Re-attach/)
      })
    );
  });
});

describe('resolveFileInputs', () => {
  const inputs = findFileInputs(SCHEMA);

  it('resolves by file name (case-insensitive), by attachment:<n> and by #<n>', () => {
    const out = resolveFileInputs(
      { file: 'report.pdf', note: 'attachment:2', untyped: '#3', title: 'T' },
      inputs,
      ATTACHMENTS
    );
    expect(out.file).toMatchObject({ fileName: 'Report.pdf', base64: 'JVBERg==' });
    expect(out.note).toMatchObject({ fileName: 'photo.png', base64: 'iVBORw0KGgo=' });
    expect(out.untyped).toMatchObject({ fileName: 'notes.txt', mimeType: 'text/plain' });
    expect(out.title).toBe('T');
  });

  it('maps every element of an array input and accepts a single attachment object', () => {
    const out = resolveFileInputs({ files: ['photo.png', 'attachment:1'] }, inputs, ATTACHMENTS);
    expect(out.files.map(f => f.fileName)).toEqual(['photo.png', 'Report.pdf']);
    const single = resolveFileInputs({ file: 'photo.png' }, inputs, ATTACHMENTS[1]);
    expect(single.file.fileName).toBe('photo.png');
  });

  it('leaves parameters the model did not set alone and returns a new object', () => {
    const args = { title: 'only', note: null };
    const out = resolveFileInputs(args, inputs, ATTACHMENTS);
    expect(out).toEqual({ title: 'only', note: null });
    expect(out).not.toBe(args);
  });

  it('names the available attachments when a reference is unknown', () => {
    expect(() => resolveFileInputs({ file: 'missing.pdf' }, inputs, ATTACHMENTS)).toThrow(
      expect.objectContaining({
        code: FILE_INPUT_ERROR_CODES.NOT_FOUND,
        message: expect.stringMatching(
          /"missing\.pdf" for parameter "file".*attachment:1 — Report\.pdf \(application\/pdf, 3 B\).*attachment:2 — photo\.png/
        )
      })
    );
    expect(() => resolveFileInputs({ file: 'attachment:9' }, inputs, ATTACHMENTS)).toThrow(
      expect.objectContaining({ code: FILE_INPUT_ERROR_CODES.NOT_FOUND })
    );
    expect(() => resolveFileInputs({ file: 'report.pdf' }, inputs, [])).toThrow(
      expect.objectContaining({
        code: FILE_INPUT_ERROR_CODES.NOT_FOUND,
        message: expect.stringContaining('Available attachments: none')
      })
    );
  });

  it('refuses a file over the limit and a document without bytes, tagging the server', () => {
    expect(() =>
      resolveFileInputs({ file: 'photo.png' }, inputs, ATTACHMENTS, {
        maxBytes: 4,
        serverId: 'srv'
      })
    ).toThrow(
      expect.objectContaining({
        code: FILE_INPUT_ERROR_CODES.TOO_LARGE,
        serverId: 'srv',
        message: expect.stringMatching(/photo\.png.*8 B.*up to 4 B/)
      })
    );
    expect(() => resolveFileInputs({ file: 'deck.pptx' }, inputs, ATTACHMENTS)).toThrow(
      expect.objectContaining({ code: FILE_INPUT_ERROR_CODES.UNAVAILABLE })
    );
  });

  it('never quotes file contents in an error', () => {
    let message = '';
    try {
      resolveFileInputs({ file: 'nope' }, inputs, ATTACHMENTS);
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toContain('JVBERg==');
    expect(message).not.toContain('iVBORw0KGgo=');
    expect(message).not.toContain('text of the report');
  });
});

describe('attachment lists', () => {
  it('flattens single objects and arrays from every source and drops junk', () => {
    expect(normalizeAttachments(ATTACHMENTS[0], [ATTACHMENTS[1], null, 'x'], undefined)).toEqual([
      ATTACHMENTS[0],
      ATTACHMENTS[1]
    ]);
  });

  it('describes each attachment with its number, name, type and size', () => {
    expect(describeAttachments(ATTACHMENTS.slice(0, 2))).toEqual([
      'attachment:1 — Report.pdf (application/pdf, 3 B)',
      'attachment:2 — photo.png (image/png, 8 B)'
    ]);
    expect(describeAttachments([{ fileType: 'image/png', base64: PNG_DATA_URL }])).toEqual([
      'attachment:1 — (unnamed) (image/png, 8 B)'
    ]);
  });
});
