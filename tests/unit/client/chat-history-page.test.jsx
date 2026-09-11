import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The full chat list at `/chats`: what it claims about the list, what it does
 * to the shared cache when a row is renamed or deleted, and where the keyboard
 * ends up afterwards.
 *
 * The list, the confirmation dialog, the inline rename and the shared chat
 * cache are all real here — the point of most of these is how the four
 * interact. Only the network, the contexts the cache gates on, and `Icon` are
 * stubbed.
 */

const mockT = (key, options) => {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object') {
    const count = options.count;
    const plural =
      count === 1 ? options.defaultValue_one : (options.defaultValue_other ?? options.defaultValue);
    const template = plural ?? options.defaultValue ?? key;
    return String(template)
      .replace('{{count}}', String(count))
      .replace('{{title}}', String(options.title ?? ''));
  }
  return key;
};
const mockTranslation = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockTranslation
}));

const mockApi = {
  fetchChats: jest.fn(),
  renameChat: jest.fn(),
  deleteChat: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChats: (...args) => mockApi.fetchChats(...args),
  renameChat: (...args) => mockApi.renameChat(...args),
  deleteChat: (...args) => mockApi.deleteChat(...args)
}));

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u1' } })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: { chats: { persistence: true } }, isLoading: false })
}));
jest.mock('../../../client/src/shared/hooks/useAuthKey', () => ({
  __esModule: true,
  default: () => 'user:u1'
}));
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [{ id: 'acme', name: { en: 'Acme' }, color: '#4f46e5', icon: 'chat' }] })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ChatHistoryPage = require('../../../client/src/features/chat/pages/ChatHistoryPage').default;
const { invalidateChatsCache } = require('../../../client/src/shared/hooks/useChats');

const chatDoc = (id, title) => ({
  id,
  appId: 'acme',
  title,
  messageCount: 2,
  lastMessageAt: new Date().toISOString(),
  hasUnseenActivity: false
});

/** Mount the page and wait for the first page of chats. */
async function renderPage() {
  const view = render(
    <MemoryRouter>
      <ChatHistoryPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockApi.fetchChats).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  invalidateChatsCache();
  mockApi.fetchChats.mockReset();
  mockApi.renameChat.mockReset();
  mockApi.deleteChat.mockReset();
  mockApi.fetchChats.mockResolvedValue({
    items: [chatDoc('chat-1', 'Q3 budget'), chatDoc('chat-2', 'Second chat')],
    nextCursor: null
  });
  mockApi.deleteChat.mockResolvedValue({ deleted: true });
});

describe('the header count', () => {
  test('says how many are loaded, not that the page size is the total', async () => {
    // A cursor-paged API has no cheap total. Printing the page size as one puts
    // "30 conversations" directly above a "Show older chats" button, and the
    // stated total then grows by 30 on every click.
    mockApi.fetchChats.mockResolvedValue({
      items: [chatDoc('chat-1', 'One'), chatDoc('chat-2', 'Two')],
      nextCursor: 'cursor-2'
    });
    await renderPage();

    await waitFor(() =>
      expect(screen.getByText('2+ conversations across your apps')).toBeInTheDocument()
    );
    expect(screen.getByText('Show older chats')).toBeInTheDocument();
  });

  test('a search with no matches can still widen itself', async () => {
    // Search filters the chats that are paged in, and nothing else. The only
    // control that fetches more used to live in the branch that renders when
    // there *are* results, so a user looking for their two-hundredth chat was
    // told "No chats match your search" with no way to look further — and the
    // wording asserted that the search had covered everything.
    mockApi.fetchChats.mockResolvedValue({
      items: [chatDoc('chat-1', 'Q3 budget'), chatDoc('chat-2', 'Second chat')],
      nextCursor: 'cursor-2'
    });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Q3 budget')).toBeInTheDocument());

    const search = screen.getByLabelText('Search your chats…');
    await act(async () => {
      fireEvent.change(search, { target: { value: 'nothing matches this' } });
    });

    expect(
      screen.getByText('No chats match your search in the ones loaded so far')
    ).toBeInTheDocument();
    expect(screen.getByText('Show older chats')).toBeInTheDocument();
  });

  test('states the count plainly once there is nothing more to fetch', async () => {
    await renderPage();

    await waitFor(() =>
      expect(screen.getByText('2 conversations across your apps')).toBeInTheDocument()
    );
    expect(screen.queryByText('Show older chats')).toBeNull();
  });
});

