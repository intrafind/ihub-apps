import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Sending while an attachment is still being processed (issue #2835), driven
 * through the real `AppChat` and the real `useFileUploadHandler`.
 *
 * AppChat mounts a composer for the phone layout and another for the desktop
 * layout at the same time; CSS shows either. Extracting the audio of a video
 * takes a while, and the composer that comes into view after a resize has to
 * know that one is under way in the other: its Send and AppChat's own submit
 * hold back until the attachment is there.
 *
 * The composer and the start form are stubs that report their uploader the way
 * the real ones do (`onAttachmentProcessingChange(id, busy)`) and submit without
 * a check of their own, so what is asserted is the page's: the state it shares
 * and the guard in its submit. The real composers and the real start form are
 * covered by send-while-attaching.test.jsx.
 *
 * The mock setup mirrors app-chat-start-form.test.jsx.
 */
jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => `uuid-${(global.__uuidSeq = (global.__uuidSeq || 0) + 1)}`
}));

// Every hook stubbed below returns a *stable* identity: `AppChat` has effects
// keyed on these objects, and a fresh one per render turns them into loops.
const mockT = (key, def, opts) =>
  typeof def === 'string'
    ? def.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? `{{${name}}}`))
    : key;
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
  buildApiUrl: path => `/api/${path}`,
  buildPath: path => path
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
jest.mock('../../../client/src/api/endpoints/sources', () => ({
  __esModule: true,
  fetchSourceContent: jest.fn(),
  fetchSourceMetadata: jest.fn()
}));

// Capture the SSE handler so the test decides when the stream reports itself
// connected — which is when the request is actually made.
const mockStream = { onEvent: null, opened: 0 };
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: ({ onEvent }) => {
    mockStream.onEvent = onEvent;
    return {
      initEventSource: () => {
        mockStream.opened += 1;
      },
      detachEventSource: () => {},
      stopEventSource: () => {}
    };
  }
}));

// By default a transcript that lives in this tab: every request posts the
// whole history, so what earlier turns carry is visible in the payload.
const mockPersistence = { on: false };
jest.mock('../../../client/src/shared/hooks/useChats', () => ({
  __esModule: true,
  invalidateChatsCache: jest.fn(),
  useChatPersistence: () => mockPersistence.on,
  useChatPersistenceResolving: () => false
}));

