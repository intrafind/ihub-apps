// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Use in app…" (a generated file or a project document into a new chat of another app): which
 * apps the picker offers for a file, judged the way the composer's attach button is, and what is
 * handed to the server to copy.
 */
import {
  appUploadAccepts,
  fileTypeOf
} from '../../../client/src/features/upload/utils/uploadFormats';
import {
  appsAcceptingFile,
  artifactAttachment,
  canUseArtifactInApp,
  canUseProjectItemInApp,
  isChatApp,
  projectItemAttachment
} from '../../../client/src/features/chat/utils/useInApp';

const docs = { id: 'docs', upload: { fileUpload: { enabled: true } } };
const pdfOnly = {
  id: 'pdf-only',
  upload: { fileUpload: { enabled: true, supportedFormats: ['application/pdf'] } }
};
const anyText = {
  id: 'any-text',
  upload: { fileUpload: { enabled: true, supportedFormats: ['text/*'] } }
};
const vision = { id: 'vision', upload: { imageUpload: { enabled: true } } };
const uploadsOff = { id: 'off', upload: { enabled: false, fileUpload: { enabled: true } } };
const noUpload = { id: 'plain' };
const fileDefault = { id: 'file-default', upload: { fileUpload: {} } };

describe('fileTypeOf', () => {
  it('drops parameters and resolves aliases', () => {
    expect(fileTypeOf('text/markdown; charset=utf-8')).toBe('text/markdown');
    expect(fileTypeOf('image/jpg')).toBe('image/jpeg');
  });

  it('falls back on the extension for a missing or generic type', () => {
    expect(fileTypeOf('', 'notes.md')).toBe('text/markdown');
    expect(fileTypeOf('application/octet-stream', 'report.pdf')).toBe('application/pdf');
    expect(fileTypeOf('', 'unknown')).toBe('');
  });
});

describe('appUploadAccepts', () => {
  it('takes a document type where the composer offers local upload and documents are not off', () => {
    const md = { mimeType: 'text/markdown', name: 'a.md' };
    expect(appUploadAccepts(docs, md)).toBe(true);
    expect(appUploadAccepts(fileDefault, md)).toBe(false);
    expect(appUploadAccepts(noUpload, md)).toBe(false);
    expect(appUploadAccepts(uploadsOff, md)).toBe(false);
  });

  it('uses the composer defaults when the app lists no formats', () => {
    expect(appUploadAccepts(docs, { mimeType: 'application/pdf' })).toBe(true);
    expect(appUploadAccepts(docs, { mimeType: 'text/csv' })).toBe(true);
    // Office documents are not in the defaults: the app has to list them.
    expect(
      appUploadAccepts(docs, {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      })
    ).toBe(false);
  });

  it('honours the formats an app lists, and the text/* wildcard', () => {
    expect(appUploadAccepts(pdfOnly, { mimeType: 'application/pdf' })).toBe(true);
    expect(appUploadAccepts(pdfOnly, { mimeType: 'text/markdown' })).toBe(false);
    expect(appUploadAccepts(anyText, { mimeType: 'text/x-log' })).toBe(true);
    expect(appUploadAccepts(anyText, { mimeType: 'application/json' })).toBe(true);
    expect(appUploadAccepts(anyText, { mimeType: 'application/pdf' })).toBe(false);
  });

  it('takes nothing from an empty format list, as the composer does', () => {
    const none = { id: 'none', upload: { fileUpload: { enabled: true, supportedFormats: [] } } };
    expect(appUploadAccepts(none, { mimeType: 'application/pdf' })).toBe(false);
    expect(appUploadAccepts(none, { mimeType: 'text/markdown' })).toBe(false);
  });

  it('judges pictures by the image upload, not the file upload', () => {
    expect(appUploadAccepts(vision, { mimeType: 'image/png' })).toBe(true);
    expect(appUploadAccepts(docs, { mimeType: 'image/png' })).toBe(false);
  });
});

