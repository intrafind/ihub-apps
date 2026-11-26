// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { renderHook, waitFor } from '@testing-library/react';

/**
 * The receiving end of "Use in app…": the new chat asks the server to copy the handed-over file
 * into its own file store (`POST /api/chats/{chatId}/files` with `{ appId, source }`) and shows
 * the stored file in the composer; a refusal is said in the chat with the server's `detail`.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) =>
      String(fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, n) => String(options?.[n] ?? ''))
  })
}));
const mockUpload = jest.fn();
const mockDelete = jest.fn(() => Promise.resolve());
const mockFetchArtifact = jest.fn();
jest.mock('../../../client/src/api', () => ({
  uploadChatFile: (...args) => mockUpload(...args),
  deleteChatFile: (...args) => mockDelete(...args),
  fetchChatArtifact: (...args) => mockFetchArtifact(...args),
  fetchSharedArtifact: jest.fn()
}));
const mockProcess = jest.fn();
jest.mock('../../../client/src/features/upload/utils/cloudFileProcessing', () => ({
  processCloudFile: (...args) => mockProcess(...args)
}));

const useSourceFileAttachment =
  require('../../../client/src/features/apps/hooks/useSourceFileAttachment').default;

const attachment = {
  source: { kind: 'chat-artifact', ref: { chatId: 'old-chat', artifactId: 'a1' } },
  name: 'report.md',
  mimeType: 'text/markdown',
  bytes: 10
};

function makeUploader() {
  const uploader = {
    selectedFile: null,
    setSelectedFile: jest.fn(value => {
      uploader.selectedFile = value;
    }),
    clearSelectedFile: jest.fn(() => {
      uploader.selectedFile = null;
    }),
    setAttachmentProcessing: jest.fn(),
    createUploadConfig: jest.fn(() => ({}))
  };
  return uploader;
}

const run = (overrides = {}) => {
  const uploader = makeUploader();
  const addSystemMessage = jest.fn();
  const onDone = jest.fn();
  renderHook(() =>
    useSourceFileAttachment({
      pending: { key: 1, attachment },
      ready: true,
      chatId: 'new-chat',
      app: { id: 'summarizer' },
      currentModel: { id: 'm' },
      fileUploadHandler: uploader,
      addSystemMessage,
      serverFiles: { enabled: true },
      onDone,
      ...overrides
    })
  );
  return { uploader, addSystemMessage, onDone };
};

beforeEach(() => jest.clearAllMocks());

describe('useSourceFileAttachment', () => {
  it('copies the file on the server and attaches the stored copy', async () => {
    mockUpload.mockResolvedValue({
      file: { id: 'f9', name: 'report.md', mimeType: 'text/markdown', bytes: 10 }
    });
    const { uploader, onDone } = run();
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(mockUpload).toHaveBeenCalledWith(
      'new-chat',
      { source: attachment.source },
      { fields: { appId: 'summarizer' } }
    );
    expect(uploader.selectedFile).toMatchObject({
      type: 'document',
      fileId: 'f9',
      serverStored: true,
      fileName: 'report.md'
    });
    expect(uploader.setAttachmentProcessing).toHaveBeenLastCalledWith(
      'source-file-attachment',
      false
    );
  });

  it('says why the server refused the copy', async () => {
    mockUpload.mockRejectedValue({
      originalError: {
        response: {
          status: 400,
          data: { code: 'UNSUPPORTED_TYPE', detail: 'This app does not take this type.' }
        }
      }
    });
    const { uploader, addSystemMessage, onDone } = run();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(uploader.selectedFile).toBeNull();
    expect(addSystemMessage).toHaveBeenCalledWith(
      'The file could not be attached: This app does not take this type.',
      true
    );
  });

  it('fetches the bytes in the browser where the server keeps no chat files', async () => {
    mockFetchArtifact.mockResolvedValue(new Blob(['# hi'], { type: 'text/markdown' }));
    mockProcess.mockResolvedValue({ type: 'document', fileName: 'report.md', content: '# hi' });
    const { uploader, onDone } = run({ serverFiles: { enabled: false } });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockFetchArtifact).toHaveBeenCalledWith('old-chat', 'a1');
    expect(uploader.selectedFile).toMatchObject({ fileName: 'report.md', source: 'chat-artifact' });
  });

  it('waits until the chat is ready', () => {
    run({ ready: false });
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
