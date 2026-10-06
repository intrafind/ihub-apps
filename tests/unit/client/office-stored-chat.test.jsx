import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Durable chats in the Outlook task pane (issue #2598).
 *
 * With durable chats on, the pane's chats are stored like the web app's, so a
 * conversation can be picked up again later — in the pane or in the browser —
 * and a chat from the history opens in the pane with its transcript. Pinned
 * here:
 *
 * - how the pane learns whether chats are stored (the public platform config),
 * - how a stored chat is put back on screen (fetched once, re-attached to a
 *   turn that is still running, its settings handed back) and how a new one
 *   is not (no fetch for a chat that was never sent),
 * - the chat panel's side: which chat it opens, when it waits, and the way to
 *   the history,
 * - "Open in web app" (issue #2591): a stored chat continues in the browser at
 *   the web app's own chat route; one that is not stored is handed over
 *   through a one-time server-side hand-off.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  processDocumentFile: jest.fn(),
  resizeImageCanvas: jest.fn()
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform
// cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

const mockFetchChat = jest.fn();
const mockFetchPlatformConfig = jest.fn();
const mockCreateChatHandoff = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchApps: jest.fn(() => Promise.resolve([])),
  fetchChat: (...args) => mockFetchChat(...args),
  createChatHandoff: (...args) => mockCreateChatHandoff(...args),
  fetchPlatformConfig: (...args) => mockFetchPlatformConfig(...args)
}));

const mockInvalidateChatsCache = jest.fn();
jest.mock('../../../client/src/shared/hooks/chatListStore', () => ({
  invalidateChatsCache: () => mockInvalidateChatsCache()
}));

jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => ({
    baseUrl: 'https://ihub.example.com/ihub',
    starterPrompts: [],
    calendarStarterPrompts: []
  })
}));

const mockOpenExternalUrl = jest.fn(() => Promise.resolve(true));
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  ...jest.requireActual('../../../client/src/utils/externalNavigation'),
  openExternalUrlSettled: (...args) => mockOpenExternalUrl(...args)
}));

const useStoredChatHydration =
  require('../../../client/src/features/office/hooks/useStoredChatHydration').default;
const useOfficeChatPersistence =
  require('../../../client/src/features/office/hooks/useOfficeChatPersistence').default;
const {
  buildWebChatUrl
} = require('../../../client/src/features/office/utilities/officeChatHistory');

const flush = () => act(async () => {});

function makeChat(overrides = {}) {
  return {
    messages: [],
    processing: false,
    finishHydration: jest.fn(),
    loadServerMessages: jest.fn(),
    reattachToRun: jest.fn(),
    ...overrides
  };
}

beforeEach(() => {
  mockFetchChat.mockReset();
  mockFetchPlatformConfig.mockReset();
  mockInvalidateChatsCache.mockReset();
  mockOpenExternalUrl.mockReset();
  mockOpenExternalUrl.mockResolvedValue(true);
  mockCreateChatHandoff.mockReset();
  mockCreateChatHandoff.mockResolvedValue({
    token: 'tok.secret',
    expiresAt: '2026-10-06T10:10:00Z'
  });
});

describe('buildWebChatUrl', () => {
  test("the web app's chat route under the deployment's base URL, subpath included", () => {
    expect(buildWebChatUrl('https://ihub.example.com/ihub', 'mail', 'office-1')).toBe(
      'https://ihub.example.com/ihub/apps/mail/c/office-1'
    );
    expect(buildWebChatUrl('https://ihub.example.com/', 'mail', 'office-1')).toBe(
      'https://ihub.example.com/apps/mail/c/office-1'
    );
  });

  test('ids are encoded as path segments', () => {
    expect(buildWebChatUrl('https://ihub.example.com', 'a/b', 'c d')).toBe(
      'https://ihub.example.com/apps/a%2Fb/c/c%20d'
    );
  });

  test('nothing to open without a base URL, an app or a chat', () => {
    expect(buildWebChatUrl('', 'mail', 'office-1')).toBeNull();
    expect(buildWebChatUrl(undefined, 'mail', 'office-1')).toBeNull();
    expect(buildWebChatUrl('https://ihub.example.com', '', 'office-1')).toBeNull();
    expect(buildWebChatUrl('https://ihub.example.com', 'mail', null)).toBeNull();
  });
});

