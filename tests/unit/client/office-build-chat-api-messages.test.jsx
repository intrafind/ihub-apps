/**
 * Unit tests for client/src/features/office/utilities/buildChatApiMessages.js
 *
 * Covers the Outlook attachment normalization that issue #1467 relies on:
 *   - inline-image filtering (HTML-signature logos must not be silently sent)
 *   - MIME-type sanitization (Anthropic rejects "image/jpeg; name=...")
 *   - large-image resizing (phone JPGs exceed Anthropic's 5 MB limit)
 *   - pinned-email attachment collection ("Add this email" must forward
 *     its attachments to the model)
 *   - content-type sanitization for non-image files (PDFs etc.)
 */

import '@testing-library/jest-dom';

// processDocumentFile pulls in pdfjs / mammoth / xlsx etc., none of which
// matter for the attachment-collection / image-filtering logic under test.
// Mock it so the tests don't depend on browser-only bundles.
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  processDocumentFile: jest.fn(async file => ({
    content: `MOCK_TEXT(${file?.name || 'unknown'})`,
    pageImages: undefined
  }))
}));

const {
  isImageAttachment,
  buildImageDataFromMailAttachments,
  buildFileDataFromMailAttachments,
  collectAttachmentsForSend
} = require('../../../client/src/features/office/utilities/buildChatApiMessages');

// JSDom doesn't implement createObjectURL by default — stub it so the
// resize helper can build a Blob URL without exploding.
global.URL.createObjectURL = jest.fn(() => 'blob:mock');
global.URL.revokeObjectURL = jest.fn();

// Stub the Image element so the resize helper's `new Image()` resolves
// deterministically with known dimensions. We exercise three sizes:
// - "small" (within IMAGE_MAX_DIMENSION) → no resize
// - "huge" (above IMAGE_MAX_DIMENSION) → resize path
// - default → returns 0x0 so the helper bails and returns the original.
function installImageStub({ width = 0, height = 0, fail = false } = {}) {
  global.Image = class {
    constructor() {
      this.naturalWidth = width;
      this.naturalHeight = height;
    }
    set src(_value) {
      // Yield to microtasks before firing the callback so the helper's
      // promise wiring runs the way it would in a real browser.
      setTimeout(() => {
        if (fail) this.onerror?.(new Error('test-fail'));
        else this.onload?.();
      }, 0);
    }
  };
}

// HTMLCanvasElement.toDataURL is also missing in jsdom. Return a marker
// data URL so the helper's prefix-strip produces a recognizable base64
// payload we can assert on.
HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
  drawImage: jest.fn()
}));
HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/jpeg;base64,RESIZED_PLACEHOLDER');

const tinyBase64 = 'AAAA'; // 3 bytes, decodes fine via atob.

describe('isImageAttachment', () => {
  test('detects image by content-type with MIME parameters', () => {
    expect(
      isImageAttachment({
        contentType: 'image/jpeg; name="photo.jpg"',
        name: 'photo.jpg'
      })
    ).toBe(true);
  });

  test('detects image by file extension when content-type is generic', () => {
    expect(
      isImageAttachment({
        contentType: 'application/octet-stream',
        name: 'PHOTO.JPG'
      })
    ).toBe(true);
  });

  test('rejects non-image attachments', () => {
    expect(
      isImageAttachment({
        contentType: 'application/pdf',
        name: 'invoice.pdf'
      })
    ).toBe(false);
  });

  test('handles null / undefined safely', () => {
    expect(isImageAttachment(null)).toBe(false);
    expect(isImageAttachment(undefined)).toBe(false);
    expect(isImageAttachment({})).toBe(false);
  });
});

