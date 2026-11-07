// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

const {
  attachmentIdsOf,
  toAttachmentViews
} = require('../../../client/src/features/chat/messageAttachments/attachmentViews');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const liveDoc = {
  type: 'document',
  fileName: 'Contract.pdf',
  fileSize: 2400000,
  fileType: 'application/pdf',
  content: 'x'.repeat(120),
  serverStored: true,
  fileId: 'file_abc',
  hasOriginal: true
};
const liveImage = {
  type: 'image',
  fileName: 'scan.png',
  fileSize: 5000,
  fileType: 'image/png',
  base64: PNG,
  width: 800,
  height: 600
};
const liveAudio = {
  type: 'audio',
  fileName: 'memo.mp3',
  fileSize: 90000,
  fileType: 'audio/mpeg',
  base64: 'data:audio/mpeg;base64,AAAA'
};

describe('toAttachmentViews: a turn sent in this session', () => {
  test('nothing attached', () => {
    expect(toAttachmentViews({ live: {} })).toEqual([]);
    expect(
      toAttachmentViews({ live: { fileData: null, imageData: null, audioData: null } })
    ).toEqual([]);
    expect(toAttachmentViews()).toEqual([]);
  });

  test('a stored document is openable by its id and says what the assistant read', () => {
    const [view] = toAttachmentViews({ live: { fileData: liveDoc } });
    expect(view).toMatchObject({
      id: 'file_abc',
      key: '0:file_abc',
      kind: 'document',
      name: 'Contract.pdf',
      mimeType: 'application/pdf',
      bytes: 2400000,
      originalKept: true,
      source: 'live',
      unsaved: false,
      shared: null
    });
    expect(view.read).toMatchObject({ kind: 'document', characters: 120 });
  });

  test('a document that was only sent inline has no id and no stored state', () => {
    const [view] = toAttachmentViews({
      live: { fileData: { ...liveDoc, serverStored: false, fileId: undefined } }
    });
    expect(view.id).toBeNull();
    expect(view.originalKept).toBeNull();
    expect(view.key).toBe('0:Contract.pdf');
  });

  test('a document whose save failed is marked, and still has no id', () => {
    const [view] = toAttachmentViews({
      live: {
        fileData: {
          ...liveDoc,
          serverStored: false,
          fileId: undefined,
          uploadState: 'error',
          uploadError: 'QUOTA_CHAT_FILES'
        }
      }
    });
    expect(view.unsaved).toBe(true);
    expect(view.id).toBeNull();
  });

  test('an image has a thumbnail but nothing to open; audio has neither', () => {
    const [image, audio] = toAttachmentViews({
      live: { imageData: liveImage, audioData: liveAudio }
    });
    expect(image).toMatchObject({ kind: 'image', id: null, previewSrc: PNG });
    expect(audio).toMatchObject({ kind: 'audio', id: null, previewSrc: null });
  });

  test('documents, then images, then audio, whatever order the payload fields come in', () => {
    const views = toAttachmentViews({
      live: { audioData: liveAudio, imageData: [liveImage], fileData: [liveDoc] }
    });
    expect(views.map(view => view.kind)).toEqual(['document', 'image', 'audio']);
  });

  test('the composer type decides the kind, not the media type', () => {
    const [view] = toAttachmentViews({
      live: { fileData: { ...liveDoc, fileType: 'image/png', serverStored: false } }
    });
    expect(view.kind).toBe('document');
  });

  test('a preview is only ever a raster image data URL', () => {
    const hostile = [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'https://evil.example/track.png',
      'javascript:alert(1)',
      `${PNG}"onerror="alert(1)`,
      ''
    ];
    for (const base64 of hostile) {
      const [view] = toAttachmentViews({ live: { imageData: { ...liveImage, base64 } } });
      expect(view.previewSrc).toBeNull();
    }
  });

  test('a file name is data, never markup: it comes through unchanged', () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    const [view] = toAttachmentViews({ live: { fileData: { ...liveDoc, fileName: name } } });
    expect(view.name).toBe(name);
  });

  test('a file without a name gets an empty name for the card to replace', () => {
    const [view] = toAttachmentViews({ live: { fileData: { type: 'document' } } });
    expect(view.name).toBe('');
    expect(view.bytes).toBeNull();
  });
});

