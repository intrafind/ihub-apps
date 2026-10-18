import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The usage guide (issue #2838), driven through the real `AppChat`.
 *
 * The guide is help, not a conversation turn: one "Usage guide" control — in the
 * same place in every state — opens it in a dialog, and nothing is added to the
 * transcript, so the starter prompts stay and the model never sees it.
 *
 * The mock setup mirrors app-chat-start-form.test.jsx; `useAppChat`, the starter
 * prompts, the start form and the guide dialog are real.
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
      stopEventSource: jest.fn()
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

// Upload state held in real React state, so a file picked in the form shows up
// in what the page sends.
const mockUpload = { config: { enabled: false, localUploadEnabled: false }, dropped: null };
jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: () => {
      const [selectedFile, setSelectedFile] = React.useState(null);
      return React.useMemo(
        () => ({
          selectedFile,
          showUploader: false,
          handleFileSelect: setSelectedFile,
          createUploadConfig: () => mockUpload.config,
          toggleUploader: () => {},
          hideUploader: () => {},
          clearSelectedFile: () => setSelectedFile(null),
          setSelectedFile
        }),
        [selectedFile]
      );
    }
  };
});
// The drop zone itself is covered by the upload suites; here a button stands
// in for a dropped file.
const DROPPED = { type: 'document', fileName: 'brief.txt', fileType: 'text/plain', content: 'x' };
jest.mock('../../../client/src/features/upload/components/UnifiedUploader', () => ({
  __esModule: true,
  default: ({ onFileSelect, children }) => (
    <div data-testid="drop-target">
      <button type="button" onClick={() => onFileSelect(mockUpload.dropped)}>
        drop a file
      </button>
      {children}
    </div>
  )
}));
jest.mock('../../../client/src/features/upload/components/AttachedFilesList', () => ({
  __esModule: true,
  default: ({ files }) => (
    <ul data-testid="attached">
      {files.map(f => (
        <li key={f.fileName}>{f.fileName}</li>
      ))}
    </ul>
  )
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
// The dialog's body is the guide's markdown; the markdown renderer has suites of its own.
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="guide-body">{content}</div>
}));
// The composer renders what AppChat hands it for the line below the input.
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ formRef, onSubmit, onChange, value, leadingAction }) => (
    <form ref={formRef} onSubmit={onSubmit} data-testid="composer">
      <input data-testid="composer-input" value={value} onChange={onChange} />
      <div data-testid="composer-leading">{leadingAction}</div>
    </form>
  )
}));

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;
const { fetchChat, sendAppChatMessage } = require('../../../client/src/api');

const GUIDE = {
  question: { en: 'How do I use Acme?' },
  content: { en: '1. Pick a prompt.\n2. Send it.' }
};

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  system: { en: 'You help.' },
  prompt: { en: '{{content}}' },
  starterPrompts: [{ title: { en: 'Summarize' }, message: { en: 'Summarize this' } }],
  usageGuide: GUIDE
};

const START_FORM_APP = {
  ...APP,
  starterPrompts: undefined,
  prompt: { en: 'Write to {{recipient}}.\n\n{{content}}' },
  variables: [
    { name: 'recipient', label: { en: 'Recipient' }, placeholder: { en: 'Who' }, type: 'string' }
  ],
  startForm: { enabled: true, submitLabel: { en: 'Draft it' } }
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

/** The guide control in the line below the first composer. */
const composerGuideButton = () =>
  within(screen.getAllByTestId('composer-leading')[0]).getByRole('button', {
    name: /usage guide/i
  });

beforeEach(() => {
  mockStream.onEvent = null;
  mockStream.opened = 0;
  mockHeader.props = null;
  mockMessageList.props = null;
  mockUpload.config = { enabled: false, localUploadEnabled: false };
  mockUpload.dropped = DROPPED;
  mockPersistence.on = false;
  mockCompare.sent.length = 0;
  fetchChat.mockReset();
  sendAppChatMessage.mockClear();
  sessionStorage.clear();
});

describe('AppChat usage guide', () => {
  test('the start screen offers the guide under the input and under the starter prompts', async () => {
    renderApp();
    await screen.findAllByTestId('composer');

    // Under the input, in the line the composer reserves for it ...
    expect(composerGuideButton()).toBeInTheDocument();
    // ... and as a plain text link in the starter prompts' subtitle. No pill
    // sits between the prompt cards and the input any more.
    expect(screen.getAllByText('New here?').length).toBeGreaterThan(0);
    expect(screen.queryByText('How do I use Acme?')).toBeNull();
  });

  test('opening the guide shows a dialog and adds nothing to the chat', async () => {
    renderApp();
    await screen.findAllByTestId('composer');

    fireEvent.click(composerGuideButton());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'How do I use Acme?' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('guide-body')).toHaveTextContent('Pick a prompt.');
    // No transcript was started, and the starter prompts are still there.
    expect(screen.queryByTestId('transcript')).toBeNull();
    expect(screen.getAllByText('Summarize').length).toBeGreaterThan(0);
    expect(sendAppChatMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('the link under the starter prompts opens the same dialog', async () => {
    renderApp();
    await screen.findAllByTestId('composer');

    const link = within(screen.getAllByText('New here?')[0].closest('p')).getByRole('button', {
      name: 'Usage guide'
    });
    fireEvent.click(link);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript')).toBeNull();
  });

  test('in a running chat the control stays and still leaves the transcript alone', async () => {
    renderApp();
    await screen.findAllByTestId('composer');
    fireEvent.change(screen.getAllByTestId('composer-input')[0], { target: { value: 'Hello' } });
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    await screen.findAllByTestId('transcript');
    const before = screen.getAllByTestId('transcript')[0].textContent;
    expect(before).toContain('Hello');

    // The starter prompts are gone with the start screen; the guide is not.
    expect(screen.queryByText('New here?')).toBeNull();
    fireEvent.click(composerGuideButton());

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('transcript')[0].textContent).toBe(before);
  });

  test('the start form has the control in its action row', async () => {
    renderApp(START_FORM_APP);
    const form = await screen.findByTestId('start-form');

    fireEvent.click(within(form).getByRole('button', { name: /usage guide/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'How do I use Acme?' })).toBeInTheDocument();
    // Still the form: the guide did not start a chat.
    expect(screen.getByTestId('start-form')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript')).toBeNull();
  });

  test('without a guide there is no control and no link', async () => {
    renderApp({ ...APP, usageGuide: undefined });
    await screen.findAllByTestId('composer');

    expect(screen.queryByRole('button', { name: /usage guide/i })).toBeNull();
    expect(screen.queryByText('New here?')).toBeNull();
  });

  test('a guide without its own question is headed by the built-in one', async () => {
    renderApp({ ...APP, usageGuide: { content: GUIDE.content } });
    await screen.findAllByTestId('composer');

    fireEvent.click(composerGuideButton());

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'How do I use this app?' })
    ).toBeInTheDocument();
  });
});
