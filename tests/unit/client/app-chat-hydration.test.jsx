import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

/**
 * Opening, starting and continuing a chat — driven through the real `AppChat`.
 *
 * The hooks have their own suites; what only shows up here is the page's own
 * wiring around them: which effect fires when, what the hydration guard lets
 * through a second time, and what the 300 ms auto-start timer does if the
 * world moves underneath it. Each of those has an empty transcript at the
 * centre of it, and in server-backed mode an empty transcript is what a chat
 * with a hundred stored turns looks like until `GET /api/chats/:id` answers.
 *
 * Everything below `AppChat` that talks to the network, the microphone or a
 * heavy child component is stubbed; `useAppChat`, `useChatMessages` and the
 * page's own effects are real.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => `uuid-${(global.__uuidSeq = (global.__uuidSeq || 0) + 1)}`
}));

// Every hook stubbed below returns a *stable* identity: `AppChat` has effects
// keyed on these objects, and a fresh one per render turns them into loops.
const mockT = (key, def) => (typeof def === 'string' ? def : key);
const mockTranslation = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockTranslation
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAppDetails: jest.fn(),
  fetchChat: jest.fn(),
  claimChatHandoff: jest.fn(),
  sendAppChatMessage: jest.fn().mockResolvedValue({})
}));
jest.mock('../../../client/src/api/endpoints/apps', () => ({
  __esModule: true,
  getConversationMessages: jest.fn().mockResolvedValue({ messages: [] })
}));
// Reached through AppChat's citation document actions. Stubbed like the rest
// of the api layer: `api/client.js` reads `import.meta.env`, which the Jest
// transform cannot compile.
jest.mock('../../../client/src/api/endpoints/sources', () => ({
  __esModule: true,
  fetchSourceContent: jest.fn(),
  fetchSourceMetadata: jest.fn()
}));

// The stream: record what was opened, deliver nothing.
const mockStreams = [];
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: () => ({
    initEventSource: jest.fn(url => mockStreams.push(url)),
    cleanupEventSource: jest.fn()
  })
}));

const mockCapability = { persistence: true, resolving: false };
jest.mock('../../../client/src/shared/hooks/useChats', () => ({
  __esModule: true,
  invalidateChatsCache: jest.fn(),
  useChatPersistence: () => mockCapability.persistence,
  useChatPersistenceResolving: () => mockCapability.resolving
}));

// App settings, with the one switch these tests drive (incognito) held in real
// React state so flipping it re-renders `AppChat` the way the toggle does.
const mockSettings = { current: null, initialEphemeral: false };
const mockNoop = () => {};
const mockBaseSettings = {
  selectedModel: 'model-x',
  selectedStyle: 'normal',
  selectedOutputFormat: 'markdown',
  temperature: 0.7,
  sendChatHistory: true,
  thinkingEnabled: null,
  thinkingBudget: null,
  thinkingThoughts: null,
  enabledTools: null,
  websearchEnabled: false,
  imageAspectRatio: null,
  imageQuality: null,
  models: [{ id: 'model-x', name: { en: 'Model X' }, contextWindow: 8192 }],
  styles: {},
  setSelectedModel: mockNoop,
  setSelectedStyle: mockNoop,
  setSelectedOutputFormat: mockNoop,
  setTemperature: mockNoop,
  setSendChatHistory: mockNoop,
  setThinkingEnabled: mockNoop,
  setThinkingBudget: mockNoop,
  setThinkingThoughts: mockNoop,
  setEnabledTools: mockNoop,
  setWebsearchEnabled: mockNoop,
  setImageAspectRatio: mockNoop,
  setImageQuality: mockNoop,
  modelsLoading: false
};
jest.mock('../../../client/src/shared/hooks/useAppSettings', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: () => {
      // The one switch these tests drive, held in real React state so flipping
      // it re-renders `AppChat` the way the incognito toggle does.
      const [ephemeral, setEphemeral] = React.useState(mockSettings.initialEphemeral);
      mockSettings.current = { setEphemeral };
      return React.useMemo(
        () => ({ ...mockBaseSettings, ephemeral, setEphemeral }),
        [ephemeral, setEphemeral]
      );
    }
  };
});

const mockUploadConfig = {};
const mockUploadHandler = {
  selectedFile: null,
  showUploader: false,
  handleFileSelect: mockNoop,
  createUploadConfig: () => mockUploadConfig,
  toggleUploader: mockNoop,
  hideUploader: mockNoop,
  clearSelectedFile: mockNoop,
  setSelectedFile: mockNoop
};
jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => ({
  __esModule: true,
  default: () => mockUploadHandler
}));
const mockMagicPrompt = {
  showUndoMagicPrompt: false,
  magicLoading: false,
  resetMagicPrompt: mockNoop,
  runMagicPrompt: mockNoop,
  undoMagicPrompt: mockNoop
};
jest.mock('../../../client/src/shared/hooks/useMagicPrompt', () => ({
  __esModule: true,
  default: () => mockMagicPrompt
}));
jest.mock(
  '../../../client/src/features/nextcloud-embed/hooks/useNextcloudEmbedAttachments',
  () => ({
    __esModule: true,
    default: () => undefined
  })
);
const mockFeatureFlags = {
  isEnabled: (_flag, fallback = false) => fallback,
  isBothEnabled: (_app, _flag, fallback = false) => fallback,
  isAppFeatureEnabled: (_app, _path, fallback = false) => fallback
};
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => mockFeatureFlags
}));
const mockNoIntegrations = [];
const mockIntegrationAuth = {
  monitorChatMessages: mockNoop,
  connectIntegration: mockNoop,
  getRequiredIntegrations: () => mockNoIntegrations
};
jest.mock('../../../client/src/features/chat/hooks/useIntegrationAuth', () => ({
  __esModule: true,
  useIntegrationAuth: () => mockIntegrationAuth
}));
const mockVoice = { handleVoiceInput: mockNoop, handleVoiceCommand: mockNoop };
jest.mock('../../../client/src/features/voice/hooks/useVoiceCommands', () => ({
  __esModule: true,
  default: () => mockVoice
}));
jest.mock('../../../client/src/features/chat/startChatHandoff', () => ({
  __esModule: true,
  consumePendingChatStart: () => null
}));
jest.mock('../../../client/src/shared/utils/tokenEstimatorClient.js', () => ({
  __esModule: true,
  ensureTokenizer: jest.fn().mockResolvedValue(undefined),
  estimateTokensSync: () => 0
}));
jest.mock('../../../client/src/utils/recentApps', () => ({
  __esModule: true,
  recordAppUsage: jest.fn()
}));
jest.mock('../../../client/src/utils/appSettings', () => ({
  __esModule: true,
  saveAppSettings: jest.fn(),
  loadAppSettings: () => null
}));
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  __esModule: true,
  processDocumentFile: jest.fn(),
  decodeAudioFileToBuffer: jest.fn()
}));
jest.mock('../../../client/src/utils/transcribeAudioBuffer', () => ({
  __esModule: true,
  transcribeAudioBuffer: jest.fn()
}));
jest.mock('../../../client/src/utils/audioRecorder', () => ({
  __esModule: true,
  AudioBufferRecorder: class {}
}));

// Child components: only what the assertions read.
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: ({ message }) => <div data-testid="spinner">{message}</div>
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/ShareDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/SharedAppHeader', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/AIDisclaimerBanner', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/CompareModeView', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/InputVariables', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/StarterPromptsView', () => ({
  __esModule: true,
  default: () => <div data-testid="starter-prompts" />
}));
jest.mock('../../../client/src/features/chat/components/GreetingView', () => ({
  __esModule: true,
  default: ({ welcomeMessage }) => <div data-testid="greeting">{welcomeMessage}</div>
}));
jest.mock('../../../client/src/features/chat/components/NoMessagesView', () => ({
  __esModule: true,
  default: () => <div data-testid="no-messages" />
}));
jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: ({ messages }) => (
    <div data-testid="transcript">{messages.map(m => m.content).join('|')}</div>
  )
}));
// A real <form> bound to `formRef`, because the auto-send path dispatches a
// submit event on it — that is how the start-page handoff sends its message.
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ formRef, onSubmit }) => (
    <form ref={formRef} onSubmit={onSubmit} data-testid="composer" />
  )
}));

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;
const { fetchChat, claimChatHandoff } = require('../../../client/src/api');

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  greeting: { en: 'Hello there' },
  variables: []
};

const STORED_MESSAGES = [
  { id: 'srv-1', role: 'user', content: 'stored question', ts: '2026-03-15T09:00:00.000Z' },
  { id: 'srv-2', role: 'assistant', content: 'stored answer', ts: '2026-03-15T09:00:04.000Z' }
];

/**
 * Render the page at one of the two chat routes.
 *
 * @param {Object} [options] - Render options.
 * @param {string} [options.path] - Initial URL.
 * @param {Object} [options.app] - The app config handed in as `preloadedApp`.
 * @returns {Object} The testing-library result.
 */
