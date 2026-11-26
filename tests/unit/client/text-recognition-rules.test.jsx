// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text recognition at upload (#3986), the client's rules: when a chat's composer sends an image
 * to the server to have its text recognized, which apps "Use in app…" lists for a picture, when
 * "Copy to project…" is offered for one, what the chips and cards say about a recognized file,
 * that an image still waiting for its text is not sent, and the messages of the OCR error codes.
 */
import {
  appRecognizesImages,
  awaitsRecognition,
  chatRecognizesText,
  composerRecognizesImages,
  isRecognizableImage,
  recognitionLabel,
  recognitionOf,
  recognitionTitle,
  recognizedImageAttachment,
  recognizedImageUploadAllowed
} from '../../../client/src/features/upload/utils/textRecognition';
import {
  appsAcceptingFile,
  canUseArtifactInApp
} from '../../../client/src/features/chat/utils/useInApp';
import { canCopyArtifactToProject } from '../../../client/src/features/projects/utils/projectImport';
import {
  itemErrorMessage,
  projectErrorMessage
} from '../../../client/src/features/projects/utils/projectErrors';
import { classifyFiles } from '../../../client/src/features/chat/messageAttachments/attachmentPayload';
import { toAttachmentViews } from '../../../client/src/features/chat/messageAttachments/attachmentViews';
import {
  ORIGINAL_FILE,
  buildUploadPayload,
  needsPreUpload,
  withStoredFile
} from '../../../client/src/features/chat/utils/chatFileUpload';
import {
  contentLineFromInfo,
  contentLineOf,
  describeAttachment
} from '../../../client/src/features/upload/utils/attachmentDescription';

/** `t` that fills `{{name}}` from the options and returns the English fallback. */
const t = (key, fallback, options) =>
  String(typeof fallback === 'string' ? fallback : key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
    String(options?.[name] ?? '')
  );

const ON = { enabled: true, textRecognition: { available: true, chats: true } };
const OPT_OUT = { enabled: true, textRecognition: { available: true, chats: false } };
const NO_MODEL = { enabled: true, textRecognition: { available: false, chats: false } };

const docs = { id: 'docs', upload: { fileUpload: { enabled: true } } };
const vision = { id: 'vision', upload: { imageUpload: { enabled: true } } };
const imagesOnly = {
  id: 'images-only',
  upload: { imageUpload: { enabled: true }, fileUpload: { enabled: false } }
};
const audioOnly = {
  id: 'audio-only',
  upload: { audioUpload: { enabled: true }, fileUpload: { enabled: false } }
};
const uploadsOff = { id: 'off', upload: { enabled: false, fileUpload: { enabled: true } } };
const optedOut = { ...docs, id: 'opted-out', uploads: { recognizeText: false } };
const optedIn = { ...docs, id: 'opted-in', uploads: { recognizeText: true } };

describe('chatRecognizesText', () => {
  it('follows the installation, and an app that sets it overrides it', () => {
    expect(chatRecognizesText(ON, docs)).toBe(true);
    expect(chatRecognizesText(ON, optedOut)).toBe(false);
    expect(chatRecognizesText(OPT_OUT, docs)).toBe(false);
    expect(chatRecognizesText(OPT_OUT, optedIn)).toBe(true);
  });

  it('is off without a model, whatever the app says', () => {
    expect(chatRecognizesText(NO_MODEL, optedIn)).toBe(false);
    expect(chatRecognizesText(undefined, optedIn)).toBe(false);
  });
});

describe('isRecognizableImage', () => {
  it('takes PNG, JPEG, GIF and WebP by type or extension, nothing else', () => {
    expect(isRecognizableImage('image/png')).toBe(true);
    expect(isRecognizableImage('image/jpg')).toBe(true);
    expect(isRecognizableImage('', 'scan.WEBP')).toBe(true);
    expect(isRecognizableImage('application/octet-stream', 'photo.jpeg')).toBe(true);
    expect(isRecognizableImage('image/svg+xml')).toBe(false);
    expect(isRecognizableImage('image/tiff')).toBe(false);
    expect(isRecognizableImage('application/pdf')).toBe(false);
  });
});

describe('recognizedImageUploadAllowed', () => {
  it('needs a local upload that takes documents or images', () => {
    expect(recognizedImageUploadAllowed(docs.upload)).toBe(true);
    expect(recognizedImageUploadAllowed(vision.upload)).toBe(true);
    expect(recognizedImageUploadAllowed(imagesOnly.upload)).toBe(true);
    expect(recognizedImageUploadAllowed(audioOnly.upload)).toBe(false);
    expect(recognizedImageUploadAllowed(uploadsOff.upload)).toBe(false);
    expect(recognizedImageUploadAllowed({ fileUpload: {} })).toBe(false);
    expect(recognizedImageUploadAllowed(undefined)).toBe(false);
  });
});