describe('useOfficeChatPersistence', () => {
  test('reads chats.persistence off the platform config once signed in', async () => {
    mockFetchPlatformConfig.mockResolvedValue({ chats: { persistence: true } });
    const { result } = renderHook(() => useOfficeChatPersistence(true));
    expect(result.current).toEqual({ persistence: false, resolving: true });
    await flush();
    expect(result.current).toEqual({ persistence: true, resolving: false });
  });

  test('an installation that stores nothing, or a failed read, means not stored', async () => {
    mockFetchPlatformConfig.mockResolvedValueOnce({ chats: { persistence: false } });
    const off = renderHook(() => useOfficeChatPersistence(true));
    await flush();
    expect(off.result.current).toEqual({ persistence: false, resolving: false });

    mockFetchPlatformConfig.mockRejectedValueOnce(new Error('offline'));
    const failed = renderHook(() => useOfficeChatPersistence(true));
    await flush();
    expect(failed.result.current).toEqual({ persistence: false, resolving: false });
  });

  test('signed out, nothing is asked for', () => {
    const { result } = renderHook(() => useOfficeChatPersistence(false));
    expect(result.current).toEqual({ persistence: false, resolving: false });
    expect(mockFetchPlatformConfig).not.toHaveBeenCalled();
  });

  test('resolving from the very render the user signs in on, and again after a new sign-in', async () => {
    mockFetchPlatformConfig.mockResolvedValue({ chats: { persistence: true } });
    const { result, rerender } = renderHook(signedIn => useOfficeChatPersistence(signedIn), {
      initialProps: false
    });
    rerender(true);
    // Before any effect has run: a chat must not mount as browser-backed here.
    expect(result.current).toEqual({ persistence: false, resolving: true });
    await flush();
    expect(result.current).toEqual({ persistence: true, resolving: false });

    rerender(false);
    rerender(true);
    expect(result.current.resolving).toBe(true);
    await flush();
    expect(result.current).toEqual({ persistence: true, resolving: false });
  });
});

