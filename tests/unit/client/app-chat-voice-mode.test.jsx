import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

/**
 * `AppChat` and voice mode (issue #2868): what the page does with a spoken turn.
 *
 * Voice mode itself (hook, dock) has its own suites and is replaced by a
 * stand-in here that records the options the page hands it. What is covered is
 * the page's side of the contract:
 *
 * - a spoken turn goes out like a typed one, flagged `params.voiceMode` and
 *   marked `inputMode: 'voice'` in the message, and a typed one is neither;
 * - a spoken turn leaves the composer alone: the draft in it stays, and so do
 *   the files staged in it (they belong to the typed message they were added
 *   for, and an audio file the model cannot take would reject every turn);
 * - voice mode ends when the chat or the app changes;
 * - while voice mode is open, the dock takes the composer's place, once: the
 *   composers stay mounted (hidden and `inert`), the transcript stays usable
 *   but its messages cannot be edited.
 *
 * The mock setup mirrors app-chat-embedded.test.jsx; `useAppChat` is stubbed so
 * the message the page builds can be read as it is handed to `sendMessage`.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => `uuid-${(global.__uuidSeq = (global.__uuidSeq || 0) + 1)}`
}));

// Every hook stubbed below returns a *stable* identity: `AppChat` has effects
// keyed on these objects, and a fresh one per render turns them into loops.
const mockT = (key, def, opts) => {
  const options = typeof def === 'object' && def ? def : opts;
  const text =
    typeof def === 'string' ? def : (options?.defaultValue_other ?? options?.defaultValue);
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''));
};
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
    detachEventSource: jest.fn(),
    stopEventSource: jest.fn()
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
  isAttachmentProcessing: false,
  showUploader: false,
  handleFileSelect: mockNoop,
  createUploadConfig: () => mockUploadConfig,
  toggleUploader: mockNoop,
  hideUploader: jest.fn(),
  clearSelectedFile: jest.fn(),
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
// Voice mode is available for this app; the hook is a stand-in that holds
// `active` in real state (so the page re-renders when a test flips it) and
// records what the page passes in.
const mockVoiceMode = { options: null, end: null, setActive: null, answerInChat: null };
jest.mock('../../../client/src/features/voice/hooks/useVoiceModeAvailability', () => ({
  __esModule: true,
  default: () => ({
    available: true,
    reason: null,
    settings: { maxSessionMinutes: 30 },
    speech: { service: 'browser', modelId: '' },
    ttsModelId: 'tts-1'
  })
}));
jest.mock('../../../client/src/features/voice/hooks/useVoiceMode', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: options => {
      const [active, setActive] = React.useState(false);
      mockVoiceMode.options = options;
      mockVoiceMode.setActive = setActive;
      return React.useMemo(
        () => ({
          active,
          toggle: () => setActive(value => !value),
          end: mockVoiceMode.end,
          answerInChat: mockVoiceMode.answerInChat
        }),
        [active]
      );
    }
  };
});
jest.mock('../../../client/src/features/voice/components/VoiceModeDock', () => ({
  __esModule: true,
  default: ({ value, onChange }) => (
    <textarea data-testid="voice-dock" value={value} onChange={e => onChange(e.target.value)} />
  )
}));
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
    return (
      <div data-testid="transcript" data-editable={String(props.editable)}>
        {props.messages.map(m => m.content).join('|')}
      </div>
    );
  }
}));
// A real <form> with a text field and a submit button: a typed turn is the
// page's own submit with whatever is in the field.
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: function MockChatInput({ formRef, onSubmit, onChange, value, voiceModeActive }) {
    const React = require('react');
    // Counts mounts: voice mode must hide the composer, never remount it.
    React.useEffect(() => {
      mockComposerMounts.count += 1;
    }, []);
    return (
      <form ref={formRef} onSubmit={onSubmit} data-testid="composer" data-voice={voiceModeActive}>
        <textarea aria-label="typed" value={value} onChange={onChange} />
        <button type="submit">send</button>
      </form>
    );
  }
}));
const mockComposerMounts = { count: 0 };

// `useAppChat` is stubbed: the tests read what the page hands to `sendMessage`.
const mockChat = {
  messages: [],
  sendMessage: jest.fn(),
  addSystemMessage: jest.fn(),
  submitClarificationResponse: jest.fn()
};
jest.mock('../../../client/src/features/chat/hooks/useAppChat', () => {
  const noop = () => {};
  // One object for every render: the page has effects keyed on these.
  const chat = {
    get messages() {
      return mockChat.messages;
    },
    hydrating: false,
    finishHydration: noop,
    processing: false,
    clarificationPending: false,
    sendMessage: (...args) => mockChat.sendMessage(...args),
    resendMessage: noop,
    deleteMessage: noop,
    editMessage: noop,
    clearMessages: noop,
    cancelGeneration: noop,
    addSystemMessage: (...args) => mockChat.addSystemMessage(...args),
    submitClarificationResponse: (...args) => mockChat.submitClarificationResponse(...args),
    conversationTitle: null,
    loadServerMessages: noop,
    reattachToRun: noop,
    resetConversationState: noop,
    addUserMessage: noop,
    addAssistantMessage: noop,
    updateAssistantMessage: noop,
    removeMessage: noop
  };
  return { __esModule: true, default: () => chat };
});

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  greeting: { en: 'Hello there' },
  variables: []
};

let navigateTo = null;
function NavigationProbe() {
  navigateTo = useNavigate();
  return null;
}

function renderChat(path = '/apps/acme/c/chat-1') {
  window.history.replaceState({}, '', path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/apps/:appId/c/:chatId" element={<AppChat preloadedApp={APP} />} />
      </Routes>
      <NavigationProbe />
    </MemoryRouter>
  );
}

/** The structure the page handed to `sendMessage` for its only (last) call. */
const sent = () => {
  expect(mockChat.sendMessage).toHaveBeenCalledTimes(1);
  return mockChat.sendMessage.mock.calls[0][0];
};
const typedField = () => screen.getAllByLabelText('typed')[0];
const submitTyped = () => fireEvent.submit(screen.getAllByTestId('composer')[0]);
const speak = async text => {
  let taken;
  await act(async () => {
    taken = await mockVoiceMode.options.sendTurn(text);
  });
  return taken;
};

