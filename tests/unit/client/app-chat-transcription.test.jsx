import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * `AppChat` sending audio to the selected model.
 *
 * A transcription model selected in the chat answers each uploaded audio file
 * (or the audio of a video, or a recording) with its transcript: the file's
 * name is the question, the transcript streams into the answer, and nothing
 * goes through the chat request — the audio travels over the realtime socket,
 * which names the chat so the server can store the turn. A chat model gets
 * audio only when it takes audio itself: uploaded or recorded, as `audioData`.
 *
 * The mock setup mirrors app-chat-start-form.test.jsx; `useAppChat` is real.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => `uuid-${(global.__uuidSeq = (global.__uuidSeq || 0) + 1)}`
}));

// Every hook stubbed below returns a *stable* identity: `AppChat` has effects
// keyed on these objects, and a fresh one per render turns them into loops.
const mockT = (key, def, opts) =>
  typeof def === 'string'
    ? def.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''))
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
// Reached through AppChat's citation document actions. Stubbed like the rest
// of the api layer: `api/client.js` reads `import.meta.env`, which the Jest
// transform cannot compile.
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

// A transcript that lives in this tab: every request posts the whole history,
// so a live bubble that leaked into it would show in the payload.
jest.mock('../../../client/src/shared/hooks/useChats', () => ({
  __esModule: true,
  invalidateChatsCache: jest.fn(),
  useChatPersistence: () => false,
  useChatPersistenceResolving: () => false
}));

const mockNoop = () => {};
const mockSettings = {
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
  ephemeral: false,
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
  setEphemeral: mockNoop,
  modelsLoading: false
};
jest.mock('../../../client/src/shared/hooks/useAppSettings', () => ({
  __esModule: true,
  default: () => mockSettings
}));

// Upload state held in real React state; `select` stands in for picking files.
const mockUpload = { select: null, selected: null };
jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: () => {
      const [selectedFile, setSelectedFile] = React.useState(null);
      mockUpload.select = setSelectedFile;
      mockUpload.selected = selectedFile;
      return React.useMemo(
        () => ({
          selectedFile,
          showUploader: false,
          handleFileSelect: setSelectedFile,
          createUploadConfig: () => ({}),
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
jest.mock('../../../client/src/features/voice/components/VoiceModeDock', () => ({
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
  decodeAudioFileToBuffer: jest.fn(),
  recordingToAudioAttachment: jest.fn()
}));
const mockRecorders = [];
jest.mock('../../../client/src/utils/audioRecorder', () => ({
  __esModule: true,
  AudioBufferRecorder: jest.fn().mockImplementation(() => {
    const recorder = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue({ audioBuffer: { duration: 4 }, durationSeconds: 4 }),
      cancel: jest.fn()
    };
    mockRecorders.push(recorder);
    return recorder;
  })
}));
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
jest.mock('../../../client/src/utils/liveTranscription', () => ({
  __esModule: true,
  startLiveTranscription: jest.fn()
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
// A real <form> bound to `formRef`: the transcribed message is sent by
// submitting it. The props carry the record button and the Stop handler.
const mockComposer = { props: null };
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: props => {
    mockComposer.props = props;
    return (
      <form ref={props.formRef} onSubmit={props.onSubmit} data-testid="composer">
        <input data-testid="composer-input" value={props.value} onChange={props.onChange} />
      </form>
    );
  }
}));

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;
const { sendAppChatMessage } = require('../../../client/src/api');
const {
  decodeAudioFileToBuffer
} = require('../../../client/src/features/upload/utils/fileProcessing');
const { transcribeAudioBuffer } = require('../../../client/src/utils/transcribeAudioBuffer');
const { startLiveTranscription } = require('../../../client/src/utils/liveTranscription');
const {
  recordingToAudioAttachment
} = require('../../../client/src/features/upload/utils/fileProcessing');

const TRANSCRIPTION_APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'microphone',
  variables: []
};

const CHAT_MODEL = { id: 'model-x', name: { en: 'Model X' }, contextWindow: 8192 };
const AUDIO_MODEL = { id: 'gemini-flash', name: { en: 'Gemini Flash' }, supportsAudio: true };
const LIVE_MODEL = {
  id: 'gemini-live',
  name: { en: 'Gemini Live' },
  modelType: 'transcription',
  transcriptionMode: 'stream'
};
const MODELS = [CHAT_MODEL, AUDIO_MODEL, LIVE_MODEL];

/** The model selected in the chat (the settings hook is stubbed). */
function selectModel(id) {
  mockSettings.selectedModel = id;
  mockSettings.models = MODELS;
}

const AUDIO = { type: 'audio', fileName: 'memo.mp3', base64: 'AAAA' };
const VIDEO_AUDIO = {
  type: 'audio',
  fileName: 'standup.wav',
  base64: 'BBBB',
  extractedFromVideo: true,
  originalVideoName: 'standup.mp4'
};
const DOC = { type: 'document', fileName: 'notes.txt', fileType: 'text/plain', content: 'agenda' };

function renderApp(app = TRANSCRIPTION_APP, path = '/apps/acme') {
  window.history.replaceState({}, '', path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/apps/:appId" element={<AppChat preloadedApp={app} />} />
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
// Without messages the list is not rendered at all; its last props are stale then.
const shownMessages = () =>
  screen.queryAllByTestId('transcript').length > 0 ? (mockMessageList.props?.messages ?? []) : [];
const shownTurns = () =>
  shownMessages()
    .filter(message => message.role !== 'system')
    .map(message => [message.role, message.content]);
const systemMessages = () => shownMessages().filter(message => message.role === 'system');
const composerValue = () => screen.getAllByTestId('composer-input')[0].value;

async function type(text) {
  await screen.findAllByTestId('composer');
  fireEvent.change(screen.getAllByTestId('composer-input')[0], { target: { value: text } });
}

async function attach(selection) {
  await screen.findAllByTestId('composer');
  act(() => mockUpload.select(selection));
}

async function send() {
  await act(async () => {
    fireEvent.submit(screen.getAllByTestId('composer')[0]);
  });
}

/** A transcription that streams `partial` and finishes when the test says so. */
function controlledTranscription() {
  const control = {};
  transcribeAudioBuffer.mockImplementation(
    (_buffer, { onDelta, signal }) =>
      new Promise((resolve, reject) => {
        control.delta = text => act(() => onDelta?.(text));
        control.finish = text => act(async () => resolve(text));
        control.fail = err => reject(err);
        // Like the real one: an already-cancelled run fails at once.
        const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'aborted' }));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort);
      })
  );
  return control;
}

