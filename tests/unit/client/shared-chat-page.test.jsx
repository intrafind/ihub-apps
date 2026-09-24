import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The read-only page behind `/share/:shareId`. Every successful open counts
 * as a view server-side, so what is pinned here is that the page opens a
 * link exactly once per visit — not again when the sign-in status settles
 * after the first answer, and not twice under StrictMode's double-run.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, options) => {
      if (typeof options === 'string') return options;
      if (options && typeof options === 'object') {
        return String(options.defaultValue ?? key)
          .replace('{{name}}', String(options.name ?? ''))
          .replace('{{date}}', String(options.date ?? ''));
      }
      return key;
    },
    i18n: { language: 'en' }
  })
}));

const auth = { isAuthenticated: false, isLoading: true };
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ ...auth })
}));

const mockApi = {
  fetchSharedChat: jest.fn(),
  fetchSharedChatArtifacts: jest.fn(),
  fetchSharedArtifact: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchSharedChat: (...args) => mockApi.fetchSharedChat(...args),
  fetchSharedChatArtifacts: (...args) => mockApi.fetchSharedChatArtifacts(...args),
  fetchSharedArtifact: (...args) => mockApi.fetchSharedArtifact(...args)
}));

// The transcript renderer has its own suites; here it only has to show that
// the messages arrived.
jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: ({ messages }) => (
    <ul data-testid="messages">
      {messages.map(m => (
        <li key={m.id}>{m.content}</li>
      ))}
    </ul>
  )
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// `useChatMessages` (for `transformStoredMessage`) imports the debug logger,
// which reads `import.meta`; the Jest transform cannot parse that.
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: () => <span>spinner</span>
}));

const SharedChatPage = require('../../../client/src/features/chat/pages/SharedChatPage').default;

const shareBody = {
  share: {
    id: 'shr_one',
    mode: 'authenticated',
    title: 'Quarterly numbers',
    appId: 'acme',
    app: { id: 'acme', name: { en: 'Acme' }, color: '#4f46e5', icon: 'chat' },
    createdAt: '2026-09-24T10:00:00.000Z',
    expiresAt: null,
    sharedBy: 'Ada Lovelace',
    messageCount: 2,
    readOnly: true
  },
  messages: [
    { id: 'm1', role: 'user', content: 'What were the numbers?', ts: '2026-09-24T10:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: 'Up and to the right.', ts: '2026-09-24T10:00:01.000Z' }
  ],
  version: 1
};

function mount() {
  return render(
    <MemoryRouter initialEntries={['/share/shr_one']}>
      <Routes>
        <Route path="/share/:shareId" element={<SharedChatPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockApi.fetchSharedChat.mockReset();
  mockApi.fetchSharedChatArtifacts.mockReset();
  mockApi.fetchSharedChat.mockResolvedValue(shareBody);
  mockApi.fetchSharedChatArtifacts.mockResolvedValue({ items: [] });
  auth.isAuthenticated = false;
  auth.isLoading = true;
});

test('waits for the sign-in status, then opens the link once — also when the status flips later', async () => {
  const view = mount();
  // While auth is still resolving nothing is fetched: an open made now would
  // be followed by another when the status settles.
  expect(mockApi.fetchSharedChat).not.toHaveBeenCalled();

  auth.isAuthenticated = true;
  auth.isLoading = false;
  view.rerender(
    <MemoryRouter initialEntries={['/share/shr_one']}>
      <Routes>
        <Route path="/share/:shareId" element={<SharedChatPage />} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getByText('Up and to the right.')).toBeInTheDocument());
  expect(mockApi.fetchSharedChat).toHaveBeenCalledTimes(1);

  // A later change of the sign-in flag must not open the link again.
  auth.isAuthenticated = false;
  await act(async () => {
    view.rerender(
      <MemoryRouter initialEntries={['/share/shr_one']}>
        <Routes>
          <Route path="/share/:shareId" element={<SharedChatPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
  expect(mockApi.fetchSharedChat).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Quarterly numbers')).toBeInTheDocument();
});

test('a link that needs a sign-in shows the sign-in state, and is retried after signing in', async () => {
  auth.isLoading = false;
  const denied = Object.assign(new Error('Sign in'), { status: 401 });
  mockApi.fetchSharedChat.mockRejectedValueOnce(denied).mockResolvedValueOnce(shareBody);

  const view = mount();
  await waitFor(() =>
    expect(screen.getByText('Sign in to open this shared chat')).toBeInTheDocument()
  );
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    expect.stringContaining('/login?returnUrl=')
  );
  expect(mockApi.fetchSharedChat).toHaveBeenCalledTimes(1);

  auth.isAuthenticated = true;
  view.rerender(
    <MemoryRouter initialEntries={['/share/shr_one']}>
      <Routes>
        <Route path="/share/:shareId" element={<SharedChatPage />} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getByText('Up and to the right.')).toBeInTheDocument());
  expect(mockApi.fetchSharedChat).toHaveBeenCalledTimes(2);
});

test('a dead link shows the one "no longer available" page', async () => {
  auth.isLoading = false;
  mockApi.fetchSharedChat.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
  mount();
  await waitFor(() =>
    expect(screen.getByText('This link is no longer available')).toBeInTheDocument()
  );
});
