import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The "Shared with me" tab on `/chats`. It once never left its loading
 * skeleton: the effect that fetched the list set `loading: true`, which was
 * one of its own dependencies, so it re-ran, its cleanup cancelled the fetch
 * it had just started, and the answer went to a dead closure. This pins that
 * one click on the tab shows the rows.
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
      .replace('{{name}}', String(options.name ?? ''))
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
  deleteChat: jest.fn(),
  fetchSharesWithMe: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChats: (...args) => mockApi.fetchChats(...args),
  renameChat: (...args) => mockApi.renameChat(...args),
  deleteChat: (...args) => mockApi.deleteChat(...args),
  fetchSharesWithMe: (...args) => mockApi.fetchSharesWithMe(...args)
}));

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u1' } })
}));
const platform = { chats: { persistence: true, sharing: { enabled: true } } };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: platform, isLoading: false })
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

beforeEach(() => {
  platform.chats = { persistence: true, sharing: { enabled: true } };
  invalidateChatsCache();
  mockApi.fetchChats.mockReset();
  mockApi.fetchSharesWithMe.mockReset();
  mockApi.fetchChats.mockResolvedValue({ items: [], nextCursor: null });
  mockApi.fetchSharesWithMe.mockResolvedValue({
    items: [
      {
        id: 'shr_one',
        mode: 'users',
        title: 'Shared budget chat',
        appId: 'acme',
        app: { name: { en: 'Acme' }, color: '#4f46e5', icon: 'chat' },
        createdAt: new Date().toISOString(),
        sharedBy: 'Ada Lovelace',
        messageCount: 4,
        viewed: false
      }
    ]
  });
});

test('the Shared with me tab loads and lists what was shared', async () => {
  render(
    <MemoryRouter>
      <ChatHistoryPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockApi.fetchChats).toHaveBeenCalled());

  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Shared with me' }));
  });

  await waitFor(() => expect(screen.getByText('Shared budget chat')).toBeInTheDocument());
  expect(screen.getByText('Shared by Ada Lovelace · 4 messages')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Shared budget chat/ })).toHaveAttribute(
    'href',
    '/share/shr_one'
  );
  expect(mockApi.fetchSharesWithMe).toHaveBeenCalledTimes(1);
});

test('the tab is not offered while sharing is off', async () => {
  platform.chats = { persistence: true };
  render(
    <MemoryRouter>
      <ChatHistoryPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockApi.fetchChats).toHaveBeenCalled());
  expect(screen.queryByRole('tab', { name: 'Shared with me' })).not.toBeInTheDocument();
});
