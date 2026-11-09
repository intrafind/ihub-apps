// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An export names the files of a message; it never carries what was in them.
 */

import { exportableMessage } from '../../../client/src/features/chat/messageAttachments/exportMessage';

const view = extra => ({
  key: '0:file_1',
  id: 'file_1',
  kind: 'document',
  name: 'Contract.pdf',
  mimeType: 'application/pdf',
  bytes: 2400000,
  originalKept: true,
  read: { kind: 'document', characters: 120 },
  previewSrc: null,
  unsaved: false,
  shared: null,
  source: 'live',
  ...extra
});

describe('exportableMessage', () => {
  test('drops the payload a message sent in this session still holds', () => {
    const exported = exportableMessage({
      id: 'm1',
      role: 'user',
      content: 'Please compare',
      timestamp: 1700000000000,
      imageData: { base64: 'data:image/png;base64,AAAA' },
      fileData: { content: 'the text of the file' },
      audioData: { base64: 'data:audio/wav;base64,BBBB' }
    });
    expect(exported).toEqual({
      id: 'm1',
      role: 'user',
      content: 'Please compare',
      timestamp: 1700000000000
    });
  });

  test('describes each attachment by what it is, with no thumbnail and no read numbers', () => {
    const exported = exportableMessage({
      role: 'user',
      content: 'x',
      attachments: [
        view(),
        view({
          id: null,
          kind: 'image',
          name: 'a.png',
          mimeType: 'image/png',
          bytes: 5,
          previewSrc: 'data:image/png;base64,SECRET'
        })
      ]
    });
    expect(exported.attachments).toEqual([
      {
        id: 'file_1',
        kind: 'document',
        name: 'Contract.pdf',
        mimeType: 'application/pdf',
        bytes: 2400000
      },
      { kind: 'image', name: 'a.png', mimeType: 'image/png', bytes: 5 }
    ]);
    expect(JSON.stringify(exported)).not.toContain('SECRET');
  });

  test('gives no size once only the text is kept: it would be the size of the text', () => {
    const [attachment] = exportableMessage({
      attachments: [view({ originalKept: false, bytes: 41000 })]
    }).attachments;
    expect(attachment).not.toHaveProperty('bytes');
  });

  test('a message without files comes out as it went in, and an empty list leaves no key', () => {
    const message = { id: 'm2', role: 'assistant', content: 'Done', usage: { total: 5 } };
    expect(exportableMessage(message)).toEqual(message);
    expect(exportableMessage({ ...message, attachments: [] })).toEqual(message);
  });

  test('leaves the message of the page alone', () => {
    const message = { role: 'user', content: 'x', fileData: { content: 'kept on the page' } };
    exportableMessage(message);
    expect(message.fileData).toEqual({ content: 'kept on the page' });
  });

  test('passes through what is not a message', () => {
    expect(exportableMessage(null)).toBeNull();
    expect(exportableMessage(undefined)).toBeUndefined();
  });
});