/** A fake live session the test speaks into. */
function fakeLiveSessions() {
  const sessions = [];
  startLiveTranscription.mockImplementation(async opts => {
    let resolveStop;
    let rejectStop;
    const stopped = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    stopped.catch(() => {});
    let current = '';
    const session = {
      opts,
      stop: jest.fn(() => stopped),
      cancel: jest.fn(() =>
        rejectStop(Object.assign(new Error('cancelled'), { code: 'aborted', partialText: current }))
      ),
      text: () => current,
      speak: text =>
        act(() => {
          current = text;
          opts.onText?.(text);
        }),
      finish: text => act(async () => resolveStop(text)),
      failWhileSpeaking: err =>
        act(() => opts.onError(Object.assign(err, { partialText: current })))
    };
    sessions.push(session);
    return session;
  });
  return sessions;
}

async function clickRecord() {
  await act(async () => {
    await mockComposer.props.onRecordTranscription();
  });
}

beforeEach(() => {
  seq = 0;
  mockStream.onEvent = null;
  mockStream.opened = 0;
  mockHeader.props = null;
  mockMessageList.props = null;
  mockComposer.props = null;
  mockPlatform.config = null;
  jest.clearAllMocks();
  sessionStorage.clear();
  decodeAudioFileToBuffer.mockResolvedValue({ duration: 3 });
  mockRecorders.length = 0;
  selectModel('model-x');
});