describe('appsAcceptingFile', () => {
  const personal = (overrides = {}) => ({
    ...docs,
    id: `uap_${Object.keys(overrides).join('-') || 'ok'}`,
    ownership: 'user',
    permissions: { canUse: true },
    ...overrides
  });

  it('lists the chat apps that take the type, in the given order', () => {
    const apps = [vision, docs, pdfOnly, uploadsOff, anyText];
    // `vision` switches images on and leaves documents unset: its composer takes
    // them, so the picker does too.
    expect(appsAcceptingFile(apps, { mimeType: 'text/markdown' }).map(app => app.id)).toEqual([
      'vision',
      'docs',
      'any-text'
    ]);
    expect(appsAcceptingFile(apps, { mimeType: 'application/pdf' }).map(app => app.id)).toEqual([
      'vision',
      'docs',
      'pdf-only'
    ]);
  });

  it('leaves out disabled apps, other app types and personal apps the user may not use', () => {
    const apps = [
      { ...docs, id: 'disabled', enabled: false },
      { ...docs, id: 'iframe', type: 'iframe' },
      personal(),
      personal({ permissions: { canUse: false } }),
      personal({ state: 'retired' })
    ];
    expect(appsAcceptingFile(apps, { mimeType: 'text/plain' }).map(app => app.id)).toEqual([
      'uap_ok'
    ]);
    expect(isChatApp({ id: 'x', type: 'chat' })).toBe(true);
  });

  it('copes with a missing list', () => {
    expect(appsAcceptingFile(undefined, { mimeType: 'text/plain' })).toEqual([]);
  });
});

describe('canUseArtifactInApp', () => {
  it('offers stored documents only: no pictures, no ZIP archives, no live files', () => {
    expect(canUseArtifactInApp({ id: 'a', mimeType: 'text/markdown', name: 'a.md' })).toBe(true);
    expect(canUseArtifactInApp({ id: 'a', mimeType: 'image/png' })).toBe(false);
    expect(canUseArtifactInApp({ id: 'a', kind: 'image', mimeType: '' })).toBe(false);
    expect(canUseArtifactInApp({ id: 'a', mimeType: 'application/zip' })).toBe(false);
    expect(canUseArtifactInApp({ id: 'a', mimeType: '', name: 'files.ZIP' })).toBe(false);
    expect(canUseArtifactInApp({ mimeType: 'text/plain' })).toBe(false);
  });
});

describe('artifactAttachment', () => {
  const artifact = { id: 'art-1', name: 'report.md', mimeType: 'text/markdown', bytes: 12 };

  it('refers to the artifact by its chat', () => {
    expect(artifactAttachment({ chatId: 'chat-1' }, artifact)).toEqual({
      source: { kind: 'chat-artifact', ref: { chatId: 'chat-1', artifactId: 'art-1' } },
      name: 'report.md',
      mimeType: 'text/markdown',
      bytes: 12
    });
  });

  it('refers to the artifact by the share it was opened through', () => {
    expect(artifactAttachment({ shareId: 'sh-1' }, artifact, 'Shown name').source).toEqual({
      kind: 'chat-artifact',
      ref: { shareId: 'sh-1', artifactId: 'art-1' }
    });
    expect(artifactAttachment({ shareId: 'sh-1' }, artifact, 'Shown name').name).toBe('Shown name');
  });

  it('is null without an owner or an id', () => {
    expect(artifactAttachment({}, artifact)).toBeNull();
    expect(artifactAttachment({ chatId: 'c' }, { name: 'x' })).toBeNull();
  });
});

describe('project documents', () => {
  it('hands over the original file when the project kept one', () => {
    const item = {
      id: 'i1',
      name: 'Contract',
      hasOriginal: true,
      original: { name: 'contract.pdf', contentType: 'application/pdf', size: 99 }
    };
    expect(projectItemAttachment('prj_1', item)).toEqual({
      source: { kind: 'project-item', ref: { projectId: 'prj_1', itemId: 'i1' } },
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      bytes: 99
    });
  });

  it('hands over the text as Markdown otherwise', () => {
    const attachment = projectItemAttachment('prj_1', {
      id: 'i2',
      name: 'Notes',
      hasOriginal: false
    });
    expect(attachment.name).toBe('Notes.md');
    expect(attachment.mimeType).toBe('text/markdown');
  });

  it('offers only documents whose text is there and that are not "Not for AI"', () => {
    expect(canUseProjectItemInApp({ storage: 'text', status: 'ready' })).toBe(true);
    expect(canUseProjectItemInApp({ storage: 'text', status: 'stale' })).toBe(true);
    expect(canUseProjectItemInApp({ storage: 'text', status: 'pending' })).toBe(false);
    expect(canUseProjectItemInApp({ storage: 'text', status: 'failed' })).toBe(false);
    // A link has no stored file to hand over.
    expect(canUseProjectItemInApp({ storage: 'link', status: 'ready' })).toBe(false);
    expect(canUseProjectItemInApp({ status: 'ready', excludedFromAi: true })).toBe(false);
  });
});
