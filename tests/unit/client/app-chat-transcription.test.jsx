import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * `AppChat` turning audio into the user's message with the app's
 * transcription model.
 *
 * Uploaded audio (or audio extracted from a video) is transcribed on send: the
 * transcript streams into a user bubble after the typed text and then goes to
 * the chat model as the message, in place of the audio. A recording streams
 * live: the user bubble grows while the user speaks and is sent on stop. The
 * bubble is local (`isLiveTranscript`); what the server sees is the one message
 * it turns into.
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
      cleanupEventSource: () => {}
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

const TRANSCRIPTION_APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'microphone',
  variables: [],
  transcription: { enabled: true, modelId: 'voxtral', streaming: true }
};

const AUDIO = { type: 'audio', fileName: 'memo.mp3', base64: 'AAAA' };
const VIDEO_AUDIO = {
  type: 'audio',
  fileName: 'standup.wav',
  base64: 'BBBB',
  extractedFromVideo: true,
  originalVideoName: 'standup.mp4'
};
const DOC = { type: 'document', fileName: 'notes.txt', fileType: 'text/plain', content: 'agenda' };

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
const liveBubble = () => shownMessages().find(message => message.isLiveTranscript);
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
});

describe('uploaded audio becomes the user message', () => {
  test('the transcript follows the typed text and the chat model answers it', async () => {
    transcribeAudioBuffer.mockResolvedValue('We ship on Friday.');
    renderApp();
    await type('Summarize the call');
    await attach(AUDIO);
    await send();

    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    const [message] = requestMessages(0);
    expect(message).toMatchObject({
      role: 'user',
      content: 'Summarize the call\n\nTranscript of memo.mp3:\nWe ship on Friday.',
      // Labels the answer "Based on audio recording" on the server.
      audioTranscript: true
    });
    expect(message.audioData).toBeFalsy();
    expect(requestMessages(0)).toHaveLength(1);
    // One user message on screen, the answer below it — no transcript turn.
    expect(shownMessages().map(m => m.role)).toEqual(['user', 'assistant']);
    expect(liveBubble()).toBeUndefined();
    expect(composerValue()).toBe('');
  });

  test('the transcript grows in the user bubble before anything is sent', async () => {
    const transcription = controlledTranscription();
    renderApp();
    await type('Summarize the call');
    await attach(AUDIO);
    await send();

    await waitFor(() => expect(liveBubble()).toBeDefined());
    expect(liveBubble()).toMatchObject({ role: 'user', loading: true });
    // The composer's content is the message being built.
    expect(composerValue()).toBe('');

    await transcription.delta('We ship');
    expect(liveBubble().content).toBe('Summarize the call\n\nTranscript of memo.mp3:\nWe ship');
    expect(mockStream.opened).toBe(0);
    // Stop cancels the transcription while it runs.
    expect(mockComposer.props.isProcessing).toBe(true);

    await transcription.finish('We ship on Friday.');
    await waitFor(() => expect(mockStream.opened).toBe(1));
    expect(liveBubble()).toBeUndefined();
  });

  test('a video is named by the video, and other attachments go along', async () => {
    transcribeAudioBuffer.mockResolvedValue('Standup notes.');
    renderApp();
    await attach([VIDEO_AUDIO, DOC]);
    await send();

    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    const [message] = requestMessages(0);
    expect(message.content).toBe('Transcript of standup.mp4:\nStandup notes.');
    expect(message.fileData).toEqual(DOC);
    expect(message.audioData).toBeFalsy();
  });

  test('several files each get a section; one without speech says so', async () => {
    transcribeAudioBuffer.mockResolvedValueOnce('First part.').mockResolvedValueOnce('');
    renderApp();
    await attach([AUDIO, { ...AUDIO, fileName: 'silence.mp3' }]);
    await send();

    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    expect(requestMessages(0)[0].content).toBe(
      'Transcript of memo.mp3:\nFirst part.\n\nTranscript of silence.mp3:\n(no speech detected)'
    );
  });

  test('a failed transcription sends nothing and gives the composer back', async () => {
    transcribeAudioBuffer.mockRejectedValue(Object.assign(new Error('down'), { code: 'connect' }));
    renderApp();
    await type('Summarize the call');
    await attach(AUDIO);
    await send();

    await waitFor(() => expect(systemMessages()).toHaveLength(1));
    expect(systemMessages()[0].error).toBe(true);
    expect(mockStream.opened).toBe(0);
    expect(liveBubble()).toBeUndefined();
    expect(composerValue()).toBe('Summarize the call');
    expect(mockUpload.selected).toEqual(AUDIO);
  });

  test('audio without any speech sends nothing', async () => {
    transcribeAudioBuffer.mockResolvedValue('');
    renderApp();
    await type('Summarize the call');
    await attach(AUDIO);
    await send();

    await waitFor(() =>
      expect(systemMessages()[0]?.content).toBe('No speech was detected. Nothing was sent.')
    );
    expect(mockStream.opened).toBe(0);
    expect(composerValue()).toBe('Summarize the call');
    expect(mockUpload.selected).toEqual(AUDIO);
  });

  test('Stop cancels: nothing is sent, the composer is restored, no error', async () => {
    controlledTranscription();
    renderApp();
    await type('Summarize the call');
    await attach(AUDIO);
    await send();
    await waitFor(() => expect(liveBubble()).toBeDefined());

    await act(async () => {
      mockComposer.props.onCancel();
    });

    await waitFor(() => expect(liveBubble()).toBeUndefined());
    expect(systemMessages()).toHaveLength(0);
    expect(mockStream.opened).toBe(0);
    expect(composerValue()).toBe('Summarize the call');
    expect(mockUpload.selected).toEqual(AUDIO);
  });

  test('audio over the length limit is refused before transcribing', async () => {
    decodeAudioFileToBuffer.mockResolvedValue({ duration: 1200 });
    renderApp();
    await attach(AUDIO);
    await send();

    await waitFor(() =>
      expect(systemMessages()[0]?.content).toBe(
        'This audio is 1200s long, which exceeds the 900s limit for transcription.'
      )
    );
    expect(transcribeAudioBuffer).not.toHaveBeenCalled();
    expect(mockStream.opened).toBe(0);
  });
});

