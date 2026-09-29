import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Form-based start in the Outlook task pane and the browser extension's side
 * panel, which share OfficeChatPanel (issue #2581).
 *
 * An app with `startForm.enabled` opens a chat with its variables as a form in
 * place of the starters, the transcript and the composer. Sending it posts the
 * app's prompt rendered with the answers, once, together with the variables;
 * the chat then goes on in the composer, without the template and without the
 * variables — the form's message keeps them in the transcript.
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

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

jest.mock('../../../client/src/api', () => ({
  fetchApps: jest.fn(() => Promise.resolve([]))
}));

jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => ({ starterPrompts: [], calendarStarterPrompts: [] })
}));

const mockSendMessage = jest.fn();
const mockAdapter = { messages: [] };
jest.mock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => ({
  __esModule: true,
  default: () => ({
    messages: mockAdapter.messages,
    processing: false,
    clarificationPending: false,
    sendMessage: mockSendMessage,
    clearMessages: jest.fn(),
    deleteMessage: jest.fn(),
    editMessage: jest.fn(),
    resendMessage: jest.fn(),
    cancelGeneration: jest.fn()
  })
}));

jest.mock('../../../client/src/shared/hooks/useAppSettings', () => ({
  __esModule: true,
  default: () => ({
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
  })
}));

const mockUpload = { selectedFile: null };
jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => ({
  __esModule: true,
  default: () => ({
    createUploadConfig: () => ({}),
    selectedFile: mockUpload.selectedFile,
    handleFileSelect: jest.fn(),
    showUploader: false,
    toggleUploader: jest.fn(),
    clearSelectedFile: jest.fn(),
    setSelectedFile: jest.fn()
  })
}));

jest.mock('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot', () => ({
  __esModule: true,
  default: () => ({
    loading: false,
    ctx: null,
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

jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: () => <div data-testid="transcript" />
}));

jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ value, onChange, onSubmit }) => (
    <form data-testid="composer" onSubmit={onSubmit}>
      <textarea aria-label="composer" value={value} onChange={e => onChange?.(e)} />
    </form>
  )
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => <div data-testid="context-strip" />
}));

const {
  setPendingChatStart,
  consumePendingChatStart
} = require('../../../client/src/features/chat/startChatHandoff');
const OfficeChatPanel =
  require('../../../client/src/features/office/components/OfficeChatPanel').default;

const APP = {
  id: 'reply',
  name: { en: 'Reply' },
  system: { en: 'You reply for {{sender}}.' },
  prompt: { en: 'Reply in a {{tone}} tone.\n\n{{content}}' },
  variables: [
    { name: 'tone', label: { en: 'Tone' }, placeholder: { en: 'Which tone' }, type: 'string' },
    {
      name: 'sender',
      label: { en: 'Sender' },
      placeholder: { en: 'Who signs' },
      type: 'string',
      required: true
    }
  ],
  startForm: { enabled: true, submitLabel: { en: 'Draft reply' } }
};

const renderPanel = (selectedApp = APP) =>
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <OfficeChatPanel
        authData={{ user: { name: 'Ada' } }}
        selectedApp={selectedApp}
        setSelectedApp={jest.fn()}
        onLogout={jest.fn()}
        homePath="/start"
      />
    </MemoryRouter>
  );

beforeEach(() => {
  mockSendMessage.mockReset();
  mockAdapter.messages = [];
  mockUpload.selectedFile = null;
  consumePendingChatStart('reply');
});

