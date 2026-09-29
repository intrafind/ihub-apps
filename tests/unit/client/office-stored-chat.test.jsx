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
 *   the history.
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
jest.mock('../../../client/src/api', () => ({
  fetchApps: jest.fn(() => Promise.resolve([])),
  fetchChat: (...args) => mockFetchChat(...args),
  fetchPlatformConfig: (...args) => mockFetchPlatformConfig(...args)
}));

const mockInvalidateChatsCache = jest.fn();
jest.mock('../../../client/src/shared/hooks/chatListStore', () => ({
  invalidateChatsCache: () => mockInvalidateChatsCache()
}));

jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => ({ starterPrompts: [], calendarStarterPrompts: [] })
}));

const useStoredChatHydration =
  require('../../../client/src/features/office/hooks/useStoredChatHydration').default;
const useOfficeChatPersistence =
  require('../../../client/src/features/office/hooks/useOfficeChatPersistence').default;

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
      default: ({ messages }) => (
        <ul aria-label="messages">
          {messages.map(m => (
            <li key={m.id}>{m.content}</li>
          ))}
        </ul>
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
    expect(lastAdapterCall()).toMatchObject({ chatId: fresh.chatId, isFreshChat: false });

    openHistoryFromMenu();
    expect(onOpenHistory).toHaveBeenLastCalledWith({ returnChatId: fresh.chatId });
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
  });
});
