import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * `AppChat` embedded in another page — the admin app editor's test panel
 * (issue #2510).
 *
 * The host page owns the route and the query string, so the embedded chat
 * must not read them, rewrite them or navigate away. It also must not touch
 * what this browser remembers about the app — the chat id, settings and
 * variables in sessionStorage, the recent apps, a start-page handoff — so a
 * test starts as a new user would see it and leaves the app page as it was.
 *
 * The mock setup mirrors app-chat-hydration.test.jsx.
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
// A subpath deployment, so links that leave the host page must carry it.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildPath: path => `/ihub${path}`
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAppDetails: jest.fn(),
  fetchChat: jest.fn(),
  sendAppChatMessage: jest.fn().mockResolvedValue({})
}));
jest.mock('../../../client/src/api/endpoints/apps', () => ({
  __esModule: true,
  getConversationMessages: jest.fn().mockResolvedValue({ messages: [] })
}));
// Reached through AppChat's citation document actions. Stubbed like the rest
// of the api layer: `api/client.js` reads `import.meta.env`, which the Jest
// transform cannot compile.
jest.mock('../../../client/src/api/endpoints/documents', () => ({
  __esModule: true,
  fetchIFinderDocument: jest.fn(),
  fetchIFinderDocumentMetadata: jest.fn()
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
const mockAppSettingsCalls = [];
jest.mock('../../../client/src/shared/hooks/useAppSettings', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: (...args) => {
      mockAppSettingsCalls.push(args[2]);
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
  consumePendingChatStart: jest.fn(() => null)
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
  loadAppSettings: jest.fn(() => null)
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
jest.mock('../../../client/src/features/apps/components/AppShareModal', () => ({
  __esModule: true,
  default: () => null
}));
// The header props are what tells the host page's navigation apart.
const mockHeader = { props: null };
jest.mock('../../../client/src/features/apps/components/SharedAppHeader', () => ({
  __esModule: true,
  default: props => {
    mockHeader.props = props;
    return null;
  }
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
const mockMessageList = { props: null };
jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: props => {
    mockMessageList.props = props;
    return <div data-testid="transcript">{props.messages.map(m => m.content).join('|')}</div>;
  }
}));
// A real <form> bound to `formRef`, because the auto-send path dispatches a
// submit event on it — that is how the start-page handoff sends its message.
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ formRef, onSubmit, value }) => (
    <form ref={formRef} onSubmit={onSubmit} data-testid="composer" data-value={value} />
  )
}));

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;
const { fetchChat } = require('../../../client/src/api');
const { recordAppUsage } = require('../../../client/src/utils/recentApps');
const { saveAppSettings, loadAppSettings } = require('../../../client/src/utils/appSettings');
const { consumePendingChatStart } = require('../../../client/src/features/chat/startChatHandoff');

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  greeting: { en: 'Hello there' },
  variables: []
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

// The host page's own URL carries parameters the app page would act on.
const HOST_URL = '/admin/apps/acme?prefill=from-the-host&model=other&var_topic=x';

function renderEmbedded(app = APP) {
  window.history.replaceState({}, '', HOST_URL);
  return render(
    <MemoryRouter initialEntries={[HOST_URL]}>
      <Routes>
        <Route
          path="/admin/apps/:appId"
          element={<AppChat embedded appId="acme" preloadedApp={app} />}
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderOnRoute() {
  window.history.replaceState({}, '', '/apps/acme');
  return render(
    <MemoryRouter initialEntries={['/apps/acme']}>
      <Routes>
        <Route path="/apps/:appId" element={<AppChat preloadedApp={APP} />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockStreams.length = 0;
  mockAppSettingsCalls.length = 0;
  mockHeader.props = null;
  mockMessageList.props = null;
  mockCapability.persistence = true;
  mockCapability.resolving = false;
  jest.clearAllMocks();
  sessionStorage.clear();
});

describe('AppChat embedded in a host page', () => {
  test('neither reads nor changes the host URL', async () => {
    renderEmbedded();
    await screen.findAllByTestId('composer');

    expect(screen.getByTestId('location')).toHaveTextContent(HOST_URL);
    // `?prefill=` belongs to the host; the composer starts empty.
    for (const composer of screen.getAllByTestId('composer')) {
      expect(composer).toHaveAttribute('data-value', '');
    }
  });

  test('starts a chat of its own instead of the one this tab holds for the app', async () => {
    sessionStorage.setItem('ai_hub_chat_id_acme', 'chat-of-the-app-page');
    renderEmbedded();
    await screen.findAllByTestId('composer');

    const chatId = mockHeader.props.chatId;
    expect(chatId).toMatch(/^chat-/);
    expect(chatId).not.toBe('chat-of-the-app-page');
    expect(sessionStorage.getItem('ai_hub_chat_id_acme')).toBe('chat-of-the-app-page');
    // A new chat: nothing to hydrate from the store.
    expect(fetchChat).not.toHaveBeenCalled();
  });

  test('leaves what the browser remembers about the app alone', async () => {
    renderEmbedded();
    await screen.findAllByTestId('composer');

    expect(mockAppSettingsCalls.every(options => options?.isolated === true)).toBe(true);
    expect(loadAppSettings).not.toHaveBeenCalled();
    expect(saveAppSettings).not.toHaveBeenCalled();
    expect(recordAppUsage).not.toHaveBeenCalled();
    expect(consumePendingChatStart).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('ai_hub_chat_id_acme')).toBeNull();
  });

  test('hides the navigation buttons and keeps links on the app page', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    // Auto-start puts a turn on screen, which is when the message list renders.
    renderEmbedded({ ...APP, autoStart: true });
    await screen.findAllByTestId('composer');

    expect(mockHeader.props.showBackButton).toBe(false);
    expect(mockHeader.props.showEditAppButton).toBe(false);
    await waitFor(() => expect(mockMessageList.props?.linkPath).toBe('/ihub/apps/acme'));

    // The canvas opens in a new tab instead of navigating the host away.
    mockHeader.props.onOpenCanvas();
    expect(open).toHaveBeenCalledWith('/ihub/apps/acme/canvas', '_blank', 'noopener,noreferrer');
    expect(screen.getByTestId('location')).toHaveTextContent(HOST_URL);
    open.mockRestore();
  });
});

describe('AppChat on its own route (unchanged)', () => {
  test("uses the tab's chat, remembers the app and shows the navigation", async () => {
    sessionStorage.setItem('ai_hub_chat_id_acme', 'chat-of-the-app-page');
    mockCapability.persistence = false;
    renderOnRoute();
    await screen.findAllByTestId('composer');

    expect(mockHeader.props.chatId).toBe('chat-of-the-app-page');
    expect(mockHeader.props.showBackButton).toBe(true);
    expect(mockHeader.props.showEditAppButton).toBe(true);
    expect(mockHeader.props.onOpenCanvas).toBeUndefined();
    expect(recordAppUsage).toHaveBeenCalledWith('acme');
    await waitFor(() => expect(saveAppSettings).toHaveBeenCalled());
    expect(mockAppSettingsCalls.every(options => options?.isolated === false)).toBe(true);
  });
});