describe('useStoredChatHydration', () => {
  const hydrate = props =>
    renderHook(p => useStoredChatHydration(p), {
      initialProps: { serverBacked: true, isFreshChat: false, chatId: 'c1', ...props }
    });

  test('a chat the pane minted and never sent is not fetched', () => {
    const chat = makeChat();
    hydrate({ chat, isFreshChat: true });
    expect(mockFetchChat).not.toHaveBeenCalled();
    expect(chat.finishHydration).toHaveBeenCalled();
  });

  test('without durable chats nothing happens', () => {
    const chat = makeChat();
    hydrate({ chat, serverBacked: false });
    expect(mockFetchChat).not.toHaveBeenCalled();
    expect(chat.finishHydration).not.toHaveBeenCalled();
  });

  test('a stored chat is loaded with its settings and variables, and the list is refreshed', async () => {
    const stored = [
      { id: 'm1', role: 'user', content: 'Draft an offer' },
      { id: 'm2', role: 'assistant', content: 'Here it is', runId: 'r1' }
    ];
    mockFetchChat.mockResolvedValue({
      chat: {
        id: 'c1',
        status: 'active',
        modelId: 'gpt',
        settings: { websearchEnabled: true },
        variables: { tone: 'formal' }
      },
      messages: stored
    });
    const chat = makeChat();
    const { result } = hydrate({ chat });
    await flush();

    expect(mockFetchChat).toHaveBeenCalledWith('c1');
    expect(chat.loadServerMessages).toHaveBeenCalledWith(stored, { preserveLocal: true });
    expect(result.current).toEqual({
      chatSettings: { websearchEnabled: true, modelId: 'gpt' },
      chatVariables: { tone: 'formal' }
    });
    // Opening the chat cleared its unseen flag server-side.
    expect(mockInvalidateChatsCache).toHaveBeenCalled();
    expect(chat.reattachToRun).not.toHaveBeenCalled();
  });

  test('a turn still running is re-attached to, then the settled transcript re-read', async () => {
    mockFetchChat.mockResolvedValueOnce({
      chat: { id: 'c1', status: 'running', activeRunId: 'r2' },
      messages: [{ id: 'm1', role: 'user', content: 'Summarize the thread' }]
    });
    const chat = makeChat();
    hydrate({ chat });
    await flush();

    expect(chat.reattachToRun).toHaveBeenCalledWith('r2', { onSettled: expect.any(Function) });
    const settled = [
      { id: 'm1', role: 'user', content: 'Summarize the thread' },
      { id: 'm2', role: 'assistant', content: 'Summary', runId: 'r2' }
    ];
    mockFetchChat.mockResolvedValueOnce({
      chat: { id: 'c1', status: 'active' },
      messages: settled
    });
    await act(() => chat.reattachToRun.mock.calls[0][1].onSettled());
    expect(chat.loadServerMessages).toHaveBeenLastCalledWith(settled);
  });

  test('a running chat whose answer is already stored is not replayed a second time', async () => {
    mockFetchChat.mockResolvedValue({
      chat: { id: 'c1', status: 'running', activeRunId: 'r2' },
      messages: [
        { id: 'm1', role: 'user', content: 'Q' },
        { id: 'm2', role: 'assistant', content: 'A', runId: 'r2' }
      ]
    });
    const chat = makeChat();
    hydrate({ chat });
    await flush();
    expect(chat.reattachToRun).not.toHaveBeenCalled();
  });

  test('a chat that never reached the store ends the loading state quietly', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchChat.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const chat = makeChat();
    hydrate({ chat });
    await flush();
    expect(chat.finishHydration).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a stale answer for a chat already left is dropped', async () => {
    let resolveFirst;
    mockFetchChat
      .mockImplementationOnce(() => new Promise(resolve => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ chat: { id: 'c2' }, messages: [] });
    const chat = makeChat();
    const { rerender } = hydrate({ chat });
    rerender({ chat, serverBacked: true, isFreshChat: false, chatId: 'c2' });
    await flush();

    resolveFirst({ chat: { id: 'c1' }, messages: [{ id: 'old', role: 'user', content: 'x' }] });
    await flush();
    expect(chat.loadServerMessages).toHaveBeenCalledTimes(1);
    expect(chat.loadServerMessages).toHaveBeenCalledWith([], { preserveLocal: true });
  });

  test('a finished turn refreshes the chat list', () => {
    const { rerender } = hydrate({ chat: makeChat(), isFreshChat: true });
    rerender({ chat: makeChat({ processing: true }), serverBacked: true, chatId: 'c1' });
    expect(mockInvalidateChatsCache).not.toHaveBeenCalled();
    rerender({ chat: makeChat({ processing: false }), serverBacked: true, chatId: 'c1' });
    expect(mockInvalidateChatsCache).toHaveBeenCalledTimes(1);
  });
});

