// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Slice 3 (#3159): the share dialog's control over uploaded files
 * (`uploadedFilesAccess`, `sharedFileIds`), the file chips of a message that open
 * the Files drawer, and the scheduled task editor's attached files.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) => {
      const template =
        typeof defaultValue === 'string' ? defaultValue : (defaultValue?.defaultValue ?? key);
      return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String((options ?? defaultValue)?.[name] ?? '')
      );
    },
    i18n: { language: 'en' }
  })
}));

const mockApi = {
  fetchChatShares: jest.fn(),
  fetchChatFiles: jest.fn(),
  createChatShare: jest.fn(),
  lookupUsers: jest.fn(),
  revokeChatShare: jest.fn(),
  fetchScheduledTaskFiles: jest.fn(),
  uploadScheduledTaskFile: jest.fn(),
  deleteScheduledTaskFile: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChatShares: (...args) => mockApi.fetchChatShares(...args),
  fetchChatFiles: (...args) => mockApi.fetchChatFiles(...args),
  createChatShare: (...args) => mockApi.createChatShare(...args),
  lookupUsers: (...args) => mockApi.lookupUsers(...args),
  revokeChatShare: (...args) => mockApi.revokeChatShare(...args),
  fetchScheduledTaskFiles: (...args) => mockApi.fetchScheduledTaskFiles(...args),
  uploadScheduledTaskFile: (...args) => mockApi.uploadScheduledTaskFile(...args),
  deleteScheduledTaskFile: (...args) => mockApi.deleteScheduledTaskFile(...args)
}));

let mockPlatformConfig = {
  chats: {
    sharing: {
      enabled: true,
      allowUsers: true,
      allowAuthenticated: true,
      allowPublic: false
    }
  },
  uploads: { enabled: true, storageMode: 'original_and_text' }
};
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildPath: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid={`icon-${name}`} />
}));

const ChatSharePanel =
  require('../../../client/src/features/chat/components/ChatSharePanel').default;
const TaskFilesSection =
  require('../../../client/src/features/tasks/components/TaskFilesSection').default;
const {
  taskFileErrorText
} = require('../../../client/src/features/tasks/components/TaskFilesSection');

const FILES = [
  { id: 'file_a', name: 'plan.docx', hasOriginal: true },
  { id: 'file_b', name: 'salaries.csv', hasOriginal: false }
];

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchChatShares.mockResolvedValue({ items: [] });
  mockApi.fetchChatFiles.mockResolvedValue({ items: FILES });
  mockApi.createChatShare.mockResolvedValue({ share: { id: 'shr_1', mode: 'authenticated' } });
  mockApi.fetchScheduledTaskFiles.mockResolvedValue({ items: [] });
});