describe('buildImageDataFromMailAttachments', () => {
  beforeEach(() => {
    installImageStub({ width: 100, height: 100 }); // No-resize default.
  });

  test('returns null on empty / null input', async () => {
    expect(await buildImageDataFromMailAttachments(null)).toBeNull();
    expect(await buildImageDataFromMailAttachments([])).toBeNull();
  });

  test('skips inline images so HTML-signature logos do not leak to the model', async () => {
    installImageStub({ width: 100, height: 100 });
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 1000,
        isInline: false,
        content: { format: 'base64', content: tinyBase64 }
      },
      {
        id: 'a2',
        name: 'logo.png',
        contentType: 'image/png',
        size: 2000,
        isInline: true,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fileName).toBe('photo.jpg');
  });

  test('sanitizes content-types with MIME parameters', async () => {
    installImageStub({ width: 100, height: 100 });
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'photo.jpg',
        contentType: 'image/jpeg; name="photo.jpg"',
        size: 1000,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fileType).toBe('image/jpeg'); // parameters stripped
  });

  test('skips attachments whose content failed to load', async () => {
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 1000,
        error: 'Network timeout'
      }
    ]);
    expect(out).toBeNull();
  });

  test('resizes oversized images and re-encodes as JPEG', async () => {
    installImageStub({ width: 3000, height: 1500 });
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'big-photo.jpg',
        contentType: 'image/png',
        size: 5_000_000,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    // Resize path forces output to JPEG regardless of the source format.
    expect(out[0].fileType).toBe('image/jpeg');
    // Marker we stubbed into toDataURL → base64 prefix stripped.
    expect(out[0].base64).toBe('RESIZED_PLACEHOLDER');
  });

  test('preserves original base64 when image fits within the dimension cap', async () => {
    installImageStub({ width: 800, height: 600 });
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'small.jpg',
        contentType: 'image/jpeg',
        size: 50_000,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe(tinyBase64);
  });

  test('skips cloud attachments where content.format is url, not base64', async () => {
    // OneDrive / SharePoint attachments arrive as { format: 'url', content: '<sharelink>' }.
    // The previous code fed the share-link URL into atob() and shipped it to the LLM
    // as a malformed image, which is the actual silent failure path in issue #1467
    // (reproducible on vLLM, not Anthropic-specific as the MIME-param theory suggested).
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 5_000_000,
        content: { format: 'url', content: 'https://onedrive.live.com/.../photo.jpg' }
      }
    ]);
    expect(out).toBeNull();
  });

  test('skips attachments without a usable content blob', async () => {
    const out = await buildImageDataFromMailAttachments([
      {
        id: 'a1',
        name: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 1000,
        content: { format: 'base64', content: '' }
      },
      {
        id: 'a2',
        name: 'photo2.jpg',
        contentType: 'image/jpeg',
        size: 1000
        // no `content` at all
      }
    ]);
    expect(out).toBeNull();
  });
});

describe('buildFileDataFromMailAttachments', () => {
  beforeEach(() => {
    installImageStub({ width: 100, height: 100 });
  });

  test('skips images so they go through the image pipeline instead', async () => {
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 1000,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toBeNull();
  });

  test('skips inline non-image attachments', async () => {
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'inline.pdf',
        contentType: 'application/pdf',
        size: 1000,
        isInline: true,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toBeNull();
  });

  test('sanitizes content-types on file attachments', async () => {
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'invoice.pdf',
        contentType: 'application/pdf; name="invoice.pdf"',
        size: 1000,
        content: { format: 'base64', content: tinyBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fileType).toBe('application/pdf');
    expect(out[0].displayType).toBe('application/pdf');
  });

  test('skips cloud file attachments (format: url)', async () => {
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 100_000,
        content: { format: 'url', content: 'https://onedrive.live.com/.../invoice.pdf' }
      }
    ]);
    expect(out).toBeNull();
  });
});

describe('collectAttachmentsForSend', () => {
  test('returns current attachments when no pinned emails', () => {
    const current = [{ id: 'a1', name: 'photo.jpg' }];
    expect(collectAttachmentsForSend(current, [], 'item1')).toEqual(current);
    expect(collectAttachmentsForSend(current, null, 'item1')).toEqual(current);
    expect(collectAttachmentsForSend(current, undefined, 'item1')).toEqual(current);
  });

  test('merges pinned-email attachments with the current item', () => {
    const merged = collectAttachmentsForSend(
      [{ id: 'curA', name: 'current.jpg' }],
      [
        {
          itemId: 'pinned1',
          attachments: [{ id: 'pinA', name: 'from-pinned.pdf' }]
        }
      ],
      'currentItem'
    );
    expect(merged).toHaveLength(2);
    expect(merged.map(a => a.name).sort()).toEqual(['current.jpg', 'from-pinned.pdf']);
  });

  test('skips pinned attachments whose itemId matches the current item', () => {
    // Avoids sending the same attachment twice when the user pinned the
    // email they are currently viewing.
    const merged = collectAttachmentsForSend(
      [{ id: 'a1', name: 'current.jpg' }],
      [
        {
          itemId: 'same',
          attachments: [{ id: 'a1', name: 'current.jpg' }]
        }
      ],
      'same'
    );
    expect(merged).toEqual([{ id: 'a1', name: 'current.jpg' }]);
  });

  test('tolerates missing attachments array on pinned entries', () => {
    const merged = collectAttachmentsForSend(
      [{ id: 'a1' }],
      [{ itemId: 'p1', attachments: null }, { itemId: 'p2' }],
      'cur'
    );
    expect(merged).toEqual([{ id: 'a1' }]);
  });

  test('merges from multiple pinned emails', () => {
    const merged = collectAttachmentsForSend(
      [],
      [
        { itemId: 'p1', attachments: [{ id: 'p1a' }] },
        { itemId: 'p2', attachments: [{ id: 'p2a' }, { id: 'p2b' }] }
      ],
      'currentItem'
    );
    expect(merged.map(a => a.id)).toEqual(['p1a', 'p2a', 'p2b']);
  });
});
