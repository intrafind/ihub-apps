import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The sidebar's Recents section.
 *
 * Its rows carry the same actions as the full history page, but in a much
 * tighter target: the row is a link, the rename and delete buttons are
 * siblings of it, and on a phone the whole thing lives inside the navigation
 * drawer. What is pinned here is what that costs — a delete that has to hold
 * even if the refetch behind it fails, actions that must be visible where
 * there is no hover to reveal them, and exactly one link claiming to be the
 * current page.
 */

const mockT = (key, options) => {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object') {
    const template = options.defaultValue ?? key;
    return String(template)
      .replace('{{count}}', String(options.count ?? ''))
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

const mockApps = [
  { id: 'acme', name: { en: 'Acme' }, color: '#4f46e5', icon: 'chat', order: 1 },
  { id: 'legal-review', name: { en: 'Legal Review' }, color: '#059669', icon: 'chat', order: 2 }
];
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: mockApps, loading: false, error: null })
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u1', name: 'Ada' } })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: { chats: { persistence: true } }, isLoading: false })
}));
jest.mock('../../../client/src/shared/hooks/useAuthKey', () => ({
  __esModule: true,
  default: () => 'user:u1'
}));
const mockUiConfig = { uiConfig: {} };
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => mockUiConfig
}));
const mockFlags = {
  isEnabled: (_flag, fallback = false) => fallback,
  isBothEnabled: (_app, _flag, fallback = false) => fallback,
  isAppFeatureEnabled: (_app, _path, fallback = false) => fallback
};
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => mockFlags
}));
jest.mock('../../../client/src/shared/hooks/useMediaQuery', () => ({
  __esModule: true,
  default: () => true
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/IHubLogo', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/BrandTitle', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/LanguageSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/DarkModeToggle', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/auth/components/UserAuthMenu', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildAssetUrl: path => `/${path}`,
  buildApiUrl: path => `/api/${path}`
}));

const AppSidebar = require('../../../client/src/shared/components/AppSidebar').default;
const { invalidateChatsCache } = require('../../../client/src/shared/hooks/useChats');

const chatDoc = (id, title, appId = 'acme') => ({
  id,
  appId,
  title,
  messageCount: 2,
  lastMessageAt: new Date().toISOString(),
  hasUnseenActivity: false
});

/** Mount the sidebar at one location and wait for the chat list. */
async function renderSidebar(path = '/apps/acme') {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AppSidebar />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockApi.fetchChats).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  invalidateChatsCache();
  localStorage.clear();
  mockApi.fetchChats.mockReset();
  mockApi.renameChat.mockReset();
  mockApi.deleteChat.mockReset();
  mockApi.fetchChats.mockResolvedValue({
    items: [chatDoc('chat-1', 'First chat'), chatDoc('chat-2', 'Second chat', 'legal-review')],
    nextCursor: null
  });
  mockApi.deleteChat.mockResolvedValue({ deleted: true });
});

describe('the row actions', () => {
  test('are visible on a touch device, where nothing can hover them out of hiding', async () => {
    // `opacity-0` still lays out and still takes taps, and `group-hover:` is
    // compiled behind `@media (hover: hover)`, so without a touch fallback the
    // right edge of every Recents row is an invisible 56px strip that deletes
    // the chat the user meant to open. The history page already does this.
    const { container } = await renderSidebar();
    await waitFor(() => expect(screen.getByText('First chat')).toBeInTheDocument());

    const rename = container.querySelector('[aria-label="Rename chat"]');
    const remove = container.querySelector('[aria-label="Delete chat"]');

    expect(rename.className).toContain('opacity-0');
    expect(rename.className).toContain('max-md:opacity-100');
    expect(remove.className).toContain('opacity-0');
    expect(remove.className).toContain('max-md:opacity-100');
  });
});

describe('deleting a chat from the sidebar', () => {
  test('the row goes at once and stays gone when the refetch fails', async () => {
    // The DELETE succeeded, so there is no error to show. Leaning on the
    // refetch alone leaves the deleted chat in Recents for the rest of the
    // session — and clicking it opens a blank chat under a dead id.
    const { container } = await renderSidebar();
    await waitFor(() => expect(screen.getByText('First chat')).toBeInTheDocument());

    mockApi.fetchChats.mockRejectedValue(new Error('offline'));

    const remove = container.querySelector('[aria-label="Delete chat"]');
    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = screen.getByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      b => b.textContent === 'Delete'
    );
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(screen.queryByText('First chat')).toBeNull());
    expect(screen.getByText('Second chat')).toBeInTheDocument();
  });
});

describe('which link says it is the current page', () => {
  test('only the chat row, not the app row it is nested under', async () => {
    // `/apps/acme/c/chat-1` matches the app row's prefix test as well. Two
    // links with different hrefs both announcing "current page" tells a
    // screen-reader user nothing about where they are.
    const { container } = await renderSidebar('/apps/acme/c/chat-1');
    await waitFor(() => expect(screen.getByText('First chat')).toBeInTheDocument());

    const current = Array.from(container.querySelectorAll('[aria-current="page"]'));
    expect(current.map(el => el.getAttribute('href'))).toEqual(['/apps/acme/c/chat-1']);
  });

  test('the app row still says so on the app route itself', async () => {
    const { container } = await renderSidebar('/apps/acme');
    await waitFor(() => expect(screen.getByText('First chat')).toBeInTheDocument());

    const current = Array.from(container.querySelectorAll('[aria-current="page"]'));
    expect(current.map(el => el.getAttribute('href'))).toEqual(['/apps/acme']);
  });
});