describe('ChatSharePanel: files you uploaded', () => {
  it('shares no file by default and offers the choice only when the chat has files', async () => {
    mockApi.fetchChatFiles.mockResolvedValue({ items: [] });
    const { unmount } = render(<ChatSharePanel chatId="chat-1" />);
    await waitFor(() => expect(mockApi.fetchChatFiles).toHaveBeenCalledWith('chat-1'));
    expect(screen.queryByTestId('share-files-access')).not.toBeInTheDocument();
    unmount();

    mockApi.fetchChatFiles.mockResolvedValue({ items: FILES });
    render(<ChatSharePanel chatId="chat-1" />);
    const group = await screen.findByTestId('share-files-access');
    expect(within(group).getByLabelText(/Do not share the files/)).toBeChecked();
    expect(within(group).queryByRole('list')).not.toBeInTheDocument();
  });

  it('sends no file fields while "do not share" is chosen', async () => {
    render(<ChatSharePanel chatId="chat-1" />);
    await screen.findByTestId('share-files-access');
    fireEvent.click(screen.getByRole('button', { name: /Create link/i }));
    await waitFor(() => expect(mockApi.createChatShare).toHaveBeenCalled());
    expect(mockApi.createChatShare.mock.calls[0][1]).not.toHaveProperty('uploadedFilesAccess');
    expect(mockApi.createChatShare.mock.calls[0][1]).not.toHaveProperty('sharedFileIds');
  });

  it('shares the text of the ticked files only', async () => {
    render(<ChatSharePanel chatId="chat-1" />);
    const group = await screen.findByTestId('share-files-access');
    fireEvent.click(within(group).getByLabelText(/Share the text of the files/));
    const list = within(group).getByRole('list', { name: 'Files to share' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(within(list).getByLabelText('salaries.csv'));

    fireEvent.click(screen.getByRole('button', { name: /Create link/i }));
    await waitFor(() => expect(mockApi.createChatShare).toHaveBeenCalled());
    expect(mockApi.createChatShare.mock.calls[0][1]).toMatchObject({
      uploadedFilesAccess: 'extracted_text',
      sharedFileIds: ['file_a']
    });
  });

  it('marks files that have no original and disables "original" when none has one', async () => {
    mockApi.fetchChatFiles.mockResolvedValue({ items: [FILES[1]] });
    render(<ChatSharePanel chatId="chat-1" />);
    const group = await screen.findByTestId('share-files-access');
    expect(within(group).getByLabelText(/Share the original files/)).toBeDisabled();
  });

  it('can share the originals, and says which file is text only', async () => {
    render(<ChatSharePanel chatId="chat-1" />);
    const group = await screen.findByTestId('share-files-access');
    fireEvent.click(within(group).getByLabelText(/Share the original files/));
    expect(within(group).getByText('(text only)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Create link/i }));
    await waitFor(() => expect(mockApi.createChatShare).toHaveBeenCalled());
    expect(mockApi.createChatShare.mock.calls[0][1]).toMatchObject({
      uploadedFilesAccess: 'original',
      sharedFileIds: ['file_a', 'file_b']
    });
  });
});

describe('TaskFilesSection', () => {
  it('lists the files of a saved task with their storage state', async () => {
    mockApi.fetchScheduledTaskFiles.mockResolvedValue({
      items: [
        {
          id: 'file_1',
          name: 'style-guide.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: 2048,
          hasOriginal: true,
          canUseAsTemplate: true
        },
        { id: 'file_2', name: 'notes.txt', mimeType: 'text/plain', bytes: 10, hasOriginal: false }
      ]
    });
    render(<TaskFilesSection taskId="task_1" />);
    const section = await screen.findByTestId('task-files-section');
    expect(await within(section).findByText('style-guide.docx')).toBeInTheDocument();
    expect(section).toHaveTextContent('DOCX');
    expect(section).toHaveTextContent('Original saved');
    expect(section).toHaveTextContent('usable as a template');
    expect(section).toHaveTextContent('Text only');
  });

  it('uploads picked files to the task one by one and shows what the server refused', async () => {
    mockApi.uploadScheduledTaskFile
      .mockResolvedValueOnce({ file: { id: 'file_1' } })
      .mockRejectedValueOnce({ response: { data: { details: { code: 'QUOTA_CHAT_FILES' } } } });
    render(<TaskFilesSection taskId="task_1" />);
    await screen.findByTestId('task-files-section');
    const input = screen.getByTestId('task-files-input');
    const first = new File(['a'], 'a.txt', { type: 'text/plain' });
    const second = new File(['b'], 'b.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [first, second] } });
    await waitFor(() => expect(mockApi.uploadScheduledTaskFile).toHaveBeenCalledTimes(2));
    expect(mockApi.uploadScheduledTaskFile.mock.calls[0]).toEqual(['task_1', first]);
    expect(await screen.findByTestId('task-files-error')).toHaveTextContent(
      'b.txt: This task has reached its limit for attached files.'
    );
  });

  it('removes a file from the task', async () => {
    mockApi.fetchScheduledTaskFiles.mockResolvedValue({
      items: [{ id: 'file_1', name: 'a.txt', mimeType: 'text/plain', bytes: 1 }]
    });
    mockApi.deleteScheduledTaskFile.mockResolvedValue({ deleted: true });
    render(<TaskFilesSection taskId="task_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove a.txt' }));
    await waitFor(() =>
      expect(mockApi.deleteScheduledTaskFile).toHaveBeenCalledWith('task_1', 'file_1')
    );
  });

  it('holds the files of a task that does not exist yet until it is saved', async () => {
    const onStagedChange = jest.fn();
    const file = new File(['x'], 'template.docx', { type: 'application/octet-stream' });
    const { rerender } = render(
      <TaskFilesSection taskId={null} staged={[]} onStagedChange={onStagedChange} />
    );
    fireEvent.change(screen.getByTestId('task-files-input'), { target: { files: [file] } });
    expect(onStagedChange).toHaveBeenCalledWith([file]);
    expect(mockApi.uploadScheduledTaskFile).not.toHaveBeenCalled();
    expect(mockApi.fetchScheduledTaskFiles).not.toHaveBeenCalled();

    rerender(<TaskFilesSection taskId={null} staged={[file]} onStagedChange={onStagedChange} />);
    expect(screen.getByText('template.docx')).toBeInTheDocument();
    expect(screen.getByText('The files are attached when you save the task.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove template.docx' }));
    expect(onStagedChange).toHaveBeenLastCalledWith([]);
  });

  it('stays out of the way when uploads are off, and cannot attach where only text is kept', async () => {
    mockPlatformConfig = { ...mockPlatformConfig, uploads: { enabled: false } };
    const off = render(<TaskFilesSection taskId="task_1" />);
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();

    mockPlatformConfig = {
      ...mockPlatformConfig,
      uploads: { enabled: true, storageMode: 'client_text_only' }
    };
    render(<TaskFilesSection taskId="task_1" />);
    expect(await screen.findByRole('button', { name: /Attach files/ })).toBeDisabled();
    mockPlatformConfig = {
      ...mockPlatformConfig,
      uploads: { enabled: true, storageMode: 'original_and_text' }
    };
  });

  it('words the codes the server answers with', () => {
    const t = (key, fallback) => fallback;
    expect(taskFileErrorText('QUOTA_FILE_BYTES', t)).toMatch(/too large/);
    expect(taskFileErrorText('QUOTA_USER_BYTES', t)).toMatch(/storage is full/);
    expect(taskFileErrorText('UNSUPPORTED_TYPE', t)).toMatch(/not supported/);
    expect(taskFileErrorText('SCAN_REJECTED', t)).toMatch(/security scan/);
    expect(taskFileErrorText('SOMETHING_ELSE', t)).toMatch(/could not be attached/);
  });
});
