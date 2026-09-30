import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Form-based start (issue #2581), driven through the real `AppChat`.
 *
 * An app with `startForm.enabled` opens a new chat with its variables as a
 * form instead of the composer. Sending the form renders the app's prompt with
 * the answers once, as the first user message; the chat then continues with
 * the composer, and the template is never rendered into a message again.
 *
 * The mock setup mirrors app-chat-embedded.test.jsx; `useAppChat`, the start
 * form and the variable inputs are real.
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
jest.mock('../../../client/src/api/endpoints/documents', () => ({
  __esModule: true,
  fetchIFinderDocument: jest.fn(),
  fetchIFinderDocumentMetadata: jest.fn()
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
      cleanupEventSource: () => {}
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
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ formRef, onSubmit, onChange, value }) => (
    <form ref={formRef} onSubmit={onSubmit} data-testid="composer">
      <input data-testid="composer-input" value={value} onChange={onChange} />
    </form>
  )
}));

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;
const { fetchChat, sendAppChatMessage } = require('../../../client/src/api');
const {
  decodeAudioFileToBuffer
} = require('../../../client/src/features/upload/utils/fileProcessing');
const { transcribeAudioBuffer } = require('../../../client/src/utils/transcribeAudioBuffer');

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  system: { en: 'You write for {{recipient}}.' },
  prompt: { en: 'Write to {{recipient}} about {{subject}}.\n\n{{content}}' },
  variables: [
    {
      name: 'recipient',
      label: { en: 'Recipient' },
      placeholder: { en: 'Who' },
      type: 'string',
      required: true
    },
    { name: 'subject', label: { en: 'Subject' }, placeholder: { en: 'What' }, type: 'text' }
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

let seq = 0;

/** Deliver one SSE v2 frame the way useEventSource does. */
async function deliver(type, data, runId) {
  seq += 1;
  const envelope = { v: 2, seq, runId, ts: new Date(seq * 1000).toISOString(), type, data };
  await act(async () => {
    await mockStream.onEvent({ type, envelope });
  });
}

/** Connect the stream (which posts the queued request) and finish the turn. */
async function answerTurn(runId) {
  const chatId = mockHeader.props.chatId;
  await deliver('stream/connected', { runId: chatId, lastSeq: 0, protocol: 2 }, chatId);
  const messages = mockMessageList.props.messages;
  const assistantId = messages[messages.length - 1].id;
  await deliver('run/started', { kind: 'chat', refs: { chatId, messageId: assistantId } }, runId);
  await deliver('step/delta', { kind: 'text', text: 'Done.' }, runId);
  await deliver('run/ended', { status: 'completed', finishReason: 'stop' }, runId);
}

/** The `messages` of the nth request. */
const requestMessages = index => sendAppChatMessage.mock.calls[index][2];

async function fillAndSend() {
  await screen.findByTestId('start-form');
  fireEvent.change(screen.getByPlaceholderText('Who'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByPlaceholderText('What'), { target: { value: 'the Q3 report' } });
  fireEvent.submit(screen.getByTestId('start-form'));
  await screen.findAllByTestId('composer');
}

beforeEach(() => {
  seq = 0;
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

describe('AppChat with a start form', () => {
  test('a new chat opens with the form instead of the composer and variables panel', async () => {
    renderApp();
    await screen.findByTestId('start-form');

    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Draft it' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Who')).toBeInTheDocument();
    // Only the form asks for the variables.
    expect(screen.queryByText('pages.appChat.inputParameters')).toBeNull();
    expect(mockHeader.props.hideParametersButton).toBe(true);
    // Uploads are off for this app: no drop zone.
    expect(screen.queryByTestId('drop-target')).toBeNull();
  });

  test('a missing required answer keeps the form and sends nothing', async () => {
    renderApp();
    await screen.findByTestId('start-form');
    fireEvent.change(screen.getByPlaceholderText('Who'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('start-form'));

    expect(screen.getByRole('alert')).toHaveTextContent('Recipient');
    expect(screen.getByTestId('start-form')).toBeInTheDocument();
    expect(mockStream.opened).toBe(0);
  });

  test('sending the form posts the rendered prompt once, then the chat goes on without it', async () => {
    renderApp();
    await fillAndSend();

    // The form is gone; the rendered prompt is the first message.
    expect(screen.queryByTestId('start-form')).toBeNull();
    expect(screen.getAllByTestId('transcript')[0]).toHaveTextContent(
      'Write to Ada about the Q3 report.'
    );

    await answerTurn('run-1');
    const first = requestMessages(0);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      role: 'user',
      content: 'Write to Ada about the Q3 report.',
      promptTemplate: null,
      // Sent once, with the form: the server keeps them for the system prompt.
      variables: { recipient: 'Ada', subject: 'the Q3 report' }
    });

    // A follow-up is sent as typed — no template, no required-field check.
    fireEvent.change(screen.getAllByTestId('composer-input')[0], {
      target: { value: 'Make it shorter' }
    });
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    await answerTurn('run-2');

    const second = requestMessages(1);
    expect(second.filter(m => m.role === 'user').map(m => m.content)).toEqual([
      'Write to Ada about the Q3 report.',
      'Make it shorter'
    ]);
    // The first message still carries the variables in the history; the
    // follow-up itself sets none — the server uses the ones the chat has.
    expect(second[0].variables).toEqual({ recipient: 'Ada', subject: 'the Q3 report' });
    expect(second[second.length - 1]).toMatchObject({
      content: 'Make it shorter',
      promptTemplate: null,
      variables: {}
    });
    expect(second.some(m => m.promptTemplate)).toBe(false);
    expect(screen.queryByTestId('start-form')).toBeNull();
  });

  test('regenerating the first answer resends the rendered prompt instead of reopening the form', async () => {
    renderApp();
    await fillAndSend();
    await answerTurn('run-1');

    const messages = mockMessageList.props.messages;
    act(() => {
      mockMessageList.props.onResend(messages[messages.length - 1].id);
    });
    await screen.findAllByTestId('composer');
    expect(screen.queryByTestId('start-form')).toBeNull();

    await answerTurn('run-2');
    const resent = requestMessages(1);
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({
      content: 'Write to Ada about the Q3 report.',
      promptTemplate: null,
      // Still the form's message, so it still sets the variables.
      variables: { recipient: 'Ada', subject: 'the Q3 report' }
    });
  });

  test('with uploads on, a file dropped on the form goes along with the first message', async () => {
    mockUpload.config = { enabled: true, localUploadEnabled: true };
    renderApp();
    await screen.findByTestId('start-form');

    fireEvent.click(screen.getByRole('button', { name: 'drop a file' }));
    expect(screen.getByTestId('attached')).toHaveTextContent('brief.txt');

    await fillAndSend();
    await answerTurn('run-1');
    expect(requestMessages(0)[0]).toMatchObject({
      content: 'Write to Ada about the Q3 report.',
      fileData: DROPPED
    });
  });

  test('a file dropped on the form is transcribed into the rendered prompt, sent once', async () => {
    const audio = { type: 'audio', fileName: 'call.mp3', base64: 'data:audio/mpeg;base64,AA' };
    mockUpload.config = { enabled: true, localUploadEnabled: true };
    mockUpload.dropped = audio;
    decodeAudioFileToBuffer.mockResolvedValue({ duration: 5 });
    transcribeAudioBuffer.mockResolvedValue('Notes from the call');
    renderApp({ ...APP, transcription: { enabled: true, modelId: 'voxtral' } });
    await screen.findByTestId('start-form');
    fireEvent.click(screen.getByRole('button', { name: 'drop a file' }));

    await fillAndSend();
    // The transcript takes the audio's place in the form's message.
    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    const sent = requestMessages(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      role: 'user',
      content: 'Write to Ada about the Q3 report.\n\nTranscript of call.mp3:\nNotes from the call',
      promptTemplate: null,
      // Still the form's message, so it sets the chat's variables.
      variables: { recipient: 'Ada', subject: 'the Q3 report' },
      audioTranscript: true
    });
    expect(sent[0].audioData).toBeFalsy();
    expect(transcribeAudioBuffer).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('start-form')).toBeNull();
  });

  test('when transcription yields nothing, nothing is sent and the form comes back with the file', async () => {
    const audio = { type: 'audio', fileName: 'call.mp3', base64: 'data:audio/mpeg;base64,AA' };
    mockUpload.config = { enabled: true, localUploadEnabled: true };
    mockUpload.dropped = audio;
    decodeAudioFileToBuffer.mockResolvedValue({ duration: 5 });
    transcribeAudioBuffer.mockResolvedValue('');
    renderApp({ ...APP, transcription: { enabled: true, modelId: 'voxtral' } });
    await screen.findByTestId('start-form');
    fireEvent.click(screen.getByRole('button', { name: 'drop a file' }));
    fireEvent.change(screen.getByPlaceholderText('Who'), { target: { value: 'Ada' } });
    fireEvent.submit(screen.getByTestId('start-form'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'No speech was detected. Nothing was sent.'
      )
    );
    expect(screen.getByTestId('start-form')).toBeInTheDocument();
    expect(screen.getByTestId('attached')).toHaveTextContent('call.mp3');
    expect(screen.getByPlaceholderText('Who')).toHaveValue('Ada');
    expect(mockStream.opened).toBe(0);
  });

  test('text the chat was opened with is shown in the form and sent as {{content}}', async () => {
    renderApp(APP, '/apps/acme?prefill=Keep%20it%20brief&send=true');
    await screen.findByTestId('start-form');

    // Auto-send waits for the form instead of firing into a missing composer.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    expect(mockStream.opened).toBe(0);
    expect(screen.getByLabelText('Message')).toHaveValue('Keep it brief');

    await fillAndSend();
    await answerTurn('run-1');
    expect(requestMessages(0)[0].content).toBe(
      'Write to Ada about the Q3 report.\n\nKeep it brief'
    );
    // Consumed: the composer starts empty.
    expect(screen.getAllByTestId('composer-input')[0]).toHaveValue('');
  });

  test('text typed into the form is sent as {{content}}', async () => {
    renderApp();
    await screen.findByTestId('start-form');

    // The chat input's field, on the form, also when nothing was prefilled.
    expect(screen.getByLabelText('Message')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Mention the deadline' }
    });

    await fillAndSend();
    await answerTurn('run-1');
    expect(requestMessages(0)[0].content).toBe(
      'Write to Ada about the Q3 report.\n\nMention the deadline'
    );
    expect(screen.getAllByTestId('composer-input')[0]).toHaveValue('');
  });

  describe('model selection', () => {
    const TWO_MODELS = [
      { id: 'model-x', name: { en: 'Model X' }, contextWindow: 8192 },
      { id: 'model-y', name: { en: 'Model Y' }, contextWindow: 8192 }
    ];
    const original = { models: mockSettings.models, set: mockSettings.setSelectedModel };
    beforeEach(() => {
      mockSettings.models = TWO_MODELS;
      mockSettings.setSelectedModel = jest.fn();
    });
    afterEach(() => {
      mockSettings.models = original.models;
      mockSettings.setSelectedModel = original.set;
    });

    test('the form picks the model of its message, as the composer would', async () => {
      renderApp();
      await screen.findByTestId('start-form');

      fireEvent.click(screen.getByRole('button', { name: 'Model X' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Model Y' }));
      expect(mockSettings.setSelectedModel).toHaveBeenCalledWith('model-y');
      expect(screen.getByTestId('start-form')).toBeInTheDocument();
    });

    test('an app that fixes the model shows no selector on the form', async () => {
      renderApp({ ...APP, disallowModelSelection: true });
      await screen.findByTestId('start-form');

      expect(screen.queryByRole('button', { name: 'Model X' })).toBeNull();
    });

    test('in compare mode the panels pick the models, not the form', async () => {
      renderApp();
      await screen.findByTestId('start-form');

      act(() => mockHeader.props.onCompareModeChange(true));
      expect(screen.getByTestId('compare-view')).toContainElement(screen.getByTestId('start-form'));
      expect(screen.queryByRole('button', { name: 'Model X' })).toBeNull();
    });
  });

  test('in compare mode, one form is sent to every panel', async () => {
    renderApp();
    await screen.findByTestId('start-form');

    act(() => mockHeader.props.onCompareModeChange(true));
    // One form, inside the compare view; no composer and no variables panel.
    expect(screen.getByTestId('compare-view')).toContainElement(screen.getByTestId('start-form'));
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.queryByText('pages.appChat.inputParameters')).toBeNull();

    await fillAndSend();
    expect(mockCompare.sent).toHaveLength(1);
    expect(mockCompare.sent[0].apiMessage).toMatchObject({
      content: 'Write to Ada about the Q3 report.',
      promptTemplate: null,
      variables: { recipient: 'Ada', subject: 'the Q3 report' }
    });
    expect(screen.queryByTestId('start-form')).toBeNull();

    // A follow-up goes to the panels as typed, without the variables.
    fireEvent.change(screen.getAllByTestId('composer-input')[0], { target: { value: 'Shorter' } });
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    expect(mockCompare.sent[1].apiMessage).toMatchObject({
      content: 'Shorter',
      promptTemplate: null
    });
    expect(mockCompare.sent[1].apiMessage.variables).toBeUndefined();

    // The regular chat was never started: leaving compare mode shows its form.
    act(() => mockHeader.props.onCompareModeChange(false));
    expect(await screen.findByTestId('start-form')).toBeInTheDocument();
    expect(mockCompare.sent).toHaveLength(2);
  });

  test('shows a plain-text greeting above the form', async () => {
    renderApp({ ...APP, greeting: 'Tell me about the email' });
    await screen.findByTestId('start-form');

    expect(screen.getByText('Tell me about the email')).toBeInTheDocument();
  });

  test('auto-start waits for the form', async () => {
    jest.useFakeTimers();
    try {
      renderApp({ ...APP, autoStart: true });
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('start-form')).toBeInTheDocument();
      expect(mockStream.opened).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a stored chat, reopened', () => {
  const STORED = [
    { id: 'srv-1', role: 'user', content: 'Write to Grace about the budget.' },
    { id: 'srv-2', role: 'assistant', content: 'Dear Grace, …' }
  ];

  test('continues without the form and without resending the variables', async () => {
    mockPersistence.on = true;
    fetchChat.mockResolvedValue({
      chat: { id: 'chat-stored', variables: { recipient: 'Grace', subject: 'the budget' } },
      messages: STORED
    });
    renderApp(APP, '/apps/acme/c/chat-stored');
    await screen.findAllByTestId('composer');
    expect(screen.queryByTestId('start-form')).toBeNull();

    fireEvent.change(screen.getAllByTestId('composer-input')[0], { target: { value: 'Shorter' } });
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    await answerTurn('run-1');

    // A stored chat posts only the new message; the server has the variables.
    expect(requestMessages(0)).toEqual([
      expect.objectContaining({ content: 'Shorter', promptTemplate: null, variables: {} })
    ]);
  });

  test('puts the stored variables back in the panel of an app without a form', async () => {
    mockPersistence.on = true;
    fetchChat.mockResolvedValue({
      chat: { id: 'chat-stored', variables: { recipient: 'Grace' } },
      messages: STORED
    });
    renderApp({ ...APP, startForm: undefined }, '/apps/acme/c/chat-stored');

    expect(await screen.findByPlaceholderText('Who')).toHaveValue('Grace');
  });
});

describe('AppChat without a start form (unchanged)', () => {
  test('shows the composer and the variables panel, and sends the template', async () => {
    renderApp({ ...APP, startForm: undefined });
    await screen.findAllByTestId('composer');

    expect(screen.queryByTestId('start-form')).toBeNull();
    expect(screen.getByText('pages.appChat.inputParameters')).toBeInTheDocument();
    expect(mockHeader.props.hideParametersButton).toBe(false);

    fireEvent.change(screen.getByPlaceholderText('Who'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getAllByTestId('composer-input')[0], { target: { value: 'Hi' } });
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
    await answerTurn('run-1');

    expect(requestMessages(0)[0]).toMatchObject({
      content: 'Hi',
      promptTemplate: APP.prompt,
      variables: { recipient: 'Ada' }
    });
  });
});