describe('a recording becomes the user message', () => {
  test('the message grows while speaking and is sent on stop', async () => {
    const sessions = fakeLiveSessions();
    renderApp();
    await screen.findAllByTestId('composer');
    expect(mockComposer.props.transcriptionRecordEnabled).toBe(true);

    await clickRecord();
    expect(startLiveTranscription.mock.calls[0][0].modelId).toBe('voxtral');
    expect(mockComposer.props.isRecordingTranscription).toBe(true);
    expect(liveBubble()).toMatchObject({ role: 'user', content: 'Listening…', loading: true });

    const [session] = sessions;
    await session.speak('Hello there');
    expect(liveBubble().content).toBe('Hello there');
    await session.speak('Hello there, what is new?');
    expect(liveBubble().content).toBe('Hello there, what is new?');
    expect(mockStream.opened).toBe(0);

    await clickRecord();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(mockComposer.props.isRecordingTranscription).toBe(false);
    await session.finish('Hello there, what is new?');

    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    // Exactly one user message: the bubble never reaches the history.
    expect(requestMessages(0)).toEqual([
      expect.objectContaining({ role: 'user', content: 'Hello there, what is new?' })
    ]);
    // Spoken words are the user's own message, not audio material.
    expect(requestMessages(0)[0].audioTranscript).toBeUndefined();
    expect(shownMessages().map(m => m.role)).toEqual(['user', 'assistant']);
    expect(liveBubble()).toBeUndefined();
  });

  test('what is typed leads the spoken message', async () => {
    const sessions = fakeLiveSessions();
    renderApp();
    await type('Translate to German:');
    await clickRecord();
    await clickRecord();
    await sessions[0].finish('Good morning');

    await waitFor(() => expect(mockStream.opened).toBe(1));
    await answerTurn('run-1');
    expect(requestMessages(0)[0].content).toBe('Translate to German:\n\nGood morning');
  });

  test('sending while recording stops the recording and sends it', async () => {
    const sessions = fakeLiveSessions();
    renderApp();
    await screen.findAllByTestId('composer');
    expect(mockComposer.props.allowEmptySubmit).toBe(false);
    await clickRecord();
    // Send is enabled with nothing typed: it stops and sends the recording.
    expect(mockComposer.props.allowEmptySubmit).toBe(true);
    await send();
    expect(sessions[0].stop).toHaveBeenCalledTimes(1);
    await sessions[0].finish('Spoken');

    await waitFor(() => expect(mockStream.opened).toBe(1));
  });

  test('a recording without speech sends nothing', async () => {
    const sessions = fakeLiveSessions();
    renderApp();
    await clickRecord();
    await clickRecord();
    await sessions[0].finish('');

    await waitFor(() =>
      expect(systemMessages()[0]?.content).toBe('No speech was detected. Nothing was sent.')
    );
    expect(liveBubble()).toBeUndefined();
    expect(mockStream.opened).toBe(0);
  });

  test('a session that fails while speaking leaves the text so far in the composer', async () => {
    const sessions = fakeLiveSessions();
    renderApp();
    await clickRecord();
    await sessions[0].speak('Half a sentence');
    await sessions[0].failWhileSpeaking(new Error('closed'));

    expect(liveBubble()).toBeUndefined();
    expect(mockComposer.props.isRecordingTranscription).toBe(false);
    expect(composerValue()).toBe('Half a sentence');
    expect(systemMessages()[0].error).toBe(true);
    expect(systemMessages()[0].content).toContain(
      'What was transcribed so far is in the input field.'
    );
    expect(mockStream.opened).toBe(0);
  });

  test('a microphone that cannot be opened shows an error and no bubble', async () => {
    startLiveTranscription.mockRejectedValue(Object.assign(new Error('denied'), { code: 'mic' }));
    renderApp();
    await clickRecord();

    expect(systemMessages()[0].content).toBe(
      'Could not access the microphone. Please grant permission and try again.'
    );
    expect(liveBubble()).toBeUndefined();
    expect(mockComposer.props.isRecordingTranscription).toBe(false);
  });
});

describe('which transcription model is used', () => {
  const PLATFORM_DEFAULT = { speech: { transcription: { defaultModelId: 'platform-voxtral' } } };

  test('an app without a model of its own uses the platform default', async () => {
    mockPlatform.config = PLATFORM_DEFAULT;
    transcribeAudioBuffer.mockResolvedValue('hello');
    renderApp({ ...TRANSCRIPTION_APP, transcription: { enabled: true, streaming: true } });
    await attach(AUDIO);
    await send();

    await waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalled());
    expect(transcribeAudioBuffer.mock.calls[0][1].modelId).toBe('platform-voxtral');
  });

  test("the app's own model wins over the platform default", async () => {
    mockPlatform.config = PLATFORM_DEFAULT;
    fakeLiveSessions();
    transcribeAudioBuffer.mockResolvedValue('hello');
    renderApp();
    await attach(AUDIO);
    await send();

    await waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalled());
    expect(transcribeAudioBuffer.mock.calls[0][1].modelId).toBe('voxtral');
  });
});