describe('toAttachmentViews: a turn read back from the store', () => {
  test('a stored document descriptor', () => {
    const [view] = toAttachmentViews({
      stored: [
        {
          id: 'file_abc',
          type: 'application/pdf',
          name: 'Contract.pdf',
          bytes: 2400000,
          hasOriginal: true
        }
      ]
    });
    expect(view).toMatchObject({
      id: 'file_abc',
      kind: 'document',
      name: 'Contract.pdf',
      mimeType: 'application/pdf',
      bytes: 2400000,
      originalKept: true,
      read: null,
      previewSrc: null,
      source: 'stored'
    });
  });

  test('image and audio descriptors have no id', () => {
    const views = toAttachmentViews({
      stored: [
        { type: 'image/png', name: 'scan.png', bytes: 5000 },
        { type: 'audio/mpeg', name: 'memo.mp3', bytes: 90000 }
      ]
    });
    expect(views.map(view => [view.kind, view.id])).toEqual([
      ['image', null],
      ['audio', null]
    ]);
  });

  test('an older descriptor that recorded the upload kind as its type', () => {
    const views = toAttachmentViews({
      stored: [
        { type: 'image', name: 'a.png' },
        { type: 'document', name: 'b.pdf' }
      ]
    });
    expect(views.map(view => view.kind)).toEqual(['image', 'document']);
    expect(views.every(view => view.mimeType === null)).toBe(true);
  });

  test('the field spellings the server reads', () => {
    const [view] = toAttachmentViews({
      stored: [{ fileId: 'f1', fileName: 'x.docx', fileSize: '10', mimeType: 'text/plain' }]
    });
    expect(view).toMatchObject({ id: 'f1', name: 'x.docx', bytes: 10, mimeType: 'text/plain' });
  });

  test('a shared snapshot carries whether the viewer may open each file', () => {
    const views = toAttachmentViews({
      stored: [
        { id: 'a', type: 'application/pdf', name: 'a.pdf', shared: true },
        { id: 'b', type: 'application/pdf', name: 'b.pdf', shared: false },
        { id: 'c', type: 'application/pdf', name: 'c.pdf' }
      ]
    });
    expect(views.map(view => view.shared)).toEqual([true, false, null]);
  });

  test('entries that are not objects are dropped', () => {
    expect(
      toAttachmentViews({ stored: [null, 'x', [], { name: 'ok', type: 'text/plain' }] })
    ).toHaveLength(1);
  });

  test('a discarded original is not a size: the view says so', () => {
    const [view] = toAttachmentViews({
      stored: [
        { id: 'a', type: 'application/pdf', name: 'a.pdf', bytes: 41000, hasOriginal: false }
      ]
    });
    expect(view.originalKept).toBe(false);
  });
});

describe('a turn looks the same before and after a reload', () => {
  const strip = ({ read: _read, previewSrc: _previewSrc, source: _source, ...rest }) => rest;

  test('the same files, live and stored, give equal views apart from live-only data', () => {
    const live = toAttachmentViews({
      live: { fileData: liveDoc, imageData: liveImage, audioData: liveAudio }
    });
    const stored = toAttachmentViews({
      stored: [
        {
          id: 'file_abc',
          type: 'application/pdf',
          name: 'Contract.pdf',
          bytes: 2400000,
          hasOriginal: true
        },
        { type: 'image/png', name: 'scan.png', bytes: 5000 },
        { type: 'audio/mpeg', name: 'memo.mp3', bytes: 90000 }
      ]
    });
    expect(stored.map(strip)).toEqual(live.map(strip));
  });
});

describe('attachmentIdsOf', () => {
  test('the ids of the stored files, once each, in order', () => {
    const views = toAttachmentViews({
      stored: [
        { id: 'a', type: 'application/pdf', name: 'a.pdf' },
        { type: 'image/png', name: 'x.png' },
        { id: 'b', type: 'text/plain', name: 'b.txt' },
        { id: 'a', type: 'application/pdf', name: 'a.pdf' }
      ]
    });
    expect(attachmentIdsOf({ attachments: views })).toEqual(['a', 'b']);
  });

  test('a message without attachments', () => {
    expect(attachmentIdsOf({})).toEqual([]);
    expect(attachmentIdsOf(null)).toEqual([]);
  });
});

describe('keys', () => {
  test('the same stored file attached twice gives two different keys', () => {
    const views = toAttachmentViews({
      stored: [
        { id: 'file_abc', type: 'application/pdf', name: 'a.pdf' },
        { id: 'file_abc', type: 'application/pdf', name: 'a.pdf' }
      ]
    });
    expect(new Set(views.map(view => view.key)).size).toBe(2);
    const live = toAttachmentViews({
      live: {
        fileData: [
          { type: 'document', fileName: 'a.pdf', serverStored: true, fileId: 'file_abc' },
          { type: 'document', fileName: 'a.pdf', serverStored: true, fileId: 'file_abc' }
        ]
      }
    });
    expect(new Set(live.map(view => view.key)).size).toBe(2);
  });
});