describe('renaming a chat', () => {
  test('the stored title wins over what was typed, and keeps winning', async () => {
    // The server normalizes a title (whitespace collapsed, length capped) and
    // another surface can rename the same chat. A private copy of the typed
    // text on this page would outlive the refetch and mask both.
    mockApi.renameChat.mockResolvedValue({ chat: { id: 'chat-1', title: 'Q3 budget review' } });
    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('Q3 budget')).toBeInTheDocument());

    const renameButton = container.querySelector('[aria-label="Rename chat"]');
    await act(async () => {
      fireEvent.click(renameButton);
    });
    const input = screen.getByLabelText('Chat title');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Q3  budget   review' } });
    });

    // The refetch that follows reports what the server actually stored.
    mockApi.fetchChats.mockResolvedValue({
      items: [chatDoc('chat-1', 'Q3 budget review'), chatDoc('chat-2', 'Second chat')],
      nextCursor: null
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    // `normalizer` off: the point is the *stored* spelling, and the default
    // matcher collapses runs of whitespace, which would hide the difference.
    const exact = { normalizer: text => text };
    await waitFor(() => expect(screen.getByText('Q3 budget review', exact)).toBeInTheDocument());
    expect(screen.queryByText('Q3  budget   review', exact)).toBeNull();

    // A later rename from another surface reaches the shared cache; this page
    // must not be holding an override in front of it.
    await act(async () => {
      mockApi.fetchChats.mockResolvedValue({
        items: [chatDoc('chat-1', 'Q4 plan'), chatDoc('chat-2', 'Second chat')],
        nextCursor: null
      });
      invalidateChatsCache();
    });

    await waitFor(() => expect(screen.getByText('Q4 plan')).toBeInTheDocument());
  });

  test('abandoning a rename hands the keyboard back to the button that opened it', async () => {
    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('Q3 budget')).toBeInTheDocument());

    const renameButton = container.querySelector('[aria-label="Rename chat"]');
    renameButton.focus();
    await act(async () => {
      fireEvent.click(renameButton);
    });
    expect(document.activeElement).toBe(screen.getByLabelText('Chat title'));

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Chat title'), { key: 'Escape' });
    });

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Rename chat"]'));
  });
});

describe('deleting a chat', () => {
  test('keeps the keyboard in the list and says what happened', async () => {
    // The row that owns the focused Delete button unmounts in the same commit
    // as the dialog, so the dialog's focus trap restores focus onto a detached
    // node and the document ends up focused on <body>: the next Tab restarts
    // at the top of the page and nothing announces the deletion.
    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('Q3 budget')).toBeInTheDocument());
    // The server really does remove it, so the refetch that follows agrees.
    mockApi.deleteChat.mockImplementation(async () => {
      mockApi.fetchChats.mockResolvedValue({
        items: [chatDoc('chat-2', 'Second chat')],
        nextCursor: null
      });
      return { deleted: true };
    });

    const deleteButton = container.querySelector('[aria-label="Delete chat"]');
    deleteButton.focus();
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    const dialog = screen.getByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      b => b.textContent === 'Delete'
    );
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(screen.queryByText('Q3 budget')).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('status')).toHaveTextContent('Chat deleted');
  });

  test('the row stays gone even when the follow-up refetch fails', async () => {
    // The DELETE succeeded, so there is no error to show; leaning on the
    // refetch alone puts the deleted chat back on screen for the session.
    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('Q3 budget')).toBeInTheDocument());

    mockApi.fetchChats.mockRejectedValue(new Error('offline'));

    const deleteButton = container.querySelector('[aria-label="Delete chat"]');
    await act(async () => {
      fireEvent.click(deleteButton);
    });
    const dialog = screen.getByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      b => b.textContent === 'Delete'
    );
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(screen.queryByText('Q3 budget')).toBeNull());
    expect(screen.getByText('Second chat')).toBeInTheDocument();
  });
});
