import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * `AppChat` transcribing audio with the app's transcription model.
 *
 * A transcript is rendered client-side as an assistant turn — it never goes
 * through the server's chat run, which is what reports `answerSource` for every
 * other answer. Without a source of its own, the badge under the transcript fell
 * back to "Based on AI knowledge" although the text is the user's own audio.
 *
 * The mock setup mirrors app-chat-embedded.test.jsx.
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
// Admin → Voice Input can set a platform-wide default transcription model.
const mockPlatform = { config: null };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  ...jest.requireActual('../../../client/src/shared/contexts/PlatformConfigContext'),
  __esModule: true,
  usePlatformConfig: () => ({
    platformConfig: mockPlatform.config,
    isLoading: false,
    error: null,
    refreshConfig: () => {}
  })
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
const { transcribeAudioBuffer } = require('../../../client/src/utils/transcribeAudioBuffer');
const {
  decodeAudioFileToBuffer
} = require('../../../client/src/features/upload/utils/fileProcessing');

const TRANSCRIPTION_APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'microphone',
  greeting: { en: 'Hello there' },
  variables: [],
  transcription: { enabled: true, modelId: 'voxtral', streaming: true }
};

const AUDIO = { type: 'audio', fileName: 'memo.mp3', base64: 'AAAA' };

function renderApp(app = TRANSCRIPTION_APP) {
  window.history.replaceState({}, '', '/apps/acme');
  return render(
    <MemoryRouter initialEntries={['/apps/acme']}>
      <Routes>
        <Route path="/apps/:appId" element={<AppChat preloadedApp={app} />} />
      </Routes>
    </MemoryRouter>
  );
}

// Send the composer with an audio file selected, the way the send button does.
async function sendAudio() {
  mockUploadHandler.selectedFile = AUDIO;
  const [composer] = await screen.findAllByTestId('composer');
  await act(async () => {
    fireEvent.submit(composer);
  });
}

const assistantTurns = () =>
  (mockMessageList.props?.messages ?? []).filter(message => message.role === 'assistant');

beforeEach(() => {
  mockStreams.length = 0;
  mockMessageList.props = null;
  mockUploadHandler.selectedFile = null;
  mockCapability.persistence = true;
  mockCapability.resolving = false;
  mockPlatform.config = null;
  jest.clearAllMocks();
  sessionStorage.clear();
  decodeAudioFileToBuffer.mockResolvedValue({ duration: 3 });
});

describe('transcribing audio into the chat', () => {
  test('marks the transcript as built from audio, not from AI knowledge', async () => {
    transcribeAudioBuffer.mockResolvedValue('hello from the recording');
    renderApp();
    await sendAudio();

    await waitFor(() => expect(assistantTurns()[0]?.loading).toBe(false));
    const [turn] = assistantTurns();
    expect(turn.content).toBe('hello from the recording');
    expect(turn.answerSource).toEqual({ sources: ['audio'], type: 'mixed' });
  });

  test('keeps the audio source when the recording holds no speech', async () => {
    transcribeAudioBuffer.mockResolvedValue('');
    renderApp();
    await sendAudio();

    await waitFor(() => expect(assistantTurns()[0]?.loading).toBe(false));
    const [turn] = assistantTurns();
    expect(turn.content).toBe('_(No speech detected)_');
    expect(turn.answerSource).toEqual({ sources: ['audio'], type: 'mixed' });
  });

  test('keeps the audio source on a partial transcript that was interrupted', async () => {
    transcribeAudioBuffer.mockImplementation(async (_buffer, { onDelta }) => {
      onDelta('the part we got');
      throw Object.assign(new Error('closed mid-stream'), { code: 'interrupted' });
    });
    renderApp();
    await sendAudio();

    await waitFor(() => expect(assistantTurns()[0]?.loading).toBe(false));
    const [turn] = assistantTurns();
    expect(turn.content).toContain('the part we got');
    expect(turn.isError).toBeUndefined();
    expect(turn.answerSource).toEqual({ sources: ['audio'], type: 'mixed' });
  });

  test('gives a failed transcription no source — it is an error bubble, not an answer', async () => {
    transcribeAudioBuffer.mockRejectedValue(Object.assign(new Error('down'), { code: 'connect' }));
    renderApp();
    await sendAudio();

    await waitFor(() => expect(assistantTurns()[0]?.loading).toBe(false));
    const [turn] = assistantTurns();
    expect(turn.isError).toBe(true);
    expect(turn.answerSource).toBeUndefined();
  });
});

describe('which transcription model is used', () => {
  const PLATFORM_DEFAULT = { speech: { transcription: { defaultModelId: 'platform-voxtral' } } };

  test('an app without a model of its own uses the platform default', async () => {
    mockPlatform.config = PLATFORM_DEFAULT;
    transcribeAudioBuffer.mockResolvedValue('hello');
    renderApp({ ...TRANSCRIPTION_APP, transcription: { enabled: true, streaming: true } });
    await sendAudio();

    await waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalled());
    expect(transcribeAudioBuffer.mock.calls[0][1].modelId).toBe('platform-voxtral');
  });

  test("the app's own model wins over the platform default", async () => {
    mockPlatform.config = PLATFORM_DEFAULT;
    transcribeAudioBuffer.mockResolvedValue('hello');
    renderApp();
    await sendAudio();

    await waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalled());
    expect(transcribeAudioBuffer.mock.calls[0][1].modelId).toBe('voxtral');
  });
});