const STAGED_IMAGE = {
  type: 'image',
  fileName: 'cat.png',
  base64: 'data:image/png;base64,AAAA'
};
const STAGED_AUDIO = { type: 'audio', fileName: 'memo.wav', base64: 'data:audio/wav;base64,AAAA' };

beforeEach(() => {
  mockCapability.persistence = false;
  mockCapability.resolving = false;
  jest.clearAllMocks();
  mockVoiceMode.end = jest.fn();
  mockChat.messages = [];
  mockUploadHandler.selectedFile = null;
  sessionStorage.clear();
});

describe('a spoken turn', () => {
  test('goes out like a typed one, flagged as a voice turn and marked as spoken', async () => {
    renderChat();
    await screen.findAllByTestId('composer');

    expect(await speak('what is the capital of France')).toBe(true);

    const turn = sent();
    expect(turn.params.voiceMode).toBe(true);
    expect(turn.displayMessage.meta.inputMode).toBe('voice');
    expect(turn.displayMessage.content).toBe('what is the capital of France');
    expect(turn.apiMessage.content).toBe('what is the capital of France');
    // The app's own settings travel with it, like for a typed turn.
    expect(turn.params.modelId).toBe('model-x');
    // A temperature is not among them: the model decides its own sampling.
    expect(turn.params).not.toHaveProperty('temperature');
  });

  test('typed into the voice dock: answered as a voice turn, but not marked as spoken', async () => {
    renderChat();
    await screen.findAllByTestId('composer');

    let taken;
    await act(async () => {
      taken = await mockVoiceMode.options.sendTurn('and Rome?', { typed: true });
    });
    expect(taken).toBe(true);

    const turn = sent();
    expect(turn.params.voiceMode).toBe(true);
    expect('inputMode' in turn.displayMessage.meta).toBe(false);
    expect(turn.apiMessage.content).toBe('and Rome?');
  });

  test('a typed turn is neither flagged nor marked', async () => {
    renderChat();
    await screen.findAllByTestId('composer');

    fireEvent.change(typedField(), { target: { value: 'typed question' } });
    submitTyped();

    const turn = sent();
    expect('voiceMode' in turn.params).toBe(false);
    expect(turn.params).not.toHaveProperty('temperature');
    expect('inputMode' in turn.displayMessage.meta).toBe(false);
    expect(turn.apiMessage.content).toBe('typed question');
    // ... and it empties the composer, which a spoken turn does not.
    await waitFor(() => expect(typedField()).toHaveValue(''));
  });

  test('is turned away when there is nothing to say', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    expect(await speak('   ')).toBe(false);
    expect(mockChat.sendMessage).not.toHaveBeenCalled();
  });

  test('leaves the draft in the composer alone', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    fireEvent.change(typedField(), { target: { value: 'a half written draft' } });

    await speak('spoken sentence');

    const turn = sent();
    expect(turn.apiMessage.content).toBe('spoken sentence');
    expect(typedField()).toHaveValue('a half written draft');
  });

  test('answers a question the app asked, spoken, as a voice turn', async () => {
    renderChat();
    await screen.findAllByTestId('composer');

    mockVoiceMode.options.answerClarification('the second one');

    expect(mockChat.submitClarificationResponse).toHaveBeenCalledWith(
      'the second one',
      expect.objectContaining({ voiceMode: true, modelId: 'model-x' })
    );
    expect(mockChat.submitClarificationResponse.mock.calls[0][1]).not.toHaveProperty('temperature');
  });

  test('tells the chat when voice mode ran out of time, and says nothing when the user ended it', async () => {
    renderChat();
    await screen.findAllByTestId('composer');

    mockVoiceMode.options.onEnded('user');
    expect(mockChat.addSystemMessage).not.toHaveBeenCalled();

    mockVoiceMode.options.onEnded('time-limit');
    expect(mockChat.addSystemMessage).toHaveBeenCalledWith(
      'Voice mode ended after 30 minutes.',
      false
    );
  });
});

