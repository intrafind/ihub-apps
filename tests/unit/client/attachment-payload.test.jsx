// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  classifyFiles,
  imagesNeedVision,
  payloadFieldsOf,
  toApiFileField
} from '../../../client/src/features/chat/messageAttachments/attachmentPayload';

const image = { type: 'image', fileName: 'a.png', base64: 'data:image/png;base64,AAAA' };
const image2 = { type: 'image', fileName: 'b.png', base64: 'data:image/png;base64,BBBB' };
const audio = { type: 'audio', fileName: 'a.mp3', base64: 'data:audio/mpeg;base64,AAAA' };
const doc = { type: 'document', fileName: 'a.pdf', content: 'text' };
const doc2 = { type: 'document', fileName: 'b.pdf', content: 'more' };

describe('toApiFileField', () => {
  test('none is null, one is the object, several are the list', () => {
    expect(toApiFileField([])).toBeNull();
    expect(toApiFileField(undefined)).toBeNull();
    expect(toApiFileField([doc])).toBe(doc);
    expect(toApiFileField([doc, doc2])).toEqual([doc, doc2]);
  });
});

describe('classifyFiles', () => {
  test('nothing selected', () => {
    expect(classifyFiles(null)).toEqual({ images: [], audioFiles: [], documents: [] });
    expect(classifyFiles(undefined)).toEqual({ images: [], audioFiles: [], documents: [] });
  });

  test('one attachment of each kind', () => {
    expect(classifyFiles(image)).toEqual({ images: [image], audioFiles: [], documents: [] });
    expect(classifyFiles(audio)).toEqual({ images: [], audioFiles: [audio], documents: [] });
    expect(classifyFiles(doc)).toEqual({ images: [], audioFiles: [], documents: [doc] });
  });

  test('a mixed list keeps the order inside each kind', () => {
    expect(classifyFiles([doc, image, audio, doc2, image2])).toEqual({
      images: [image, image2],
      audioFiles: [audio],
      documents: [doc, doc2]
    });
  });

  test('an entry of another type is not sent as a file', () => {
    const odd = { type: 'file', fileName: 'x' };
    expect(classifyFiles([odd, doc])).toEqual({ images: [], audioFiles: [], documents: [doc] });
  });

  test('empty entries in a list are ignored', () => {
    expect(classifyFiles([null, doc, undefined])).toEqual({
      images: [],
      audioFiles: [],
      documents: [doc]
    });
  });
});

describe('payloadFieldsOf', () => {
  test('no attachments: all three fields are null', () => {
    expect(payloadFieldsOf(null)).toEqual({ imageData: null, audioData: null, fileData: null });
  });

  test('a single image or audio file is the object itself, as the API has always taken it', () => {
    expect(payloadFieldsOf(image)).toEqual({ imageData: image, audioData: null, fileData: null });
    expect(payloadFieldsOf(audio)).toEqual({ imageData: null, audioData: audio, fileData: null });
  });

  test('a mix goes out as one object per single kind and a list per repeated kind', () => {
    expect(payloadFieldsOf([image, image2, audio, doc])).toEqual({
      imageData: [image, image2],
      audioData: audio,
      fileData: doc
    });
  });
});

describe('imagesNeedVision: an image is only sent to a model that can see it', () => {
  const vision = { id: 'm-vision', supportsVision: true };
  const textOnly = { id: 'm-text', supportsVision: false };
  const transcription = { id: 'whisper', modelType: 'transcription', supportsVision: true };

  test('an image on a model with vision is fine, on a text-only model it is not', () => {
    expect(imagesNeedVision(image, vision)).toBe(false);
    expect(imagesNeedVision(image, textOnly)).toBe(true);
    expect(imagesNeedVision([doc, image2], textOnly)).toBe(true);
  });

  test('the older `supportsImages` flag and the model id hint count, as they do for the uploader', () => {
    expect(imagesNeedVision(image, { id: 'x', supportsImages: true })).toBe(false);
    expect(imagesNeedVision(image, { id: 'claude-3-haiku' })).toBe(false);
    expect(imagesNeedVision(image, { id: 'llama' })).toBe(true);
  });

  test('a transcription model takes audio and video only, never an image', () => {
    expect(imagesNeedVision(image, transcription)).toBe(true);
  });

  test('without images there is nothing to refuse, whatever the model', () => {
    expect(imagesNeedVision(null, textOnly)).toBe(false);
    expect(imagesNeedVision(doc, textOnly)).toBe(false);
    expect(imagesNeedVision(audio, textOnly)).toBe(false);
  });

  test('no model known yet: an attached image is held back rather than sent blind', () => {
    expect(imagesNeedVision(image, null)).toBe(true);
    expect(imagesNeedVision(image, undefined)).toBe(true);
  });
});
