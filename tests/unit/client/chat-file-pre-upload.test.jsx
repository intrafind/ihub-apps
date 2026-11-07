/**
 * Pre-upload of the composer's documents to the chat's file store (#3159).
 *
 * Pure helpers (storage mode, payload, wire split), the hook that uploads a
 * document as soon as it is attached (progress, stored, refused, removed), and
 * the attachment chip that shows the state.
 */
import '@testing-library/jest-dom';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
    }
  })
}));

const mockUpload = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../../client/src/api', () => ({
  uploadChatFile: (...args) => mockUpload(...args),
  deleteChatFile: (...args) => mockDelete(...args)
}));

let mockUploads = { enabled: true, storageMode: 'original_and_text' };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { uploads: mockUploads } })
}));

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const helpers = require('../../../client/src/features/chat/utils/chatFileUpload');
const useChatFilePreUpload =
  require('../../../client/src/features/chat/hooks/useChatFilePreUpload').default;
const AttachedFilesList =
  require('../../../client/src/features/upload/components/AttachedFilesList').default;

const { ORIGINAL_FILE } = helpers;

function documentEntry(overrides = {}) {
  const file = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
  return {
    type: 'document',
    source: 'local',
    fileName: 'report.pdf',
    fileSize: 4,
    fileType: 'application/pdf',
    displayType: 'PDF',
    content: 'Extracted text',
    [ORIGINAL_FILE]: file,
    ...overrides
  };
}

describe('chatFileUpload helpers', () => {
  it('resolves the storage mode: app override, then platform, then the default', () => {
    expect(helpers.resolveUploadMode({ storageMode: 'server_text_only' }, {})).toBe(
      'server_text_only'
    );
    expect(
      helpers.resolveUploadMode(
        { storageMode: 'server_text_only' },
        { uploads: { storageMode: 'client_text_only' } }
      )
    ).toBe('client_text_only');
    expect(helpers.resolveUploadMode({ storageMode: 'bogus' }, {})).toBe('original_and_text');
    expect(helpers.resolveUploadMode(undefined, undefined)).toBe('original_and_text');
  });

  it('only pre-uploads when the server keeps files and the chat exists', () => {
    expect(helpers.preUploadAvailable({ uploads: { enabled: true }, chatId: 'c1' })).toBe(true);
    expect(helpers.preUploadAvailable({ uploads: { enabled: false }, chatId: 'c1' })).toBe(false);
    expect(helpers.preUploadAvailable({ uploads: { enabled: true }, chatId: null })).toBe(false);
    expect(helpers.preUploadAvailable({ uploads: undefined, chatId: 'c1' })).toBe(false);
  });

  it('uploads the original in the server modes and only the text in client_text_only', () => {
    const entry = documentEntry();
    expect(helpers.buildUploadPayload(entry, 'original_and_text')).toBe(entry[ORIGINAL_FILE]);
    expect(helpers.buildUploadPayload(entry, 'server_text_only')).toBe(entry[ORIGINAL_FILE]);
    expect(helpers.buildUploadPayload(entry, 'client_text_only')).toEqual({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      text: 'Extracted text',
      formatLabel: 'PDF'
    });
    // No original at hand (an Outlook attachment): the text goes, whatever the mode.
    const noFile = documentEntry({ [ORIGINAL_FILE]: undefined });
    expect(helpers.buildUploadPayload(noFile, 'original_and_text')).toMatchObject({
      text: 'Extracted text'
    });
    expect(
      helpers.buildUploadPayload({ type: 'document', fileName: 'x' }, 'client_text_only')
    ).toBe(null);
  });

  it('sends scanned-PDF page images as strings', () => {
    const entry = documentEntry({
      content: '',
      pageImages: [{ base64: 'AAA' }, 'BBB', null],
      [ORIGINAL_FILE]: undefined
    });
    expect(helpers.buildUploadPayload(entry, 'client_text_only').pageImages).toEqual([
      'AAA',
      'BBB'
    ]);
  });

  it('keeps the file symbol through spread and JSON', () => {
    const entry = documentEntry();
    expect({ ...entry }[ORIGINAL_FILE]).toBe(entry[ORIGINAL_FILE]);
    expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty('fileId');
    expect(Object.keys(JSON.parse(JSON.stringify(entry)))).not.toContain(
      'Symbol(ihub.originalFile)'
    );
  });

  it('decides which entries still need an upload', () => {
    expect(helpers.needsPreUpload(documentEntry())).toBe(true);
    expect(helpers.needsPreUpload(documentEntry({ fileId: 'file_1' }))).toBe(false);
    expect(helpers.needsPreUpload(documentEntry({ loading: true }))).toBe(false);
    expect(helpers.needsPreUpload(documentEntry({ uploadState: 'uploading' }))).toBe(false);
    expect(helpers.needsPreUpload(documentEntry({ uploadState: 'error' }))).toBe(false);
    expect(helpers.needsPreUpload({ type: 'image', base64: 'x' })).toBe(false);
  });

  it('splits files for the wire: ids for stored files, inline for the rest', () => {
    const stored = documentEntry({ fileId: 'file_1', serverStored: true });
    const inline = documentEntry({ fileName: 'b.pdf' });
    expect(helpers.splitFilesForWire(stored)).toEqual({ fileData: null, fileIds: ['file_1'] });
    expect(helpers.splitFilesForWire([stored, inline])).toEqual({
      fileData: inline,
      fileIds: ['file_1']
    });
    expect(
      helpers.splitFilesForWire([inline, documentEntry({ fileName: 'c.pdf' })]).fileData
    ).toHaveLength(2);
    expect(helpers.splitFilesForWire([stored, { ...stored }]).fileIds).toEqual(['file_1']);
    expect(helpers.splitFilesForWire(null)).toEqual({ fileData: null, fileIds: [] });
    // A file with an id but never stored (an earlier failure) stays inline.
    expect(helpers.splitFilesForWire(documentEntry({ fileId: 'x' })).fileIds).toEqual([]);
  });

  it('updates the matching entry of a single or a list selection', () => {
    const a = documentEntry();
    const b = documentEntry({ fileName: 'b.pdf' });
    const mark = e => ({ ...e, marked: true });
    expect(helpers.updateSelection(a, helpers.entryKey(a), mark).marked).toBe(true);
    const list = helpers.updateSelection([a, b], helpers.entryKey(b), mark);
    expect(list[0].marked).toBeUndefined();
    expect(list[1].marked).toBe(true);
    expect(helpers.updateSelection(null, 'k', mark)).toBeNull();
  });

  it('reads the refusal code from a raw axios error and from the wrapped API error', () => {
    const body = { error: 'No room', code: 'QUOTA_CHAT_BYTES' };
    // Raw axios error
    expect(helpers.uploadErrorCode({ response: { data: body } })).toBe('QUOTA_CHAT_BYTES');
    // What `handleApiResponse` throws: the response only sits on `originalError`
    expect(
      helpers.uploadErrorCode(
        Object.assign(new Error('No room'), { originalError: { response: { data: body } } })
      )
    ).toBe('QUOTA_CHAT_BYTES');
    expect(
      helpers.uploadErrorCode(
        Object.assign(new Error('x'), {
          originalError: { response: { data: { error: 'x', code: 'NO_TEXT' } } }
        })
      )
    ).toBe('NO_TEXT');
    expect(helpers.uploadErrorCode(new Error('offline'))).toBe('FAILED');
  });
});