// In-app navigation for the tests, the way a sidebar link moves the router
// without remounting the page.
const mockRouter = { navigate: null };
function LocationProbe() {
  mockRouter.navigate = useNavigate();
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderChat({ path = '/apps/acme', app = APP } = {}) {
  // The auto-send effect strips its query parameters with
  // `navigate(window.location.pathname + …)`, so jsdom's URL has to agree with
  // the router's or that navigation lands on a route that does not exist.
  window.history.replaceState({}, '', path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/apps/:appId" element={<AppChat preloadedApp={app} />} />
        <Route path="/apps/:appId/c/:chatId" element={<AppChat preloadedApp={app} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

/** A `fetchChat` that stays out until the test resolves it. */
function deferredChat(chat = {}) {
  let settle;
  const promise = new Promise(resolve => {
    settle = resolve;
  });
  fetchChat.mockReturnValueOnce(promise);
  return messages => {
    settle({ chat: { id: 'chat-stored', ...chat }, messages });
    return promise;
  };
}

beforeEach(() => {
  mockStreams.length = 0;
  mockCapability.persistence = true;
  mockCapability.resolving = false;
  mockSettings.initialEphemeral = false;
  mockSettings.current = null;
  sessionStorage.clear();
  fetchChat.mockReset();
  fetchChat.mockResolvedValue({ chat: {}, messages: [] });
});

describe('opening a stored chat', () => {
  test('shows a loading state, then the stored transcript — never the greeting', async () => {
    const resolveChat = deferredChat();
    renderChat({ path: '/apps/acme/c/chat-stored' });

    expect(screen.getAllByTestId('spinner')[0]).toHaveTextContent('Loading chat...');
    expect(screen.queryByTestId('greeting')).toBeNull();

    await act(async () => {
      await resolveChat(STORED_MESSAGES);
    });

    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
      'stored question|stored answer'
    );
    expect(screen.queryByTestId('greeting')).toBeNull();
  });
});

describe('reopening a chat whose turn is still running', () => {
  test('re-attaches when the answer has not been stored yet', async () => {
    const resolveChat = deferredChat({ status: 'running', activeRunId: 'run-live' });
    renderChat({ path: '/apps/acme/c/chat-stored' });

    await act(async () => {
      await resolveChat([STORED_MESSAGES[0]]);
    });

    // The whole point of durability: the turn outlived the tab, so reopening
    // has to follow it rather than wait for a second page load.
    expect(mockStreams).toEqual(['/api/apps/acme/chat/chat-stored']);
  });

  test('does not re-attach when the answer is already in the transcript', async () => {
    // The server stores the answer *before* it releases the run — the two take
    // the chat lock separately, and the other order lets a reader see a settled
    // chat whose answer is not stored yet and clear its unseen flag for good.
    // The cost of the safe order is this window: `status` still says `running`
    // while the reply is already here.
    const resolveChat = deferredChat({ status: 'running', activeRunId: 'run-done' });
    renderChat({ path: '/apps/acme/c/chat-stored' });

    await act(async () => {
      await resolveChat([STORED_MESSAGES[0], { ...STORED_MESSAGES[1], runId: 'run-done' }]);
    });

    // Keyed off the status alone, the client renders this answer and then mints
    // a second bubble and replays the same tokens into it — and never recovers,
    // because the run has ended and there is no settle left to wait for, so the
    // processing state sticks until a reload.
    expect(mockStreams).toEqual([]);
    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
      'stored question|stored answer'
    );
  });

  test('re-attaches when the stored answer belongs to an earlier run', async () => {
    const resolveChat = deferredChat({ status: 'running', activeRunId: 'run-two' });
    renderChat({ path: '/apps/acme/c/chat-stored' });

    await act(async () => {
      await resolveChat([
        STORED_MESSAGES[0],
        { ...STORED_MESSAGES[1], runId: 'run-one' },
        { id: 'srv-3', role: 'user', content: 'and again', ts: '2026-03-15T09:01:00.000Z' }
      ]);
    });

    // A previous turn's answer says nothing about this one. Matching on
    // "is there any assistant message" rather than on the run id would leave
    // every continued chat unable to follow its live turn.
    expect(mockStreams).toEqual(['/api/apps/acme/chat/chat-stored']);
  });
});

describe('starting a new chat', () => {
  test('a chat id this tab minted is never asked for — it can only 404', async () => {
    // `/apps/:appId` with nothing in sessionStorage mints an id on the spot.
    // Fetching it buys a guaranteed 404, a red `API Error` in the console, and
    // a spinner where the greeting and the starter prompts belong.
    renderChat();

    await waitFor(() => expect(screen.getAllByTestId('greeting')[0]).toBeInTheDocument());
    expect(fetchChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spinner')).toBeNull();
  });

  test('opening the app starts a new chat instead of the one this tab held', async () => {
    // Durable chats keep the previous conversation in the history, one click
    // away, so opening the app itself means "a new chat".
    sessionStorage.setItem('ai_hub_chat_id_acme', 'chat-from-a-previous-load');
    renderChat();

    await waitFor(() => expect(screen.getAllByTestId('greeting')[0]).toBeInTheDocument());
    expect(fetchChat).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('ai_hub_chat_id_acme')).not.toBe('chat-from-a-previous-load');
  });

  test('without durable chats the chat this tab held is still restored', async () => {
    // Its transcript lives only in sessionStorage, so it has no history entry
    // to come back through.
    mockCapability.persistence = false;
    sessionStorage.setItem('ai_hub_chat_id_acme', 'chat-local');
    sessionStorage.setItem(
      'ai_hub_chat_messages_chat-local',
      JSON.stringify([{ id: 'loc-1', role: 'user', content: 'local question' }])
    );
    renderChat();

    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('local question')
    );
  });

  test('returning to the bare app route does not restore the previous chat URL', async () => {
    // Start at the bare route, visit a stored chat, then return. Both routes
    // render the same page instance, which briefly still holds the previous
    // chat and its transcript.
    const resolveChat = deferredChat();
    renderChat();
    await waitFor(() => expect(screen.getAllByTestId('greeting')[0]).toBeInTheDocument());

    await act(async () => {
      mockRouter.navigate('/apps/acme/c/chat-stored');
    });
    await act(async () => {
      await resolveChat(STORED_MESSAGES);
    });
    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('stored question');

    await act(async () => {
      mockRouter.navigate('/apps/acme');
    });

    await waitFor(() => expect(screen.getAllByTestId('greeting')[0]).toBeInTheDocument());
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/apps\/acme$/);
    expect(fetchChat).toHaveBeenCalledTimes(1);
  });

  test('the first message pins the chat into the URL, so a reload keeps it', async () => {
    jest.useFakeTimers();
    try {
      renderChat({ path: '/apps/acme?prefill=first%20question&send=true' });

      await act(async () => {
        jest.advanceTimersByTime(200);
      });

      expect(mockStreams).toHaveLength(1);
      const chatId = mockStreams[0].split('/').pop();
      expect(screen.getByTestId('location')).toHaveTextContent(`/apps/acme/c/${chatId}`);
      // Pinning the URL is not a chat switch: nothing is fetched or re-sent.
      expect(fetchChat).not.toHaveBeenCalled();
      expect(mockStreams).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('leaving and re-entering server-backed mode', () => {
  test('turning incognito off keeps the conversation and does not strand the spinner', async () => {
    const resolveChat = deferredChat();
    renderChat({ path: '/apps/acme/c/chat-stored' });
    await act(async () => {
      await resolveChat(STORED_MESSAGES);
    });
    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('stored question');

    // Incognito on, then off again: the same `serverBacked` false→true
    // transition as the capability resolving, but with nothing stale to drop.
    await act(async () => {
      mockSettings.current.setEphemeral(true);
    });
    await act(async () => {
      mockSettings.current.setEphemeral(false);
    });

    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
      'stored question|stored answer'
    );
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(fetchChat).toHaveBeenCalledTimes(1);
  });
});

describe('a turn that races the hydrate', () => {
  test('the stored transcript still lands in front of the turn that was sent', async () => {
    // A message handed over as `?prefill=…&send=true` onto a stored chat — one
    // that already has a transcript. The auto-send fires ~100 ms in, while the
    // hydrate is still out.
    jest.useFakeTimers();
    try {
      const resolveChat = deferredChat();
      renderChat({ path: '/apps/acme/c/chat-handoff?prefill=a%20second%20question&send=true' });

      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(mockStreams).toEqual(['/api/apps/acme/chat/chat-handoff']);

      await act(async () => {
        await resolveChat(STORED_MESSAGES);
      });

      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
        'stored question|stored answer|a second question|'
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('an app that starts the conversation by itself', () => {
  const AUTO_START_APP = { ...APP, autoStart: true };

  test('waits for the stored transcript instead of appending a blank turn to it', async () => {
    jest.useFakeTimers();
    try {
      const resolveChat = deferredChat();
      renderChat({ path: '/apps/acme/c/chat-stored', app: AUTO_START_APP });

      // The auto-start timer is 300 ms; the hydrate has not answered yet.
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockStreams).toEqual([]);

      await act(async () => {
        await resolveChat(STORED_MESSAGES);
      });
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      expect(mockStreams).toEqual([]);
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
        'stored question|stored answer'
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('still starts itself when the chat really is empty', async () => {
    jest.useFakeTimers();
    try {
      const resolveChat = deferredChat();
      renderChat({ path: '/apps/acme/c/chat-empty', app: AUTO_START_APP });

      await act(async () => {
        await resolveChat([]);
      });
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      expect(mockStreams).toEqual(['/api/apps/acme/chat/chat-empty']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not fire while the chat mode is still unknown', async () => {
    jest.useFakeTimers();
    try {
      mockCapability.resolving = true;
      mockCapability.persistence = false;
      renderChat({ path: '/apps/acme/c/chat-unknown', app: AUTO_START_APP });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      expect(mockStreams).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a chat handed over from the Outlook pane', () => {
  // "Open in web app" on a chat that is not stored: the pane parked it and
  // opened the app with `?handoff=<token>` (server/routes/chatHandoffs.js).
  const HANDOFF = {
    appId: 'acme',
    messages: [
      { role: 'user', content: 'Summarize this email', hostContext: { email: { subject: 'Q3' } } },
      { role: 'assistant', content: 'It is about Q3.' }
    ],
    variables: null
  };

  beforeEach(() => {
    mockCapability.persistence = false;
    claimChatHandoff.mockReset();
    sessionStorage.clear();
  });

  test('is claimed once and continues as a new chat, leaving the one this tab had alone', async () => {
    sessionStorage.setItem('ai_hub_chat_id_acme', 'chat-earlier');
    sessionStorage.setItem(
      'ai_hub_chat_messages_chat-earlier',
      JSON.stringify([{ id: 'e1', role: 'user', content: 'earlier question' }])
    );
    claimChatHandoff.mockResolvedValue(HANDOFF);

    renderChat({ path: '/apps/acme?handoff=tok.secret' });

    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
        'Summarize this email|It is about Q3.'
      )
    );
    expect(claimChatHandoff).toHaveBeenCalledTimes(1);
    expect(claimChatHandoff).toHaveBeenCalledWith('tok.secret');

    const newChatId = sessionStorage.getItem('ai_hub_chat_id_acme');
    expect(newChatId).not.toBe('chat-earlier');
    const stored = JSON.parse(sessionStorage.getItem(`ai_hub_chat_messages_${newChatId}`));
    // The email the chat was about goes back to the model with the history.
    expect(stored[0]).toMatchObject({
      role: 'user',
      content: 'Summarize this email',
      hostContext: { email: { subject: 'Q3' } }
    });
    expect(JSON.parse(sessionStorage.getItem('ai_hub_chat_messages_chat-earlier'))).toHaveLength(1);
  });

  test('in incognito the transcript is shown without being kept', async () => {
    mockSettings.initialEphemeral = true;
    claimChatHandoff.mockResolvedValue(HANDOFF);

    renderChat({ path: '/apps/acme?handoff=tok.secret' });

    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
        'Summarize this email|It is about Q3.'
      )
    );
  });

  test('a link that expired or was already used says so', async () => {
    claimChatHandoff.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    renderChat({ path: '/apps/acme?handoff=tok.secret' });
    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
        'the link has expired or was already used'
      )
    );
  });

  test('a viewer whose chats are stored continues it unstored, history and all', async () => {
    // The pane did not store this chat (an ephemeral app, say); the store has
    // no history for it, so the browser carries it like a chat that is not stored.
    mockCapability.persistence = true;
    claimChatHandoff.mockResolvedValue(HANDOFF);

    renderChat({ path: '/apps/acme?handoff=tok.secret' });

    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
        'Summarize this email|It is about Q3.'
      )
    );
    expect(fetchChat).not.toHaveBeenCalled();
    const stored = Object.keys(sessionStorage).filter(key =>
      key.startsWith('ai_hub_chat_messages_')
    );
    expect(stored).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(stored[0]))[0]).toMatchObject({
      content: 'Summarize this email',
      hostContext: { email: { subject: 'Q3' } }
    });
    // Not pinned to a stored chat's address, which a reload would ask the store for.
    expect(screen.getByTestId('location')).toHaveTextContent('/apps/acme');
    expect(screen.getByTestId('location')).not.toHaveTextContent('/c/');
  });

  test('a failure that may pass says so and keeps the link for a reload', async () => {
    claimChatHandoff.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    renderChat({ path: '/apps/acme?handoff=tok.secret' });
    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('Reload the page')
    );
  });

  test('a visitor who is not signed in is asked to sign in, and nothing is claimed', async () => {
    const { AuthContext } = require('../../../client/src/shared/contexts/authContextValue');
    window.history.replaceState({}, '', '/apps/acme?handoff=tok.secret');
    render(
      <AuthContext.Provider value={{ isAuthenticated: false }}>
        <MemoryRouter initialEntries={['/apps/acme?handoff=tok.secret']}>
          <Routes>
            <Route path="/apps/:appId" element={<AppChat preloadedApp={APP} />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('Sign in to continue')
    );
    expect(claimChatHandoff).not.toHaveBeenCalled();
  });

  test("someone else's hand-off says whose it is", async () => {
    claimChatHandoff.mockRejectedValue(Object.assign(new Error('not yours'), { status: 403 }));
    renderChat({ path: '/apps/acme?handoff=other.token' });
    await waitFor(() =>
      expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('another account')
    );
  });
});