describe('composerRecognizesImages (does an attached image go to the server?)', () => {
  const decide = overrides =>
    composerRecognizesImages({
      uploads: ON,
      app: docs,
      preUpload: true,
      mode: 'original_and_text',
      ...overrides
    });

  it('sends the image to the server where the chat recognizes text and keeps files', () => {
    expect(decide()).toBe(true);
    expect(decide({ mode: 'server_text_only' })).toBe(true);
  });

  it('keeps the picture path where it cannot or must not', () => {
    // The app or the installation has it off, or no model is set
    expect(decide({ app: optedOut })).toBe(false);
    expect(decide({ uploads: OPT_OUT })).toBe(false);
    expect(decide({ uploads: NO_MODEL, app: optedIn })).toBe(false);
    // No file store for the chat: nothing could carry the image to the server
    expect(decide({ preUpload: false })).toBe(false);
    // Originals never leave the browser in this mode
    expect(decide({ mode: 'client_text_only' })).toBe(false);
  });
});

describe('the composer entry of an image to be recognized', () => {
  const file = new File(['png'], 'scan.png', { type: 'image/png' });
  const { data } = recognizedImageAttachment(file, 'image/png', 'PNG');

  it('is a document that uploads its original and is held back until stored', () => {
    expect(data).toMatchObject({ type: 'document', content: '', recognizeOnUpload: true });
    expect(needsPreUpload(data)).toBe(true);
    expect(buildUploadPayload(data, 'original_and_text')).toBe(file);
    expect(awaitsRecognition(data)).toBe(true);
    expect(classifyFiles([data]).documents).toEqual([]);
    expect(contentLineOf(data, t)).toBe('Its text is recognized when it is saved to the chat');
  });

  it('is sent by id once the server stored its recognized text', () => {
    const stored = withStoredFile(data, {
      id: 'file-1',
      hasOriginal: true,
      meta: { recognized: { modelId: 'vision-1', pages: 1, at: '2026-11-26T10:00:00Z' } }
    });
    expect(stored).toMatchObject({ fileId: 'file-1', serverStored: true });
    expect(stored.recognized).toMatchObject({ modelId: 'vision-1', pages: 1 });
    expect(awaitsRecognition(stored)).toBe(false);
    expect(classifyFiles([stored]).documents).toEqual([stored]);
    expect(contentLineOf(stored, t)).toBe('Text recognized from 1 page(s)');
  });

  it('is not sent, and says so, when the server could not recognize it', () => {
    const failed = { ...data, uploadState: 'error', uploadError: 'OCR_NO_TEXT' };
    expect(awaitsRecognition(failed)).toBe(true);
    expect(classifyFiles(failed).documents).toEqual([]);
    expect(describeAttachment(failed)).toMatchObject({ recognitionFailed: true });
    expect(contentLineOf(failed, t)).toBe('Not sent with the message');
  });

  it('leaves other documents alone', () => {
    const doc = { type: 'document', content: 'Hello', fileName: 'a.txt' };
    expect(awaitsRecognition(doc)).toBe(false);
    expect(classifyFiles(doc).documents).toEqual([doc]);
    expect(describeAttachment(doc)).not.toHaveProperty('recognizing');
  });
});

describe('what a recognized file says', () => {
  it('counts the pages, says when the page limit cut them, and names the model in the tooltip', () => {
    const scan = recognitionOf({
      meta: { recognized: { modelId: 'vision-1', pages: 3, at: '2026-11-26T10:00:00Z' } }
    });
    expect(recognitionLabel(scan, t)).toBe('Text recognized from 3 page(s)');
    expect(recognitionTitle(scan, t)).toBe('Recognized by vision-1');
    const cut = recognitionOf({
      text: { recognized: { modelId: 'm', pages: 50, truncated: true } }
    });
    expect(recognitionLabel(cut, t)).toBe('Text recognized from the first 50 page(s) only');
    expect(recognitionOf({ text: { chars: 10 } })).toBeNull();
    expect(recognitionLabel(null, t)).toBeNull();
  });

  it('shows a stored recognized image as a document on the message card', () => {
    const [view] = toAttachmentViews({
      stored: [
        {
          id: 'f1',
          type: 'image/png',
          name: 'scan.png',
          bytes: 1200,
          textBytes: 80,
          recognized: { modelId: 'vision-1', pages: 1 }
        }
      ]
    });
    expect(view.kind).toBe('document');
    expect(contentLineFromInfo(view.read, t)).toContain('Text recognized from 1 page(s)');
  });

  it('keeps a stored picture without recognition a picture', () => {
    const [view] = toAttachmentViews({
      stored: [{ id: 'f2', type: 'image/png', name: 'photo.png', bytes: 1200 }]
    });
    expect(view.kind).toBe('image');
  });
});