describe('a transcription model selected in the chat', () => {
  beforeEach(() => selectModel('gemini-live'));

  test('an uploaded file is a turn: its name as the question, the transcript as the answer', async () => {
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    renderApp();
    await attach(AUDIO);
    await send();

    await waitFor(() =>
      expect(shownTurns()).toEqual([
        ['user', 'memo.mp3'],
        ['assistant', 'We ship on Friday.']
      ])
    );
    const [, options] = transcribeAudioBuffer.mock.calls[0];
    expect(options.modelId).toBe('gemini-live');
    // The socket names the chat, so a stored chat gets the same turn.
    expect(options.chat).toMatchObject({
      chatId: mockHeader.props.chatId,
      appId: 'acme',
      attachment: { name: 'memo.mp3' }
    });
    // No chat request: the transcription model answered.
    expect(sendAppChatMessage).not.toHaveBeenCalled();
    expect(mockStream.opened).toBe(0);
  });

  test('both halves of the turn are marked, under the exchange id the server stores', async () => {
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));

    const [question, answer] = shownMessages().filter(m => m.role !== 'system');
    const { chat } = transcribeAudioBuffer.mock.calls[0][1];
    // Deleting the turn forks the stored history by this id.
    expect(question.clientMessageId).toBe(chat.clientMessageId);
    expect(answer.id).toBe(chat.clientMessageId);
    // The audio is not kept: no edit or resend of the question.
    expect(question.transcription).toBe(true);
    expect(answer.transcription).toBe(true);
  });

  test('a resend of a transcription turn is refused, and the transcript stays', async () => {
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));
    const question = shownMessages().find(m => m.role === 'user');
    await act(async () => {
      mockMessageList.props.onResend(question.id);
    });
    expect(shownTurns()).toEqual([
      ['user', 'memo.mp3'],
      ['assistant', 'We ship on Friday.']
    ]);
    expect(sendAppChatMessage).not.toHaveBeenCalled();
  });

  test('typed text is never sent to a transcription model', async () => {
    renderApp();
    await type('Hello?');
    await send();
    expect(sendAppChatMessage).not.toHaveBeenCalled();
    expect(mockStream.opened).toBe(0);
    expect(transcribeAudioBuffer).not.toHaveBeenCalled();
  });

  test('other attachments stay attached for the model selected next', async () => {
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    renderApp();
    await attach([AUDIO, DOC]);
    await send();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));
    expect(mockUpload.selected).toEqual(DOC);
  });

  test('the transcript streams into the answer', async () => {
    const transcription = controlledTranscription();
    renderApp();
    await attach(AUDIO);
    await send();

    await waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalled());
    await transcription.delta('We ship');
    const answer = () => shownMessages().find(m => m.role === 'assistant');
    expect(answer()).toMatchObject({ content: 'We ship', loading: true });
    await transcription.finish('We ship on Friday.');
    await waitFor(() => expect(answer()).toMatchObject({ content: 'We ship on Friday.' }));
    expect(answer().loading).toBe(false);
  });

  test('the audio of a video is named by the video, each file gets a turn', async () => {
    transcribeAudioBuffer.mockResolvedValueOnce('Standup.').mockResolvedValueOnce('');
    renderApp();
    await attach([VIDEO_AUDIO, AUDIO]);
    await send();

    await waitFor(() =>
      expect(shownTurns()).toEqual([
        ['user', 'standup.mp4'],
        ['assistant', 'Standup.'],
        ['user', 'memo.mp3'],
        ['assistant', '(no speech detected)']
      ])
    );
  });

  test("a video's audio is decoded from its WAV Blob", async () => {
    transcribeAudioBuffer.mockResolvedValue('Hello.');
    const blob = new Blob(['RIFF'], { type: 'audio/wav' });
    const withBlob = { ...VIDEO_AUDIO };
    Object.defineProperty(withBlob, 'blob', { value: blob, enumerable: false });
    renderApp();
    await attach(withBlob);
    await send();
    await waitFor(() => expect(decodeAudioFileToBuffer).toHaveBeenCalledWith(blob));
  });

  test('a failure keeps the transcript so far and says why', async () => {
    const transcription = controlledTranscription();
    renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalled());
    await transcription.delta('We ship');
    await act(async () => {
      transcription.fail(Object.assign(new Error('closed'), { code: 'interrupted' }));
    });

    await waitFor(() => expect(systemMessages()).toHaveLength(1));
    expect(shownTurns()).toEqual([
      ['user', 'memo.mp3'],
      ['assistant', 'We ship']
    ]);
  });

  test('Stop cancels without an error', async () => {
    controlledTranscription();
    renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(mockComposer.props.isProcessing).toBe(true));
    await act(async () => {
      mockComposer.props.onCancel();
    });
    await waitFor(() => expect(mockComposer.props.isProcessing).toBe(false));
    expect(systemMessages()).toHaveLength(0);
  });

  test('audio over the length limit is refused before transcribing', async () => {
    decodeAudioFileToBuffer.mockResolvedValue({ duration: 4000 });
    renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(systemMessages()).toHaveLength(1));
    expect(transcribeAudioBuffer).not.toHaveBeenCalled();
  });

  test('the composer takes audio only: no dictation, record goes to the model', async () => {
    renderApp();
    await screen.findAllByTestId('composer');
    expect(mockComposer.props.audioOnly).toBe(true);
    expect(mockComposer.props.onVoiceInput).toBeUndefined();
    expect(mockComposer.props.transcriptionRecordEnabled).toBe(true);
  });

  test('a recording streams its transcript into the answer and ends on stop', async () => {
    const sessions = fakeLiveSessions();
    renderApp();
    await screen.findAllByTestId('composer');
    await clickRecord();

    expect(startLiveTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-live',
        chat: expect.objectContaining({
          appId: 'acme',
          attachment: { name: 'Recording', type: 'audio/wav' }
        })
      })
    );
    await sessions[0].speak('Hello every');
    expect(shownTurns()).toEqual([
      ['user', 'Recording'],
      ['assistant', 'Hello every']
    ]);

    await clickRecord(); // stop
    await sessions[0].finish('Hello everyone.');
    await waitFor(() =>
      expect(shownTurns()).toEqual([
        ['user', 'Recording'],
        ['assistant', 'Hello everyone.']
      ])
    );
    expect(sendAppChatMessage).not.toHaveBeenCalled();
  });

  test('the transcript is history for the chat model selected next', async () => {
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    const view = renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));

    selectModel('model-x');
    view.rerender(
      <MemoryRouter initialEntries={['/apps/acme']}>
        <Routes>
          <Route path="/apps/:appId" element={<AppChat preloadedApp={TRANSCRIPTION_APP} />} />
        </Routes>
      </MemoryRouter>
    );
    await type('Summarize it');
    await send();
    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');

    expect(requestMessages(0).map(m => [m.role, m.content])).toEqual([
      ['user', 'memo.mp3'],
      ['assistant', 'We ship on Friday.'],
      ['user', 'Summarize it']
    ]);
  });
});