const mockNoop = () => {};
const mockSettings = {
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
  ephemeral: false,
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
  setEphemeral: mockNoop,
  modelsLoading: false
};
jest.mock('../../../client/src/shared/hooks/useAppSettings', () => ({
  __esModule: true,
  default: () => mockSettings
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
// Voice mode (issue #2868) has its own tests; the chat page only renders its
// button and overlay, so it is switched off here.
jest.mock('../../../client/src/features/voice/hooks/useVoiceModeAvailability', () => ({
  __esModule: true,
  default: () => ({
    available: false,
    reason: 'feature-off',
    settings: { maxSessionMinutes: 30 },
    speech: { service: 'browser', modelId: '' },
    ttsModelId: ''
  })
}));
jest.mock('../../../client/src/features/voice/hooks/useVoiceMode', () => ({
  __esModule: true,
  default: () => ({ active: false, toggle: () => {}, end: () => {} })
}));
jest.mock('../../../client/src/features/voice/components/VoiceModeOverlay', () => ({
  __esModule: true,
  default: () => null
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
// The compare view renders the form it is handed and records what is
// broadcast to its panels.
const mockCompare = { sent: [] };
jest.mock('../../../client/src/features/chat/components/CompareModeView', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: React.forwardRef(function MockCompareModeView({ startForm }, ref) {
      React.useImperativeHandle(ref, () => ({
        sendMessage: message => mockCompare.sent.push(message),
        clearAll: () => {},
        cancelAll: () => {}
      }));
      return <div data-testid="compare-view">{startForm}</div>;
    })
  };
});
jest.mock('../../../client/src/features/chat/components/StarterPromptsView', () => ({
  __esModule: true,
  default: () => <div data-testid="starter-prompts" />
}));
jest.mock('../../../client/src/features/chat/components/GreetingView', () => ({
  __esModule: true,
  default: () => <div data-testid="greeting" />
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

// A composer: it shows the page's answer on its form, and a button stands in for
// its uploader, reporting the way the real one does. No guard of its own, so a
// submit reaches AppChat whatever the state.
jest.mock('../../../client/src/features/chat/components/ChatInput', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: function MockChatInput({
      formRef,
      onSubmit,
      onChange,
      value,
      isAttachmentProcessing,
      onAttachmentProcessingChange
    }) {
      const id = React.useId();
      return (
        <form
          ref={formRef}
          onSubmit={onSubmit}
          data-testid="composer"
          data-attachment-processing={String(isAttachmentProcessing)}
        >
          <input data-testid="composer-input" value={value} onChange={onChange} />
          <button type="button" onClick={() => onAttachmentProcessingChange(id, true)}>
            file starts processing
          </button>
          <button type="button" onClick={() => onAttachmentProcessingChange(id, false)}>
            file is processed
          </button>
        </form>
      );
    }
  };
});
jest.mock('../../../client/src/features/chat/components/ChatStartForm', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: function MockChatStartForm({
      onSubmit,
      isAttachmentProcessing,
      onAttachmentProcessingChange
    }) {
      const id = React.useId();
      return (
        <form
          onSubmit={onSubmit}
          data-testid="start-form"
          data-attachment-processing={String(isAttachmentProcessing)}
        >
          <button type="button" onClick={() => onAttachmentProcessingChange(id, true)}>
            file starts processing
          </button>
          <button type="button" onClick={() => onAttachmentProcessingChange(id, false)}>
            file is processed
          </button>
        </form>
      );
    }
  };
});

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  greeting: { en: 'Hello there' },
  prompt: { en: 'Summarise: {{content}}' },
  variables: []
};

function renderApp(app = APP, url = '/apps/acme') {
  window.history.replaceState({}, '', url);
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/apps/:appId" element={<AppChat preloadedApp={app} />} />
        <Route path="/apps/:appId/c/:chatId" element={<AppChat preloadedApp={app} />} />
      </Routes>
    </MemoryRouter>
  );
}

const startProcessing = (index = 0) =>
  fireEvent.click(screen.getAllByRole('button', { name: 'file starts processing' })[index]);
const finishProcessing = (index = 0) =>
  fireEvent.click(screen.getAllByRole('button', { name: 'file is processed' })[index]);

beforeEach(() => {
  mockStream.onEvent = null;
  mockStream.opened = 0;
  mockHeader.props = null;
  mockMessageList.props = null;
  mockPersistence.on = false;
  mockCompare.sent.length = 0;
  sessionStorage.clear();
});

describe('AppChat while an attachment is being processed', () => {
  test('tells every composer, not only the one the file was dropped on', async () => {
    renderApp();
    const composers = await screen.findAllByTestId('composer');
    // The phone layout and the desktop layout
    expect(composers.length).toBeGreaterThan(1);
    composers.forEach(composer =>
      expect(composer).toHaveAttribute('data-attachment-processing', 'false')
    );

    startProcessing(0);
    screen
      .getAllByTestId('composer')
      .forEach(composer => expect(composer).toHaveAttribute('data-attachment-processing', 'true'));

    finishProcessing(0);
    screen
      .getAllByTestId('composer')
      .forEach(composer => expect(composer).toHaveAttribute('data-attachment-processing', 'false'));
  });

  test('sends nothing from the composer that was not told by its own uploader', async () => {
    renderApp();
    await screen.findAllByTestId('composer');
    // The file is on its way in the first composer; the second one is submitted
    startProcessing(0);
    fireEvent.change(screen.getAllByTestId('composer-input')[1], {
      target: { value: 'Summarise the call' }
    });

    fireEvent.submit(screen.getAllByTestId('composer')[1]);

    expect(mockStream.opened).toBe(0);
    expect(screen.queryByTestId('transcript')).toBeNull();
  });

  test('sends as soon as the attachment is there', async () => {
    renderApp();
    await screen.findAllByTestId('composer');
    startProcessing(0);
    fireEvent.change(screen.getAllByTestId('composer-input')[1], {
      target: { value: 'Summarise the call' }
    });
    fireEvent.submit(screen.getAllByTestId('composer')[1]);
    expect(mockStream.opened).toBe(0);

    finishProcessing(0);
    fireEvent.submit(screen.getAllByTestId('composer')[1]);

    expect(mockStream.opened).toBe(1);
    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent('Summarise the call');
  });

  test('waits for every uploader that is busy', async () => {
    renderApp();
    await screen.findAllByTestId('composer');
    startProcessing(0);
    startProcessing(1);
    fireEvent.change(screen.getAllByTestId('composer-input')[0], {
      target: { value: 'Summarise the call' }
    });

    finishProcessing(0);
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    expect(mockStream.opened).toBe(0);

    finishProcessing(1);
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    expect(mockStream.opened).toBe(1);
  });

  test('holds back the start form, too, until its attachment is there', async () => {
    renderApp({ ...APP, startForm: { enabled: true } });
    await screen.findByTestId('start-form');
    expect(screen.getByTestId('start-form')).toHaveAttribute('data-attachment-processing', 'false');

    startProcessing();
    expect(screen.getByTestId('start-form')).toHaveAttribute('data-attachment-processing', 'true');
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(mockStream.opened).toBe(0);
    expect(screen.getByTestId('start-form')).toBeInTheDocument();

    finishProcessing();
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(mockStream.opened).toBe(1);
    expect(screen.queryByTestId('start-form')).toBeNull();
  });
});