describe('files staged in the composer', () => {
  test('stay staged and out of the request when a turn is spoken', async () => {
    mockUploadHandler.selectedFile = STAGED_IMAGE;
    renderChat();
    await screen.findAllByTestId('composer');

    await speak('an unrelated sentence');

    const turn = sent();
    expect(turn.apiMessage.imageData).toBeNull();
    expect(turn.apiMessage.audioData).toBeNull();
    expect(turn.apiMessage.fileData).toBeNull();
    expect(turn.displayMessage.meta.imageData).toBeUndefined();
    expect(turn.displayMessage.content).toBe('an unrelated sentence');
    expect(mockUploadHandler.clearSelectedFile).not.toHaveBeenCalled();
    expect(mockUploadHandler.hideUploader).not.toHaveBeenCalled();
  });

  test('go out with the typed message they were added for, and are cleared by it', async () => {
    mockUploadHandler.selectedFile = STAGED_IMAGE;
    renderChat();
    await screen.findAllByTestId('composer');
    fireEvent.change(typedField(), { target: { value: 'what is on this picture' } });

    submitTyped();

    const turn = sent();
    expect(turn.apiMessage.imageData).toEqual(STAGED_IMAGE);
    expect(turn.displayMessage.meta.imageData).toEqual(STAGED_IMAGE);
    expect(mockUploadHandler.clearSelectedFile).toHaveBeenCalledTimes(1);
    expect(mockUploadHandler.hideUploader).toHaveBeenCalledTimes(1);
  });

  test('an audio file the model cannot take does not reject a spoken turn', async () => {
    mockUploadHandler.selectedFile = STAGED_AUDIO;
    renderChat();
    await screen.findAllByTestId('composer');

    expect(await speak('hello')).toBe(true);

    expect(sent().apiMessage.audioData).toBeNull();
    expect(mockChat.addSystemMessage).not.toHaveBeenCalled();
  });

  test('the same audio file still stops a typed turn: the model takes no audio', async () => {
    mockUploadHandler.selectedFile = STAGED_AUDIO;
    renderChat();
    await screen.findAllByTestId('composer');
    fireEvent.change(typedField(), { target: { value: 'transcribe this' } });

    submitTyped();

    expect(mockChat.sendMessage).not.toHaveBeenCalled();
    expect(mockChat.addSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot process audio'),
      true
    );
  });

  test('do not make a spoken turn out of nothing: a file alone is no sentence', async () => {
    mockUploadHandler.selectedFile = STAGED_IMAGE;
    renderChat();
    await screen.findAllByTestId('composer');
    expect(await speak('  ')).toBe(false);
    expect(mockChat.sendMessage).not.toHaveBeenCalled();
  });
});