/** A composer: selection state plus the hook. */
function useComposer({ chatId = 'chat-1', app = {}, initial = null } = {}) {
  const [selectedFile, setSelectedFile] = useState(initial);
  const busy = useRef([]).current;
  const hook = useChatFilePreUpload({
    chatId,
    app,
    selectedFile,
    setSelectedFile,
    setAttachmentProcessing: (id, isBusy) => busy.push([id, isBusy])
  });
  return { selectedFile, setSelectedFile, busy, ...hook };
}

describe('useChatFilePreUpload', () => {
  beforeEach(() => {
    mockUpload.mockReset();
    mockDelete.mockReset().mockResolvedValue({ deleted: true });
    mockUploads = { enabled: true, storageMode: 'original_and_text' };
  });

  it('uploads an attached document, shows progress, and marks it stored', async () => {
    let finish;
    mockUpload.mockImplementation(
      (chatId, payload, options) =>
        new Promise(resolve => {
          options.onProgress(40);
          finish = () =>
            resolve({
              file: { id: 'file_9', hasOriginal: true, canUseAsTemplate: false, pages: 3 }
            });
        })
    );
    const entry = documentEntry();
    const { result } = renderHook(() => useComposer());
    act(() => result.current.setSelectedFile(entry));

    await waitFor(() => expect(result.current.selectedFile.uploadState).toBe('uploading'));
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][0]).toBe('chat-1');
    expect(mockUpload.mock.calls[0][1]).toBe(entry[ORIGINAL_FILE]);
    await waitFor(() => expect(result.current.selectedFile.uploadProgress).toBe(40));
    expect(result.current.busy).toContainEqual(['chat-file-upload', true]);

    await act(async () => finish());
    await waitFor(() => expect(result.current.selectedFile.fileId).toBe('file_9'));
    expect(result.current.selectedFile).toMatchObject({
      serverStored: true,
      uploadState: 'done',
      hasOriginal: true,
      pages: 3
    });
    expect(result.current.busy.at(-1)).toEqual(['chat-file-upload', false]);
  });

  it('uploads the extracted text only in client_text_only mode', async () => {
    mockUploads = { enabled: true, storageMode: 'client_text_only' };
    mockUpload.mockResolvedValue({ file: { id: 'file_1' } });
    const { result } = renderHook(() => useComposer());
    act(() => result.current.setSelectedFile(documentEntry()));
    await waitFor(() => expect(mockUpload).toHaveBeenCalled());
    expect(mockUpload.mock.calls[0][1]).toEqual({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      text: 'Extracted text',
      formatLabel: 'PDF'
    });
  });

  it('does nothing when uploads are off or there is no chat yet', async () => {
    mockUploads = { enabled: false };
    const off = renderHook(() => useComposer());
    act(() => off.result.current.setSelectedFile(documentEntry()));
    const noChat = renderHook(() => useComposer({ chatId: null }));
    mockUploads = { enabled: true };
    act(() => noChat.result.current.setSelectedFile(documentEntry()));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('keeps the file for an inline send when the server refuses it', async () => {
    mockUpload.mockRejectedValue({
      response: { status: 413, data: { details: { code: 'QUOTA_CHAT_FILES' } } }
    });
    const { result } = renderHook(() => useComposer());
    act(() => result.current.setSelectedFile(documentEntry()));
    await waitFor(() => expect(result.current.selectedFile.uploadState).toBe('error'));
    expect(result.current.selectedFile.uploadError).toBe('QUOTA_CHAT_FILES');
    expect(result.current.selectedFile.fileId).toBeUndefined();
    expect(helpers.splitFilesForWire(result.current.selectedFile).fileData).toBeTruthy();
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('does not upload a file twice when the uploader hands back a stale copy', async () => {
    mockUpload.mockResolvedValue({ file: { id: 'file_1' } });
    const entry = documentEntry();
    const { result } = renderHook(() => useComposer());
    act(() => result.current.setSelectedFile(entry));
    await waitFor(() => expect(result.current.selectedFile.fileId).toBe('file_1'));
    // A second file is added: the uploader reports [stale copy of the first, second].
    const second = documentEntry({ fileName: 'second.pdf', fileSize: 9 });
    mockUpload.mockResolvedValue({ file: { id: 'file_2' } });
    act(() => result.current.setSelectedFile([entry, second]));
    await waitFor(() =>
      expect(result.current.selectedFile.map(f => f.fileId)).toEqual(['file_1', 'file_2'])
    );
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('deletes the stored file when the user removes it from the composer', async () => {
    mockUpload.mockResolvedValue({ file: { id: 'file_1' } });
    const { result } = renderHook(() => useComposer());
    act(() => result.current.setSelectedFile(documentEntry()));
    await waitFor(() => expect(result.current.selectedFile.fileId).toBe('file_1'));
    act(() => result.current.handleFileSelect(null));
    expect(mockDelete).toHaveBeenCalledWith('chat-1', 'file_1');
    expect(result.current.selectedFile).toBeNull();
  });

  it('aborts an upload that is still running when the file is removed', async () => {
    let signal;
    mockUpload.mockImplementation((chatId, payload, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const { result } = renderHook(() => useComposer());
    act(() => result.current.setSelectedFile(documentEntry()));
    await waitFor(() => expect(signal).toBeDefined());
    act(() => result.current.handleFileSelect(null));
    expect(signal.aborted).toBe(true);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('AttachedFilesList upload state', () => {
  const base = { type: 'document', source: 'local', fileName: 'a.pdf', fileSize: 10 };

  it('shows a progress bar while uploading', () => {
    render(
      <AttachedFilesList
        files={[{ ...base, uploadState: 'uploading', uploadProgress: 55 }]}
        onRemoveFile={() => {}}
        onRemoveAll={() => {}}
      />
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '55');
  });

  it('says when the file is saved and when it can be a template', () => {
    render(
      <AttachedFilesList
        files={[{ ...base, uploadState: 'done', canUseAsTemplate: true }]}
        onRemoveFile={() => {}}
        onRemoveAll={() => {}}
      />
    );
    expect(screen.getByTestId('attached-file-stored')).toHaveTextContent('Saved to this chat');
    expect(screen.getByTestId('attached-file-stored')).toHaveTextContent(
      'can be used as a template'
    );
  });

  it('explains a refused upload without blocking the message', () => {
    render(
      <AttachedFilesList
        files={[{ ...base, uploadState: 'error', uploadError: 'QUOTA_USER_BYTES' }]}
        onRemoveFile={() => {}}
        onRemoveAll={() => {}}
      />
    );
    expect(screen.getByTestId('attached-file-upload-error')).toHaveTextContent('storage is full');
  });
});