test('a new chat opens with the form, the email context still in view', () => {
  renderPanel();

  expect(screen.getByTestId('start-form')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Draft reply' })).toBeInTheDocument();
  expect(screen.queryByTestId('composer')).toBeNull();
  expect(screen.queryByTestId('transcript')).toBeNull();
  expect(screen.getByTestId('context-strip')).toBeInTheDocument();
  // The form asks for the required variable; no dialog does.
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('sending the form posts the rendered prompt once, with the variables', () => {
  renderPanel();
  fireEvent.change(screen.getByPlaceholderText('Which tone'), { target: { value: 'warm' } });
  fireEvent.change(screen.getByPlaceholderText('Who signs'), { target: { value: 'Ada' } });
  fireEvent.submit(screen.getByTestId('start-form'));

  expect(mockSendMessage).toHaveBeenCalledTimes(1);
  const call = mockSendMessage.mock.calls[0][0];
  expect(call.apiMessage).toMatchObject({
    content: 'Reply in a warm tone.',
    promptTemplate: null,
    variables: { tone: 'warm', sender: 'Ada' }
  });
  // Kept on the message, so the history carries them to later turns.
  expect(call.displayMessage).toEqual({
    content: 'Reply in a warm tone.',
    meta: { variables: { tone: 'warm', sender: 'Ada' } }
  });
});

test('a missing required answer keeps the form and sends nothing', () => {
  renderPanel();
  fireEvent.submit(screen.getByTestId('start-form'));

  expect(screen.getByRole('alert')).toHaveTextContent('Sender');
  expect(mockSendMessage).not.toHaveBeenCalled();
});

test('after the form, the composer sends as typed, without template or variables', () => {
  mockAdapter.messages = [
    { id: 'u1', role: 'user', content: 'Reply in a warm tone.', variables: { tone: 'warm' } },
    { id: 'a1', role: 'assistant', content: 'Dear …' }
  ];
  renderPanel();
  expect(screen.queryByTestId('start-form')).toBeNull();

  fireEvent.change(screen.getByLabelText('composer'), { target: { value: 'Shorter' } });
  fireEvent.submit(screen.getByTestId('composer'));

  const call = mockSendMessage.mock.calls[0][0];
  expect(call.apiMessage).toMatchObject({ content: 'Shorter', promptTemplate: null });
  expect(call.apiMessage.variables).toBeUndefined();
  expect(call.displayMessage).toEqual({ content: 'Shorter' });
});

test('text handed over from the start page waits in the form as its message', async () => {
  setPendingChatStart({ appId: 'reply', text: 'Mention the deadline', autoSend: true });
  renderPanel();

  await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('Mention the deadline'));
  expect(mockSendMessage).not.toHaveBeenCalled();

  fireEvent.change(screen.getByPlaceholderText('Which tone'), { target: { value: 'firm' } });
  fireEvent.change(screen.getByPlaceholderText('Who signs'), { target: { value: 'Ada' } });
  fireEvent.submit(screen.getByTestId('start-form'));
  expect(mockSendMessage.mock.calls[0][0].apiMessage.content).toBe(
    'Reply in a firm tone.\n\nMention the deadline'
  );
});

test('a document dropped on the form goes along, also as the only content', () => {
  const doc = { type: 'document', fileName: 'brief.pdf', content: 'Brief' };
  mockUpload.selectedFile = doc;
  // No template and nothing entered: the document is all there is to send.
  const { prompt: _prompt, ...app } = APP;
  renderPanel({ ...app, variables: [] });

  const send = screen.getByRole('button', { name: 'Draft reply' });
  expect(send).toBeEnabled();
  fireEvent.click(send);

  expect(mockSendMessage).toHaveBeenCalledTimes(1);
  expect(mockSendMessage.mock.calls[0][0].apiMessage).toMatchObject({
    content: '',
    fileData: doc,
    imageData: null
  });
});

test('the email snapshot handed over from the start page is the one the form sends', async () => {
  const override = { available: true, itemId: 'ITEM-1', bodyText: 'Edited', attachments: [] };
  setPendingChatStart({
    appId: 'reply',
    text: 'Mention the deadline',
    autoSend: true,
    hostContextOverride: override
  });
  renderPanel();
  await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('Mention the deadline'));

  fireEvent.change(screen.getByPlaceholderText('Who signs'), { target: { value: 'Ada' } });
  fireEvent.submit(screen.getByTestId('start-form'));
  expect(mockSendMessage.mock.calls[0][0].params.hostContextOverride).toBe(override);
});

test('an app without a start form is unchanged', () => {
  const { startForm: _startForm, ...app } = APP;
  renderPanel({ ...app, variables: [] });

  expect(screen.queryByTestId('start-form')).toBeNull();
  fireEvent.change(screen.getByLabelText('composer'), { target: { value: 'Hi' } });
  fireEvent.submit(screen.getByTestId('composer'));

  const call = mockSendMessage.mock.calls[0][0];
  expect(call.apiMessage.promptTemplate).toEqual({ en: APP.prompt.en, de: '' });
  expect(call.displayMessage).toEqual({ content: 'Hi' });
});
