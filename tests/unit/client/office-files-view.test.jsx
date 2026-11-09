// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Files view of the Outlook task pane: a card of a message opens its file in the same Files
 * drawer the web app has, a stored picture's thumbnail can be fetched, and "Attach to email" is
 * there only in the Outlook host.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockFetchChatFiles = jest.fn();
const mockFetchChatArtifacts = jest.fn();
const mockFetchChatFileBlob = jest.fn();
jest.mock('../../../client/src/api', () => ({
  deleteChatFile: jest.fn(() => Promise.resolve()),
  downloadChatArtifactsZip: jest.fn(() => Promise.resolve(new Blob())),
  fetchChatArtifact: jest.fn(() => Promise.resolve(new Blob())),
  fetchChatArtifacts: (...args) => mockFetchChatArtifacts(...args),
  fetchChatFileBlob: (...args) => mockFetchChatFileBlob(...args),
  fetchChatFileText: jest.fn(() => Promise.resolve({ text: 'text' })),
  fetchChatFiles: (...args) => mockFetchChatFiles(...args)
}));

const mockMailAttachState = jest.fn(() => ({ supported: false, available: false }));
jest.mock('../../../client/src/features/chat/utils/attachToMail', () => ({
  attachStoredFileToMail: jest.fn(),
  mailAttachState: () => mockMailAttachState()
}));

// The drawer has its own suite (chat-files-drawer); here it only has to show what it was handed
const mockPanelProps = [];
jest.mock('../../../client/src/features/chat/components/ArtifactsPanel', () => ({
  __esModule: true,
  default: props => {
    mockPanelProps.push(props);
    return (
      <div data-testid="files-drawer">
        <span data-testid="drawer-file">{props.initialFileId}</span>
        <button type="button" onClick={props.onClose}>
          close drawer
        </button>
      </div>
    );
  }
}));

const OfficeFilesView =
  require('../../../client/src/features/office/components/chat/OfficeFilesView').default;
const { useChatFiles } = require('../../../client/src/features/chat/contexts/ChatFilesContext');

/** Stands in for a message card: asks the context to open a file, and to fetch one. */
function Card({ fileId = 'file_1' }) {
  const files = useChatFiles();
  return (
    <>
      <button type="button" onClick={() => files.openFile(fileId)}>
        open {fileId}
      </button>
      <button type="button" onClick={() => files.fetchBlob(fileId)}>
        fetch {fileId}
      </button>
    </>
  );
}

const lastPanel = () => mockPanelProps[mockPanelProps.length - 1];

beforeEach(() => {
  mockPanelProps.length = 0;
  mockFetchChatFiles.mockReset().mockResolvedValue({ items: [] });
  mockFetchChatArtifacts.mockReset().mockResolvedValue({ items: [] });
  mockFetchChatFileBlob.mockReset().mockResolvedValue(new Blob(['x']));
  mockMailAttachState.mockReset().mockReturnValue({ supported: false, available: false });
});

describe('OfficeFilesView', () => {
  test('shows no drawer until a card asks for a file', () => {
    render(
      <OfficeFilesView chatId="c1">
        <Card />
      </OfficeFilesView>
    );
    expect(screen.queryByTestId('files-drawer')).not.toBeInTheDocument();
  });

  test('a card opens its file in the drawer, on the uploaded files', async () => {
    render(
      <OfficeFilesView chatId="c1" messages={[{ role: 'user' }]}>
        <Card fileId="file_9" />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_9'));
    expect(await screen.findByTestId('files-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-file')).toHaveTextContent('file_9');
    expect(lastPanel()).toMatchObject({ isOpen: true, initialTab: 'uploaded' });
    expect(lastPanel().messages).toEqual([{ role: 'user' }]);
  });

  test('closing the drawer puts the chat back', async () => {
    render(
      <OfficeFilesView chatId="c1">
        <Card />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_1'));
    fireEvent.click(await screen.findByText('close drawer'));
    expect(screen.queryByTestId('files-drawer')).not.toBeInTheDocument();
  });

  test('the drawer reads the files of this chat, and a chat the server does not know has none', async () => {
    mockFetchChatFiles.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }));
    render(
      <OfficeFilesView chatId="office-fresh">
        <Card />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_1'));
    await screen.findByTestId('files-drawer');
    await expect(lastPanel().uploadedSource.list()).resolves.toEqual({ items: [] });
    expect(mockFetchChatFiles).toHaveBeenCalledWith('office-fresh');
    await lastPanel().source.list();
    expect(mockFetchChatArtifacts).toHaveBeenCalledWith('office-fresh');
  });

  test('other failures are not hidden', async () => {
    mockFetchChatFiles.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    render(
      <OfficeFilesView chatId="c1">
        <Card />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_1'));
    await screen.findByTestId('files-drawer');
    await expect(lastPanel().uploadedSource.list()).rejects.toThrow('boom');
  });

  test('a card can fetch the bytes of a stored picture', async () => {
    render(
      <OfficeFilesView chatId="c1">
        <Card fileId="file_img" />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('fetch file_img'));
    await waitFor(() => expect(mockFetchChatFileBlob).toHaveBeenCalledWith('c1', 'file_img'));
  });

  test('leaving the chat closes the drawer', async () => {
    const { rerender } = render(
      <OfficeFilesView chatId="c1">
        <Card />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_1'));
    await screen.findByTestId('files-drawer');
    rerender(
      <OfficeFilesView chatId="c2">
        <Card />
      </OfficeFilesView>
    );
    expect(screen.queryByTestId('files-drawer')).not.toBeInTheDocument();
  });

  test('has no "Attach to email" outside the Outlook host', async () => {
    render(
      <OfficeFilesView chatId="c1">
        <Card />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_1'));
    await screen.findByTestId('files-drawer');
    expect(lastPanel().mailAttach).toBeNull();
  });

  test('offers "Attach to email" in Outlook, and follows the open item', async () => {
    mockMailAttachState.mockReturnValue({ supported: true, available: false });
    render(
      <OfficeFilesView chatId="c1">
        <Card />
      </OfficeFilesView>
    );
    fireEvent.click(screen.getByText('open file_1'));
    await screen.findByTestId('files-drawer');
    expect(lastPanel().mailAttach).toMatchObject({ supported: true, available: false });
    expect(typeof lastPanel().mailAttach.attach).toBe('function');

    // The user opens a draft
    mockMailAttachState.mockReturnValue({ supported: true, available: true });
    act(() => {
      document.dispatchEvent(new Event('ihub:itemchanged'));
    });
    await waitFor(() => expect(lastPanel().mailAttach.available).toBe(true));
  });
});