describe('"Use in app…" for pictures', () => {
  const picture = { id: 'a1', name: 'chart.png', mimeType: 'image/png' };

  it('is offered for a readable picture only while a text recognition model is set', () => {
    expect(canUseArtifactInApp(picture)).toBe(false);
    expect(canUseArtifactInApp(picture, { textRecognition: true })).toBe(true);
    expect(
      canUseArtifactInApp({ id: 'a2', kind: 'image', name: 'x.jpg' }, { textRecognition: true })
    ).toBe(true);
    expect(
      canUseArtifactInApp({ id: 'a3', mimeType: 'image/svg+xml' }, { textRecognition: true })
    ).toBe(false);
    // Archives stay out either way
    expect(
      canUseArtifactInApp({ id: 'a4', mimeType: 'application/zip' }, { textRecognition: true })
    ).toBe(false);
  });

  it('lists the apps whose chats recognize text, whatever their image upload and vision', () => {
    const apps = [docs, vision, imagesOnly, audioOnly, uploadsOff, optedOut, optedIn];
    const file = { mimeType: 'image/png', name: 'chart.png' };
    expect(appsAcceptingFile(apps, file, { uploads: ON }).map(app => app.id)).toEqual([
      'docs',
      'vision',
      'images-only',
      'opted-in'
    ]);
    // Installation opt-in off: only the app that switches it on for itself
    expect(appsAcceptingFile(apps, file, { uploads: OPT_OUT }).map(app => app.id)).toEqual([
      'opted-in'
    ]);
    // No model: no app takes a picture
    expect(appsAcceptingFile(apps, file, { uploads: NO_MODEL })).toEqual([]);
    expect(appsAcceptingFile(apps, file)).toEqual([]);
  });

  it('judges documents as before', () => {
    const md = { mimeType: 'text/markdown', name: 'notes.md' };
    expect(appsAcceptingFile([docs, vision], md, { uploads: ON }).map(app => app.id)).toEqual([
      'docs',
      'vision'
    ]);
  });

  it('checks the per-app opt-in with appRecognizesImages', () => {
    expect(appRecognizesImages(optedIn, OPT_OUT)).toBe(true);
    expect(appRecognizesImages(optedOut, ON)).toBe(false);
    expect(appRecognizesImages(audioOnly, ON)).toBe(false);
  });
});

describe('"Copy to project…" for pictures', () => {
  it('is offered for a readable picture only while projects recognize text', () => {
    const picture = { id: 'a1', name: 'chart.png', mimeType: 'image/png' };
    expect(canCopyArtifactToProject(picture)).toBe(false);
    expect(canCopyArtifactToProject(picture, { textRecognition: true })).toBe(true);
    expect(
      canCopyArtifactToProject({ id: 'a2', mimeType: 'image/svg+xml' }, { textRecognition: true })
    ).toBe(false);
    expect(canCopyArtifactToProject({ id: 'a3', mimeType: 'application/zip' })).toBe(true);
    expect(canCopyArtifactToProject({ mimeType: 'image/png' }, { textRecognition: true })).toBe(
      false
    );
  });
});

describe('OCR error codes', () => {
  const failed = code => ({ status: 'failed', error: { code, message: 'server text' } });

  it('gives a failed project item a translated message', () => {
    expect(itemErrorMessage(failed('OCR_UNAVAILABLE'), t)).toMatch(
      /^Text recognition is not available right now/
    );
    expect(itemErrorMessage(failed('OCR_FAILED'), t)).toMatch(/could not be recognized/);
    expect(itemErrorMessage(failed('OCR_NO_TEXT'), t)).toBe(
      'No text was found in this image or scan.'
    );
  });

  it('says the same for a refused upload', () => {
    const error = { response: { status: 502, data: { code: 'OCR_FAILED', detail: 'x' } } };
    expect(projectErrorMessage(error, t)).toMatch(/could not be recognized/);
  });
});

describe('the original file of an entry', () => {
  it('rides along under the shared symbol', () => {
    const file = new File(['gif'], 'a.gif', { type: 'image/gif' });
    expect(recognizedImageAttachment(file, 'image/gif', 'GIF').data[ORIGINAL_FILE]).toBe(file);
  });
});