describe('<OfficeChatPanel /> with durable chats', () => {
  // The adapter is the seam: what the panel asks it for is the contract.
  const mockAdapterCalls = [];
  const mockAdapterState = {
    hydrating: false,
    storedChatSettings: null,
    storedChatVariables: null,
    messages: {}
  };
  const mockSends = [];
  const mockAppSettingsCalls = [];

  beforeAll(() => {
    jest.doMock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => {
      const React = require('react');
      return {
        __esModule: true,
        default: options => {
          const [, rerender] = React.useReducer(n => n + 1, 0);
          mockAdapterCalls.push(options);
          return {
            messages: mockAdapterState.messages[options.chatId] || [],
            processing: false,
            hydrating: mockAdapterState.hydrating,
            storedChatSettings: mockAdapterState.storedChatSettings,
            storedChatVariables: mockAdapterState.storedChatVariables,
            clarificationPending: false,
            sendMessage: sent => {
              mockSends.push(sent);
              const { displayMessage } = sent;
              mockAdapterState.messages[options.chatId] = [
                { id: 'u1', role: 'user', content: displayMessage.content },
                { id: 'a1', role: 'assistant', content: 'Answer' }
              ];
              rerender();
            },
            clearMessages: () => rerender(),
            deleteMessage: jest.fn(),
            editMessage: jest.fn(),
            resendMessage: jest.fn(),
            cancelGeneration: jest.fn()
          };
        }
      };
    });
    jest.doMock('../../../client/src/shared/hooks/useAppSettings', () => ({
      __esModule: true,
      default: (appId, app, options) => {
        mockAppSettingsCalls.push(options);
        return {
          models: [{ id: 'gpt' }],
          selectedModel: 'gpt',
          setSelectedModel: jest.fn(),
          enabledTools: [],
          setEnabledTools: jest.fn(),
          websearchEnabled: false,
          setWebsearchEnabled: jest.fn(),
          hostContextFlags: null,
          setHostContextFlags: jest.fn(),
          modelsLoading: false
        };
      }
    }));
    jest.doMock('../../../client/src/shared/hooks/useFileUploadHandler', () => ({
      __esModule: true,
      default: () => ({
        createUploadConfig: () => ({}),
        selectedFile: null,
        handleFileSelect: jest.fn(),
        showUploader: false,
        toggleUploader: jest.fn(),
        clearSelectedFile: jest.fn(),
        setSelectedFile: jest.fn()
      })
    }));
    jest.doMock('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot', () => ({
      __esModule: true,
      default: () => ({
        loading: false,
        ctx: { available: true, itemId: 'ITEM-A', itemKind: 'message', attachments: [] },
        visibleAttachments: [],
        removedAttachmentIds: new Set(),
        removeAttachment: jest.fn(),
        restoreAttachments: jest.fn(),
        buildSnapshotOverride: () => null,
        includeBody: true,
        setIncludeBody: jest.fn(),
        generation: 0
      })
    }));
    jest.doMock('../../../client/src/features/office/hooks/useOutlookMailActions', () => ({
      __esModule: true,
      default: () => ({
        actions: [],
        defaultActionId: null,
        runAction: jest.fn(),
        notice: null,
        dismissNotice: jest.fn()
      })
    }));
    jest.doMock('../../../client/src/features/chat/components/ChatMessageList', () => ({
      __esModule: true,
      default: ({ messages, onInsertAction }) => (
        <>
          <ul aria-label="messages">
            {messages.map(m => (
              <li key={m.id}>{m.content}</li>
            ))}
          </ul>
          <button type="button" onClick={() => onInsertAction?.('reply', 'Answer')}>
            Answer action
          </button>
        </>
      )
    }));
    jest.doMock('../../../client/src/features/chat/components/ChatInput', () => ({
      __esModule: true,
      default: ({ value, onChange, onSubmit, disabled }) => (
        <form onSubmit={onSubmit}>
          <textarea
            aria-label="message"
            value={value}
            disabled={disabled}
            onChange={e => onChange?.(e)}
          />
          <button type="submit">Send</button>
        </form>
      )
    }));
    jest.doMock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
      __esModule: true,
      default: () => null
    }));
  });

  beforeEach(() => {
    mockAdapterCalls.length = 0;
    mockAppSettingsCalls.length = 0;
    mockAdapterState.hydrating = false;
    mockAdapterState.storedChatSettings = null;
    mockAdapterState.storedChatVariables = null;
    mockAdapterState.messages = {};
    mockSends.length = 0;
  });

  const app = {
    id: 'mail',
    name: { en: 'Mail' },
    greeting: { title: { en: 'Hello there' } },
    starterPrompts: []
  };

  const renderPanel = (props = {}) => {
    const OfficeChatPanel =
      require('../../../client/src/features/office/components/OfficeChatPanel').default;
    const onOpenHistory = jest.fn();
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <OfficeChatPanel
          authData={{ user: { name: 'Ada' } }}
          selectedApp={app}
          setSelectedApp={jest.fn()}
          onLogout={jest.fn()}
          homePath="/start"
          chatPersistence
          onOpenHistory={onOpenHistory}
          {...props}
        />
      </MemoryRouter>
    );
    return { onOpenHistory };
  };

  const lastAdapterCall = () => mockAdapterCalls[mockAdapterCalls.length - 1];

  const openHistoryFromMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
  };

  test('a chat from the history opens as that stored chat and waits for its transcript', () => {
    mockAdapterState.hydrating = true;
    renderPanel({ openChatId: 'stored-1' });

    expect(lastAdapterCall()).toMatchObject({
      appId: 'mail',
      chatId: 'stored-1',
      serverBacked: true,
      isFreshChat: false
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading chat…');
    // No greeting for a chat that is not empty, and nothing to type into yet.
    expect(screen.queryByText('Hello there')).not.toBeInTheDocument();
    expect(screen.getByLabelText('message')).toBeDisabled();
  });

  test("a reopened chat's settings reach the app settings", () => {
    mockAdapterState.storedChatSettings = { websearchEnabled: true, modelId: 'gpt' };
    renderPanel({ openChatId: 'stored-1' });
    expect(mockAppSettingsCalls[mockAppSettingsCalls.length - 1]).toEqual({
      chatSettings: { websearchEnabled: true, modelId: 'gpt' }
    });
  });

  test('a new chat greets straight away and becomes a stored chat once sent', () => {
    // `hydrating` flips on for a render on every chat switch; a new chat has
    // nothing to load, so it must not show a spinner for it.
    mockAdapterState.hydrating = true;
    const { onOpenHistory } = renderPanel();

    const fresh = lastAdapterCall();
    expect(fresh).toMatchObject({ serverBacked: true, isFreshChat: true });
    expect(fresh.chatId).toMatch(/^office-/);
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByLabelText('message')).not.toBeDisabled();

    // Nothing sent yet: the history has no chat to come back to.
    openHistoryFromMenu();
    expect(onOpenHistory).toHaveBeenLastCalledWith({ returnChatId: null });

    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Draft a reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Sent, but the request goes out only once the stream connects: until the
    // server has it, the store has never heard of this chat.
    expect(lastAdapterCall()).toMatchObject({ chatId: fresh.chatId, isFreshChat: true });
    openHistoryFromMenu();
    expect(onOpenHistory).toHaveBeenLastCalledWith({ returnChatId: null });

    act(() => lastAdapterCall().onMessageAccepted(fresh.chatId));
    expect(lastAdapterCall()).toMatchObject({ chatId: fresh.chatId, isFreshChat: false });
    openHistoryFromMenu();
    expect(onOpenHistory).toHaveBeenLastCalledWith({ returnChatId: fresh.chatId });
  });

  test('a popped-out chat sends the change the debounce holds back when its window closes', () => {
    jest.useFakeTimers();
    try {
      const report = jest.fn();
      renderPanel({
        popout: {
          role: 'child',
          report,
          reportPinned: jest.fn(),
          provideState: jest.fn(),
          dock: jest.fn(),
          signedOut: jest.fn()
        }
      });
      act(() => jest.advanceTimersByTime(0));
      report.mockClear();

      fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Half a thought' } });
      // Typing is reported half a second later...
      expect(report).not.toHaveBeenCalled();
      // ...but the window's X does not wait for it.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0][0]).toMatchObject({ inputValue: 'Half a thought' });

      // Nothing held back, nothing sent.
      act(() => jest.advanceTimersByTime(1000));
      report.mockClear();
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(report).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an ephemeral app stays out of the store, like in the web app', () => {
    const { onOpenHistory } = renderPanel({ selectedApp: { ...app, ephemeral: true } });
    expect(lastAdapterCall()).toMatchObject({ serverBacked: false });

    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Confidential' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The history is still there for other chats, but this one is not in it.
    openHistoryFromMenu();
    expect(onOpenHistory).toHaveBeenLastCalledWith({ returnChatId: null });
  });

  const variablesApp = {
    ...app,
    variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string', required: true }]
  };

  test('a chat from the history continues with its stored variables, without asking for them', () => {
    mockAdapterState.storedChatVariables = { tone: 'formal' };
    renderPanel({ openChatId: 'stored-1', selectedApp: variablesApp });

    // The required variable is empty by the app's defaults, but this chat
    // already has it: no dialog.
    expect(screen.queryByRole('heading', { name: 'Variables' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Follow up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The stored values, not the defaults, so the turn does not replace them.
    expect(mockSends[mockSends.length - 1].apiMessage.variables).toEqual({ tone: 'formal' });
  });

  test("a new chat after a reopened one does not carry that chat's variables", () => {
    const toneApp = {
      ...app,
      variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string', defaultValue: 'neutral' }]
    };
    mockAdapterState.storedChatVariables = { tone: 'formal' };
    renderPanel({ openChatId: 'stored-1', selectedApp: toneApp });

    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Follow up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(mockSends[mockSends.length - 1].apiMessage.variables).toEqual({ tone: 'formal' });

    // The next chat has no stored variables; it goes on with the pane's own.
    mockAdapterState.storedChatVariables = null;
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Fresh question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(mockSends[mockSends.length - 1].apiMessage.variables).toEqual({ tone: 'neutral' });
  });

  test('a new chat of the same app still asks for a required variable', () => {
    renderPanel({ selectedApp: variablesApp });
    expect(screen.getByRole('heading', { name: 'Variables' })).toBeInTheDocument();
  });

  test('a start form is not shown while a stored chat of that app loads', () => {
    mockAdapterState.hydrating = true;
    renderPanel({
      openChatId: 'stored-1',
      selectedApp: { ...variablesApp, startForm: { enabled: true } }
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading chat…');
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  test('without durable chats the panel behaves as before: no store, no history', async () => {
    renderPanel({ chatPersistence: false, onOpenHistory: undefined });
    expect(lastAdapterCall()).toMatchObject({ serverBacked: false });
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Chat history' })).not.toBeInTheDocument()
    );
    // Offered, greyed out until there is something to hand over.
    expect(screen.getByText('Open in web app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in web app' })).not.toBeInTheDocument();
  });

  describe('Open in web app', () => {
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const webEntry = () => screen.queryByRole('button', { name: 'Open in web app' });
    // The host's answer settles after the click (the extension's tab is created
    // asynchronously), so the click is awaited through it.
    const openInWeb = async () => {
      openMenu();
      await act(async () => {
        fireEvent.click(webEntry());
      });
    };

    test("a chat from the history opens in the browser at the web app's chat route", async () => {
      renderPanel({ openChatId: 'stored-1' });
      await openInWeb();

      expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
      expect(mockOpenExternalUrl).toHaveBeenCalledWith(
        'https://ihub.example.com/ihub/apps/mail/c/stored-1'
      );
      // Opened: nothing to report.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    test('also while the stored chat is still loading: the web app fetches it itself', async () => {
      mockAdapterState.hydrating = true;
      renderPanel({ openChatId: 'stored-1' });
      await openInWeb();
      expect(mockOpenExternalUrl).toHaveBeenCalledWith(
        'https://ihub.example.com/ihub/apps/mail/c/stored-1'
      );
    });

    test('a new chat can be opened once the server has its first turn, under its own id', async () => {
      renderPanel();
      const fresh = lastAdapterCall();

      // Offered, but greyed out: the store has never heard of this chat.
      openMenu();
      expect(screen.getByText('Open in web app')).toBeInTheDocument();
      expect(webEntry()).not.toBeInTheDocument();
      openMenu();

      fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Draft a reply' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      // Sent is not stored: the request goes out once the stream connects.
      openMenu();
      expect(webEntry()).not.toBeInTheDocument();
      openMenu();

      act(() => lastAdapterCall().onMessageAccepted(fresh.chatId));
      await openInWeb();
      expect(mockOpenExternalUrl).toHaveBeenCalledWith(
        `https://ihub.example.com/ihub/apps/mail/c/${fresh.chatId}`
      );
    });

    test('when the browser does not open — or its tab is refused — the address is shown', async () => {
      mockOpenExternalUrl.mockResolvedValue(false);
      renderPanel({ openChatId: 'stored-1' });
      await openInWeb();

      const notice = screen.getByRole('status');
      expect(notice).toHaveTextContent(
        'If the chat did not open in your browser, open this address:'
      );
      expect(notice).toHaveTextContent('https://ihub.example.com/ihub/apps/mail/c/stored-1');

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    test('a later attempt that opens clears the address of an earlier one', async () => {
      mockOpenExternalUrl.mockResolvedValue(false);
      renderPanel({ openChatId: 'stored-1' });
      await openInWeb();
      expect(screen.getByRole('status')).toHaveTextContent('/c/stored-1');

      mockOpenExternalUrl.mockResolvedValue(true);
      await openInWeb();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    test("the address goes once its chat is left: it is not the new chat's", async () => {
      mockOpenExternalUrl.mockResolvedValue(false);
      renderPanel({ openChatId: 'stored-1' });
      await openInWeb();
      expect(screen.getByRole('status')).toHaveTextContent('/c/stored-1');

      fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.queryByText(/\/c\/stored-1/)).not.toBeInTheDocument();
    });

    test('an answer action run afterwards takes the notice strip over', async () => {
      mockOpenExternalUrl.mockResolvedValue(false);
      renderPanel({ openChatId: 'stored-1' });
      await openInWeb();
      expect(screen.getByRole('status')).toHaveTextContent('/c/stored-1');

      fireEvent.click(screen.getByRole('button', { name: 'Answer action' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    const sendFirstMessage = () => {
      fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Draft a reply' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    };

    test('a chat that is not stored is handed over: parked once, opened with its token', async () => {
      renderPanel({ chatPersistence: false, onOpenHistory: undefined });
      sendFirstMessage();
      await openInWeb();

      expect(mockCreateChatHandoff).toHaveBeenCalledTimes(1);
      expect(mockCreateChatHandoff).toHaveBeenCalledWith({
        appId: 'mail',
        messages: [
          { role: 'user', content: 'Draft a reply' },
          { role: 'assistant', content: 'Answer' }
        ],
        variables: {}
      });
      expect(mockOpenExternalUrl).toHaveBeenCalledWith(
        'https://ihub.example.com/ihub/apps/mail?handoff=tok.secret'
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    test("an ephemeral app's chat is handed over too: it is not stored", async () => {
      renderPanel({ selectedApp: { ...app, ephemeral: true } });
      openMenu();
      expect(screen.getByRole('button', { name: 'Chat history' })).toBeInTheDocument();
      expect(webEntry()).not.toBeInTheDocument();
      openMenu();

      sendFirstMessage();
      await openInWeb();
      expect(mockCreateChatHandoff).toHaveBeenCalledTimes(1);
      expect(mockOpenExternalUrl).toHaveBeenCalledWith(
        'https://ihub.example.com/ihub/apps/mail?handoff=tok.secret'
      );
    });

    test('a hand-off the server refuses says so instead of opening anything', async () => {
      mockCreateChatHandoff.mockRejectedValue(Object.assign(new Error('too big'), { status: 413 }));
      renderPanel({ chatPersistence: false, onOpenHistory: undefined });
      sendFirstMessage();
      await openInWeb();

      expect(mockOpenExternalUrl).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This chat is too large to open in the web app.'
      );
    });
  });
});
