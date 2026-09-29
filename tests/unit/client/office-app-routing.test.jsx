import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Where the Outlook task pane lands after sign-in (issue #2368): the start
 * page by default, the app list when the admin picked it — and a chat that was
 * left open in this session stays open either way.
 *
 * With durable chats on, the pane also has a chat history (issue #2598): a
 * stored chat opens in the chat panel, and the history's back button returns
 * to the chat it was opened from.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/features/office/api/officeAuth', () => ({
  OFFICE_TOKEN_KEY: 'office_ihubtoken',
  storeTokenResponse: jest.fn(),
  clearTokens: jest.fn(),
  fetchUserInfo: jest.fn(),
  setOnSessionExpired: jest.fn()
}));

let mockOfficeConfig = {};
jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => mockOfficeConfig
}));

jest.mock('../../../client/src/features/office/components/OfficeLogin', () => ({
  __esModule: true,
  default: () => <div>LOGIN</div>
}));
const mockMountedLists = { count: 0 };
jest.mock('../../../client/src/features/office/components/OfficeStartPage', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ chatHistoryEnabled, onOpenHistory, onLogout }) => {
      // Stands in for the chat list the real start page keeps mounted.
      React.useEffect(() => {
        mockMountedLists.count += 1;
        return () => {
          mockMountedLists.count -= 1;
        };
      }, []);
      return (
        <div>
          START PAGE history={String(!!chatHistoryEnabled)}
          {onOpenHistory && (
            <button type="button" onClick={onOpenHistory}>
              start: history
            </button>
          )}
          <button type="button" onClick={onLogout}>
            start: logout
          </button>
        </div>
      );
    }
  };
});
jest.mock('../../../client/src/features/office/components/OfficeChatPanel', () => ({
  __esModule: true,
  default: ({ selectedApp, homePath, chatPersistence, openChatId, onOpenHistory }) => (
    <div>
      CHAT {selectedApp?.id} home={homePath} stored={String(chatPersistence)} open=
      {openChatId ?? 'new'}
      {onOpenHistory && (
        <button type="button" onClick={() => onOpenHistory({ returnChatId: 'chat-1' })}>
          chat: history
        </button>
      )}
    </div>
  )
}));
jest.mock('../../../client/src/features/office/components/chat-history', () => ({
  __esModule: true,
  default: ({ onBack, backLabel, onOpenChat }) => (
    <div>
      HISTORY
      <button type="button" onClick={onBack}>
        {backLabel}
      </button>
      <button
        type="button"
        onClick={() => onOpenChat({ chat: { id: 'chat-9' }, app: { id: 'mail' } })}
      >
        history: open chat-9
      </button>
    </div>
  )
}));

let mockChatPersistence = { persistence: false, resolving: false };
jest.mock('../../../client/src/features/office/hooks/useOfficeChatPersistence', () => ({
  __esModule: true,
  default: signedIn => (signedIn ? mockChatPersistence : { persistence: false, resolving: false })
}));
const mockInvalidations = [];
jest.mock('../../../client/src/shared/hooks/chatListStore', () => ({
  // Records how many chat lists were still mounted when the cache was dropped.
  invalidateChatsCache: () => mockInvalidations.push(mockMountedLists.count)
}));
jest.mock('../../../client/src/shared/components/AppListPanel', () => ({
  __esModule: true,
  default: ({ header }) => (
    <div>
      {header}
      APP LIST
    </div>
  )
}));

const OfficeApp = require('../../../client/src/features/office/components/OfficeApp').default;

const renderApp = () =>
  render(
    <MemoryRouter>
      <OfficeApp />
    </MemoryRouter>
  );

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockOfficeConfig = {};
  mockChatPersistence = { persistence: false, resolving: false };
  mockInvalidations.length = 0;
});

test('signed out: the login screen, whatever the setting', () => {
  mockOfficeConfig = { startPage: { defaultPage: 'apps' } };
  renderApp();
  expect(screen.getByText('LOGIN')).toBeInTheDocument();
});

test('signed in: the start page is home by default', () => {
  localStorage.setItem('office_ihubtoken', 'token');
  renderApp();
  expect(screen.getByText(/START PAGE/)).toBeInTheDocument();
});

test('signed in: the app list is home when the admin picked it, with no way "back"', () => {
  localStorage.setItem('office_ihubtoken', 'token');
  mockOfficeConfig = { startPage: { defaultPage: 'apps' } };
  renderApp();
  expect(screen.getByText('APP LIST')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Back to start page' })).not.toBeInTheDocument();
});

test('an app left open in this session stays open and its back button leads home', () => {
  localStorage.setItem('office_ihubtoken', 'token');
  sessionStorage.setItem('office_ihubselectedapp', JSON.stringify({ id: 'chat' }));
  renderApp();
  expect(screen.getByText(/CHAT chat home=\/start/)).toBeInTheDocument();
});

describe('chat history (durable chats)', () => {
  beforeEach(() => {
    localStorage.setItem('office_ihubtoken', 'token');
  });

  test('without durable chats there is no history, and chats are not stored', () => {
    sessionStorage.setItem('office_ihubselectedapp', JSON.stringify({ id: 'chat' }));
    renderApp();
    expect(screen.getByText(/CHAT chat home=\/start stored=false/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'chat: history' })).not.toBeInTheDocument();
  });

  test('an open app waits until the pane knows whether chats are stored', () => {
    mockChatPersistence = { persistence: false, resolving: true };
    sessionStorage.setItem('office_ihubselectedapp', JSON.stringify({ id: 'chat' }));
    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText(/CHAT chat/)).not.toBeInTheDocument();
  });

  test('from a chat: the history opens, and back returns to that chat', () => {
    mockChatPersistence = { persistence: true, resolving: false };
    sessionStorage.setItem('office_ihubselectedapp', JSON.stringify({ id: 'chat' }));
    renderApp();
    expect(screen.getByText(/stored=true open=new/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'chat: history' }));
    expect(screen.getByText('HISTORY')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.getByText(/CHAT chat home=\/start stored=true open=chat-1/)).toBeInTheDocument();
  });

  test('from the start page: back leads home', () => {
    mockChatPersistence = { persistence: true, resolving: false };
    renderApp();
    expect(screen.getByText('START PAGE history=true')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'start: history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to start page' }));
    expect(screen.getByText(/START PAGE/)).toBeInTheDocument();
  });

  test('a chat picked in the history opens in its own app', () => {
    mockChatPersistence = { persistence: true, resolving: false };
    sessionStorage.setItem('office_ihubselectedapp', JSON.stringify({ id: 'chat' }));
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'chat: history' }));
    fireEvent.click(screen.getByRole('button', { name: 'history: open chat-9' }));

    expect(screen.getByText(/CHAT mail home=\/start stored=true open=chat-9/)).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('office_ihubselectedapp'))).toEqual({ id: 'mail' });
  });

  test('logging out drops the chat list only once no list is mounted', () => {
    mockChatPersistence = { persistence: true, resolving: false };
    renderApp();
    expect(screen.getByText(/START PAGE/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'start: logout' }));
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    // Dropping it under a mounted list refetches it at once, without a token,
    // and the 401 would sign the user out a second time as "session expired".
    expect(mockInvalidations.length).toBeGreaterThan(0);
    expect(mockInvalidations.every(mounted => mounted === 0)).toBe(true);
  });
});