describe('voice mode ends with the conversation it was started in', () => {
  test('when the chat changes', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    mockVoiceMode.end.mockClear();

    await act(async () => {
      navigateTo('/apps/acme/c/chat-2');
    });

    await waitFor(() => expect(mockVoiceMode.end).toHaveBeenCalledWith('user'));
  });

  test('and not on an ordinary re-render', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    mockVoiceMode.end.mockClear();

    fireEvent.change(typedField(), { target: { value: 'typing' } });

    expect(mockVoiceMode.end).not.toHaveBeenCalled();
  });
});

describe('while voice mode is open', () => {
  const open = async () => {
    // A chat with a turn in it, so the transcript is on the page.
    mockChat.messages = [{ id: 'm1', role: 'user', content: 'an earlier question' }];
    renderChat();
    await screen.findAllByTestId('composer');
    act(() => mockVoiceMode.setActive(true));
    return screen.getByTestId('voice-dock');
  };

  afterEach(() => {
    delete window.matchMedia;
  });

  test('the dock takes the place of the composer, once', async () => {
    await open();
    // The phone and the desktop layout each have a composer slot; the dock's
    // keyboard listeners are on the window, so there is only one.
    expect(screen.getAllByTestId('voice-dock')).toHaveLength(1);
    const composers = screen.getAllByTestId('composer');
    expect(composers.length).toBeGreaterThan(1);
    for (const composer of composers) {
      const wrapper = composer.closest('[hidden]');
      expect(wrapper).not.toBeNull();
      expect(wrapper).toHaveAttribute('inert');
    }
    expect(screen.getByTestId('voice-dock').closest('[hidden]')).toBeNull();
    // jsdom has no matchMedia, so the screen counts as a phone.
    expect(screen.getByTestId('voice-dock').closest('.md\\:hidden')).not.toBeNull();
  });

  test('the dock is in the layout the screen shows', async () => {
    // jsdom has no matchMedia: the phone layout. With a desktop-wide screen
    // the dock moves to the desktop layout.
    window.matchMedia = jest.fn(query => ({
      matches: query === '(min-width: 48rem)',
      addEventListener: () => {},
      removeEventListener: () => {}
    }));
    const dock = await open();
    expect(dock.closest('.md\\:hidden')).toBeNull();
  });

  test('the dock looks for the answer it reads out in the chat column', async () => {
    const dock = await open();
    expect(dock.closest('[data-voice-scope]')).not.toBeNull();
  });

  test('the transcript stays usable: nothing in it is inert or hidden', async () => {
    await open();
    for (const transcript of screen.getAllByTestId('transcript')) {
      expect(transcript.closest('[inert]')).toBeNull();
      expect(transcript.closest('[hidden]')).toBeNull();
    }
  });

  test('its messages cannot be edited: an edit starts a typed run', async () => {
    await open();
    for (const transcript of screen.getAllByTestId('transcript')) {
      expect(transcript).toHaveAttribute('data-editable', 'false');
    }
    act(() => mockVoiceMode.setActive(false));
    for (const transcript of screen.getAllByTestId('transcript')) {
      expect(transcript).toHaveAttribute('data-editable', 'true');
    }
  });

  test("the dock types into the composer's draft, both ways", async () => {
    await open();
    fireEvent.change(typedField(), { target: { value: 'a draft' } });
    expect(screen.getByTestId('voice-dock')).toHaveValue('a draft');
    fireEvent.change(screen.getByTestId('voice-dock'), { target: { value: 'typed in voice' } });
    expect(typedField()).toHaveValue('typed in voice');
  });

  test('the composer is hidden, never remounted: an attachment in progress survives', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    const mounted = mockComposerMounts.count;
    act(() => mockVoiceMode.setActive(true));
    act(() => mockVoiceMode.setActive(false));
    expect(mockComposerMounts.count).toBe(mounted);
  });

  test("the app's question answered in the chat goes through voice mode", async () => {
    mockVoiceMode.answerInChat = jest.fn();
    await open();
    const response = { questionId: 'q1', answered: true, skipped: false, value: 'red' };
    act(() => mockMessageList.props.onClarificationSubmit(response));
    act(() => mockMessageList.props.onClarificationSkip({ ...response, skipped: true }));
    expect(mockVoiceMode.answerInChat).toHaveBeenCalledTimes(2);
    expect(mockVoiceMode.answerInChat).toHaveBeenCalledWith(response);
  });

  test('the composer is told voice mode is open', async () => {
    await open();
    for (const composer of screen.getAllByTestId('composer')) {
      expect(composer).toHaveAttribute('data-voice', 'true');
    }
  });

  test('nothing is hidden before it opens or after it closes', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    expect(document.querySelector('[inert]')).toBeNull();
    expect(screen.queryByTestId('voice-dock')).toBeNull();

    act(() => mockVoiceMode.setActive(true));
    expect(document.querySelector('[inert]')).not.toBeNull();

    act(() => mockVoiceMode.setActive(false));
    expect(document.querySelector('[inert]')).toBeNull();
    expect(screen.queryByTestId('voice-dock')).toBeNull();
  });
});

