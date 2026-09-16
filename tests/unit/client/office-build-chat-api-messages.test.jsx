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
  })),
  // Real implementation of the shared canvas-resize primitive, exercised
  // against the HTMLCanvasElement/Image stubs set up below — this keeps the
  // integration between buildChatApiMessages and the shared helper covered
  // instead of stubbing the helper away entirely.
  resizeImageCanvas: jest.fn((img, maxDimension, quality = 0.8) => {
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;

    if (width > height && width > maxDimension) {
      height = Math.round((height * maxDimension) / width);
      width = maxDimension;
    } else if (height > maxDimension) {
      width = Math.round((width * maxDimension) / height);
      height = maxDimension;
    }

    const canvas = global.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);

    return { width, height, dataUrl };
  })
}));

const {
  isImageAttachment,
  buildImageDataFromMailAttachments,
  buildFileDataFromMailAttachments,
  collectAttachmentsForSend,
  formatFileDataAsPromptText,
  combineUserTextWithEmailContext,
  combineUserTextWithAppointmentContext
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

  test('sends cloud attachments (format: url) as a link reference instead of dropping them', async () => {
    // Office only exposes the share link for OneDrive/SharePoint attachments,
    // not the file bytes — there's nothing to extract, but silently dropping
    // it (the old behavior) left the model with no idea the attachment
    // existed at all. See issue #1451.
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 100_000,
        content: { format: 'url', content: 'https://onedrive.live.com/.../invoice.pdf' }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fileName).toBe('invoice.pdf');
    expect(out[0].content).toContain('https://onedrive.live.com/.../invoice.pdf');
  });

  test('parses an attached/forwarded email (format: eml) into readable content', async () => {
    // Base64 of a plain-text RFC 5322 message (headers + body); see
    // emailAttachmentParsers.test.js for the full parser test suite.
    const emlBase64 =
      'RnJvbTogSmFuZSBEb2UgPGphbmVAZXhhbXBsZS5jb20+DQpUbzogQm9iIFNtaXRoIDxib2JAZXhhbXBsZS5jb20+DQpTdWJqZWN0OiBSZTogUTMgbnVtYmVycw0KRGF0ZTogTW9uLCAxNSBKdWwgMjAyNiAwOTowMDowMCArMDAwMA0KQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluOyBjaGFyc2V0PVVURi04DQoNCkhpIEJvYiwNCg0KUGxlYXNlIHNlZSB0aGUgYXR0YWNoZWQgZmlndXJlcyBmb3IgUTMuDQoNClRoYW5rcywNCkphbmUNCg==';
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'Fwd Q3 report.eml',
        contentType: 'message/rfc822',
        size: 1000,
        content: { format: 'eml', content: emlBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].displayType).toBe('Email');
    expect(out[0].content).toContain('Subject: Re: Q3 numbers');
    expect(out[0].content).toContain('Please see the attached figures for Q3.');
  });

  test('parses a meeting invite (format: icalendar) into a readable summary', async () => {
    const icsBase64 =
      'QkVHSU46VkNBTEVOREFSDQpWRVJTSU9OOjIuMA0KQkVHSU46VkVWRU5UDQpTVU1NQVJZOlF1YXJ0ZXJseSBQbGFubmluZw0KRFRTVEFSVDoyMDI2MDcxNVQwOTAwMDBaDQpEVEVORDoyMDI2MDcxNVQxMDAwMDBaDQpMT0NBVElPTjpDb25mZXJlbmNlIFJvb20gQQ0KT1JHQU5JWkVSO0NOPUphbmUgRG9lOm1haWx0bzpqYW5lQGV4YW1wbGUuY29tDQpFTkQ6VkVWRU5UDQpFTkQ6VkNBTEVOREFSDQo=';
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'invite.ics',
        contentType: 'text/calendar',
        size: 500,
        content: { format: 'icalendar', content: icsBase64 }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].displayType).toBe('Calendar invite');
    expect(out[0].content).toContain('Meeting: Quarterly Planning');
    expect(out[0].content).toContain('Location: Conference Room A');
  });

  test('skips attachments with an unrecognized, non-base64 content format', async () => {
    const out = await buildFileDataFromMailAttachments([
      {
        id: 'a1',
        name: 'mystery.dat',
        contentType: 'application/octet-stream',
        size: 100,
        content: { format: 'some-future-format', content: 'whatever' }
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

describe('formatFileDataAsPromptText', () => {
  // The live token estimate must count attachment text the same way the
  // server stitches it into the prompt (RequestBuilder's
  // preprocessMessagesWithFileData): "[File: name (type)]\n\ncontent\n\n"
  // blocks, concatenated. Anything else and the context-window indicator
  // drifts from the request that actually goes out.
  test('mirrors the server-side file block format', () => {
    const text = formatFileDataAsPromptText([
      { fileName: 'report.pdf', fileType: 'application/pdf', content: 'PDF TEXT' },
      {
        fileName: 'deck.pptx',
        fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        displayType: 'PPTX',
        content: '[Slide 1]\nHello'
      }
    ]);
    expect(text).toBe(
      '[File: report.pdf (application/pdf)]\n\nPDF TEXT\n\n' +
        '[File: deck.pptx (PPTX)]\n\n[Slide 1]\nHello\n\n'
    );
  });

  test('skips entries without extracted content (e.g. image-based PDFs)', () => {
    const text = formatFileDataAsPromptText([
      { fileName: 'scan.pdf', fileType: 'application/pdf', pageImages: ['data:image/jpeg;...'] },
      { fileName: 'notes.txt', fileType: 'text/plain', content: 'hello' }
    ]);
    expect(text).toBe('[File: notes.txt (text/plain)]\n\nhello\n\n');
  });

  test('returns empty string for null/empty input', () => {
    expect(formatFileDataAsPromptText(null)).toBe('');
    expect(formatFileDataAsPromptText([])).toBe('');
    expect(formatFileDataAsPromptText(undefined)).toBe('');
  });
});

describe('combineUserTextWithEmailContext', () => {
  const email = {
    available: true,
    itemKind: 'message',
    itemId: 'ITEM-1',
    subject: 'AW: Demo',
    from: { name: 'Daniel Lieckfeldt', email: 'daniel.lieckfeldt@example.com' },
    to: [
      { name: 'Jörg Issel', email: 'joerg@example.com' },
      { name: 'Daniel Manzke', email: 'daniel.manzke@example.com' }
    ],
    cc: [{ name: 'Nelson', email: 'nelson@example.com' }],
    dateTimeCreated: '2026-09-15T15:02:00.000Z',
    mailboxUser: { name: 'Daniel Manzke', email: 'daniel.manzke@example.com' },
    bodyText: 'Hey zusammen,\n\nbitte passt die Laufzeiten an.',
    attachments: []
  };

  test('tags the email with its headers first and the typed note last in <user_instruction>', () => {
    const out = combineUserTextWithEmailContext({
      userText: 'Jörg soll das machen.',
      currentEmail: email,
      currentItemId: 'ITEM-1',
      pinned: []
    });

    expect(out.startsWith('<current_email>\n')).toBe(true);
    expect(out).toContain('<from>Daniel Lieckfeldt (daniel.lieckfeldt@example.com)</from>');
    expect(out).toContain(
      '<to>Jörg Issel (joerg@example.com), Daniel Manzke (daniel.manzke@example.com)</to>'
    );
    expect(out).toContain('<cc>Nelson (nelson@example.com)</cc>');
    expect(out).toMatch(/<date>[^<]*2026[^<]*<\/date>/);
    expect(out).toContain('<subject>AW: Demo</subject>');
    expect(out).toContain('<mailbox_user>Daniel Manzke (daniel.manzke@example.com)</mailbox_user>');
    expect(out).toContain(
      '<body>\nHey zusammen,\n\nbitte passt die Laufzeiten an.\n</body>\n</current_email>'
    );
    expect(out.endsWith('\n\n<user_instruction>\nJörg soll das machen.\n</user_instruction>')).toBe(
      true
    );
    // The note comes after the source material, never in front of it.
    expect(out.indexOf('</current_email>')).toBeLessThan(out.indexOf('<user_instruction>'));
    expect(out).not.toContain('--- Current email ---');
  });

  test('sends the typed text untouched when there is no host context', () => {
    expect(
      combineUserTextWithEmailContext({ userText: 'Hello', currentEmail: null, pinned: [] })
    ).toBe('Hello');
    expect(
      combineUserTextWithEmailContext({
        userText: 'Hello',
        currentEmail: { available: false, bodyText: null, attachments: [] },
        pinned: []
      })
    ).toBe('Hello');
  });

  test('keeps the headers when the user excluded the body', () => {
    const out = combineUserTextWithEmailContext({
      userText: '',
      currentEmail: { ...email, bodyText: null },
      pinned: []
    });

    expect(out).toContain('<from>Daniel Lieckfeldt');
    expect(out).toContain('<subject>AW: Demo</subject>');
    expect(out).not.toContain('<body>');
    expect(out).not.toContain('<user_instruction>');
  });

  test('omits headers the host did not deliver', () => {
    const out = combineUserTextWithEmailContext({
      userText: 'x',
      currentEmail: { available: true, bodyText: 'Body only', attachments: [] },
      pinned: []
    });

    expect(out).toBe(
      '<current_email>\n<body>\nBody only\n</body>\n</current_email>\n\n<user_instruction>\nx\n</user_instruction>'
    );
  });

  test('pinned emails come first, deduplicated against the current item and each other', () => {
    const pinned = [
      { itemId: 'ITEM-1', subject: 'AW: Demo', bodyText: 'dup of current' },
      {
        itemId: 'P-1',
        subject: 'Budget',
        bodyText: 'Budget ok',
        from: { name: 'Phil', email: 'phil@example.com' }
      },
      { itemId: 'P-1', subject: 'Budget', bodyText: 'Budget ok' },
      { itemId: 'P-2', subject: '', bodyText: '' }
    ];

    const out = combineUserTextWithEmailContext({
      userText: 'Summarize',
      currentEmail: email,
      currentItemId: 'ITEM-1',
      pinned
    });

    expect(
      out.startsWith(
        '<pinned_emails>\n<email index="1">\n<from>Phil (phil@example.com)</from>\n<subject>Budget</subject>\n<body>\nBudget ok\n</body>\n</email>\n</pinned_emails>\n\n<current_email>'
      )
    ).toBe(true);
    expect(out).not.toContain('index="2"');
    expect(out).not.toContain('dup of current');
    expect(out.endsWith('<user_instruction>\nSummarize\n</user_instruction>')).toBe(true);
  });

  test('renders the browser extension page as <current_page> and drops it without text', () => {
    const page = {
      available: true,
      itemKind: 'page',
      title: 'Docs',
      url: 'https://example.com/docs',
      subject: 'Docs',
      bodyText: 'Page text',
      attachments: []
    };

    expect(
      combineUserTextWithEmailContext({ userText: 'Summarize', currentEmail: page, pinned: [] })
    ).toBe(
      '<current_page>\n<title>Docs</title>\n<url>https://example.com/docs</url>\n<body>\nPage text\n</body>\n</current_page>\n\n<user_instruction>\nSummarize\n</user_instruction>'
    );
    expect(
      combineUserTextWithEmailContext({
        userText: 'Summarize',
        currentEmail: { ...page, bodyText: null },
        pinned: []
      })
    ).toBe('Summarize');
  });
});

describe('combineUserTextWithAppointmentContext', () => {
  test('renders the meeting as <current_meeting> followed by the typed note', () => {
    const out = combineUserTextWithAppointmentContext({
      userText: 'Draft an agenda',
      appointmentCtx: {
        available: true,
        itemKind: 'appointment',
        subject: 'Planning',
        isOrganizer: true,
        start: '2026-09-15T08:00:00.000Z',
        end: '2026-09-15T09:00:00.000Z',
        location: 'Room A',
        organizer: { name: 'Ada', email: 'ada@example.com' },
        requiredAttendees: [{ name: 'Bob', email: 'bob@example.com' }],
        optionalAttendees: [],
        bodyText: 'Quarterly planning'
      }
    });

    expect(
      out.startsWith(
        '<current_meeting>\n<subject>Planning</subject>\n<your_role>Organizer</your_role>\n<when>'
      )
    ).toBe(true);
    expect(out).toContain(
      '<location>Room A</location>\n<organizer>Ada (ada@example.com)</organizer>\n<required_attendees>Bob (bob@example.com)</required_attendees>\n<description>\nQuarterly planning\n</description>\n</current_meeting>'
    );
    expect(out.endsWith('\n\n<user_instruction>\nDraft an agenda\n</user_instruction>')).toBe(true);
    expect(out).not.toContain('--- Current meeting ---');
  });

  test('returns the typed text alone without an appointment', () => {
    expect(
      combineUserTextWithAppointmentContext({
        userText: 'Hi',
        appointmentCtx: { available: false }
      })
    ).toBe('Hi');
  });
});