describe('a transcription turn in a project chat (#1036)', () => {
  test('keeps the project, so the chat model selected next still gets it', async () => {
    selectModel('gemini-live');
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    const view = renderApp(TRANSCRIPTION_APP, '/apps/acme?project=prj_case');
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));
    const chatId = mockHeader.props.chatId;
    // Kept beside the transcript this tab holds for the chat.
    expect(sessionStorage.getItem(`ai_hub_chat_project_${chatId}`)).toBe('prj_case');

    // The app opened again without `?project=`: same chat, still in the project.
    view.unmount();
    selectModel('model-x');
    renderApp();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));
    expect(mockHeader.props.chatId).toBe(chatId);
    await type('Summarize it');
    await send();
    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    expect(sendAppChatMessage.mock.calls[0][3]).toEqual(
      expect.objectContaining({ projectId: 'prj_case' })
    );
  });

  test('a new chat leaves the project behind', async () => {
    selectModel('gemini-live');
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    renderApp(TRANSCRIPTION_APP, '/apps/acme?project=prj_case');
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(shownTurns()).toHaveLength(2));
    const chatId = mockHeader.props.chatId;

    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      act(() => mockHeader.props.onClearChat());
    } finally {
      confirm.mockRestore();
    }
    await waitFor(() => expect(mockHeader.props.chatId).not.toBe(chatId));
    expect(sessionStorage.getItem(`ai_hub_chat_project_${chatId}`)).toBeNull();

    // The next turn of the new chat goes out without the project.
    selectModel('model-x');
    await type('Hello');
    await send();
    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    expect(sendAppChatMessage.mock.calls[0][3]).not.toHaveProperty('projectId');
  });

  test('an incognito chat keeps nothing', async () => {
    selectModel('gemini-live');
    mockSettings.ephemeral = true;
    try {
      transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
      renderApp(TRANSCRIPTION_APP, '/apps/acme?project=prj_case');
      await attach(AUDIO);
      await send();
      await waitFor(() => expect(shownTurns()).toHaveLength(2));
      expect(
        Object.keys(sessionStorage).filter(key => key.startsWith('ai_hub_chat_project_'))
      ).toEqual([]);
    } finally {
      mockSettings.ephemeral = false;
    }
  });
});

describe('a chat model', () => {
  test('audio for a model that cannot take it is refused with a hint', async () => {
    renderApp();
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(systemMessages()).toHaveLength(1));
    expect(sendAppChatMessage).not.toHaveBeenCalled();
    expect(transcribeAudioBuffer).not.toHaveBeenCalled();
  });

  test('record is offered only for a model that takes audio', async () => {
    renderApp();
    await screen.findAllByTestId('composer');
    expect(mockComposer.props.transcriptionRecordEnabled).toBe(false);
    expect(mockComposer.props.audioOnly).toBe(false);
  });

  test('a model that takes audio gets the upload as audioData', async () => {
    selectModel('gemini-flash');
    renderApp();
    await type('What is said?');
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    const [message] = requestMessages(0);
    expect(message.content).toBe('What is said?');
    expect(message.audioData).toBeTruthy();
    expect(transcribeAudioBuffer).not.toHaveBeenCalled();
  });

  test('a recording is attached and sent with what is typed', async () => {
    selectModel('gemini-flash');
    recordingToAudioAttachment.mockResolvedValue({
      type: 'audio',
      fileName: 'Recording.wav',
      fileType: 'audio/wav',
      base64: 'data:audio/wav;base64,CCCC'
    });
    renderApp();
    await type('What is said?');
    await clickRecord();
    expect(mockRecorders).toHaveLength(1);
    expect(startLiveTranscription).not.toHaveBeenCalled();
    await clickRecord(); // stop

    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    const [message] = requestMessages(0);
    expect(message.content).toBe('What is said?');
    expect(message.audioData).toBeTruthy();
  });
});