describe('answering a question the app asked in a project chat', () => {
  // A chat that is not stored server-side has no stored chat the server could
  // recover the container from: every answer has to carry it (#1036).
  beforeEach(() => {
    // A chat with a turn in it, so the transcript is on the page.
    mockChat.messages = [{ id: 'm1', role: 'assistant', content: 'Which colour?' }];
  });

  test('sends the container project with every kind of answer', async () => {
    renderChat('/apps/acme/c/chat-1?project=prj_case');
    await screen.findAllByTestId('composer');
    const response = { questionId: 'q1', answered: true, skipped: false, value: 'red' };

    act(() => mockMessageList.props.onClarificationSubmit(response));
    act(() => mockMessageList.props.onClarificationSkip({ ...response, skipped: true }));
    mockVoiceMode.options.answerClarification('the second one');

    expect(mockChat.submitClarificationResponse).toHaveBeenCalledTimes(3);
    for (const [, params] of mockChat.submitClarificationResponse.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({ projectId: 'prj_case', modelId: 'model-x' })
      );
    }
    expect(mockChat.submitClarificationResponse.mock.calls[2][1].voiceMode).toBe(true);
  });

  test('sends no project outside one', async () => {
    renderChat();
    await screen.findAllByTestId('composer');
    act(() =>
      mockMessageList.props.onClarificationSubmit({ questionId: 'q1', answered: true, value: 1 })
    );
    expect(mockChat.submitClarificationResponse.mock.calls[0][1]).not.toHaveProperty('projectId');
  });
});
