import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Start page → chat handoff in the Outlook task pane (issue #2368).
 *
 * The start page has no URL to carry a message, so it stashes the text, the
 * collected emails and the edited snapshot of the open email in the in-memory
 * handoff and opens the app. OfficeChatPanel must then send exactly that —
 * once its model list has settled — as if the user had typed and sent inside
 * the app; and it must NOT send when the prompt only prefills or when the app
 * still needs a required variable, leaving the text in the input instead.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));

// processDocumentFile pulls in pdfjs / mammoth / xlsx — irrelevant here.
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  processDocumentFile: jest.fn(),
  resizeImageCanvas: jest.fn()
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform
// cannot parse.
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
jest.mock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => ({
  __esModule: true,
  default: () => ({
    messages: [],
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

let mockModelsLoading = false;
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
    modelsLoading: mockModelsLoading
  })
}));

jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => ({
  __esModule: true,
  default: () => ({
    createUploadConfig: () => ({}),
    selectedFile: null,
    handleFileSelect: jest.fn(),
    showUploader: false,
    toggleUploader: jest.fn(),
    clearSelectedFile: jest.fn(),
    setSelectedFile: jest.fn()
  })
}));

// The panel's own snapshot is still loading when a handed-over message goes
// out — the handoff must not depend on it.
jest.mock('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot', () => ({
  __esModule: true,
  default: () => ({
    loading: true,
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
  default: () => null
}));

jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ value, onChange }) => (
    <textarea aria-label="message" value={value} onChange={e => onChange?.(e)} />
  )
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => null
}));

const {
  setPendingChatStart,
  consumePendingChatStart
} = require('../../../client/src/features/chat/startChatHandoff');
const OfficeChatPanel =
  require('../../../client/src/features/office/components/OfficeChatPanel').default;

const authData = { user: { name: 'Ada' } };
const app = {
  id: 'chat',
  name: { en: 'Chat' },
  system: { en: 'You are helpful.' },
  starterPrompts: []
};
const pinned = [{ itemId: 'ITEM-9', subject: 'Collected', bodyText: 'Hi', attachments: [] }];
const override = { available: true, itemId: 'ITEM-1', bodyText: 'Body', attachments: [] };

const renderPanel = (selectedApp = app) =>
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <OfficeChatPanel
        authData={authData}
        selectedApp={selectedApp}
        setSelectedApp={jest.fn()}
        onLogout={jest.fn()}
        homePath="/start"
      />
    </MemoryRouter>
  );

beforeEach(() => {
  mockSendMessage.mockReset();
  mockModelsLoading = false;
  // Never let a handoff leak from one spec into the next.
  consumePendingChatStart('chat');
});

test('a handed-over message is sent once, with the collected emails and the edited context', async () => {
  setPendingChatStart({
    appId: 'chat',
    text: 'Reply politely',
    autoSend: true,
    pinnedEmails: pinned,
    hostContextOverride: override
  });

  renderPanel();

  await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
  const call = mockSendMessage.mock.calls[0][0];
  expect(call.displayMessage).toEqual({ content: 'Reply politely' });
  expect(call.apiMessage.content).toBe('Reply politely');
  expect(call.params.pinnedEmails).toBe(pinned);
  expect(call.params.hostContextOverride).toBe(override);
  expect(call.params.modelId).toBe('gpt');
  // Consumed: a re-render or a second mount must not send it again.
  expect(consumePendingChatStart('chat')).toBeNull();
});

test('waits for the model list before sending', async () => {
  mockModelsLoading = true;
  setPendingChatStart({ appId: 'chat', text: 'Hello', autoSend: true, pinnedEmails: [] });

  const { rerender } = renderPanel();
  expect(mockSendMessage).not.toHaveBeenCalled();
  // Still pending — nothing consumed it while the models were loading.
  expect(consumePendingChatStart('chat')).not.toBeNull();

  setPendingChatStart({ appId: 'chat', text: 'Hello', autoSend: true, pinnedEmails: [] });
  mockModelsLoading = false;
  rerender(
    <MemoryRouter initialEntries={['/chat']}>
      <OfficeChatPanel
        authData={authData}
        selectedApp={app}
        setSelectedApp={jest.fn()}
        onLogout={jest.fn()}
        homePath="/start"
      />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
  expect(mockSendMessage.mock.calls[0][0].apiMessage.content).toBe('Hello');
});

test('a prompt that does not auto-send only prefills the input', async () => {
  setPendingChatStart({
    appId: 'chat',
    text: 'Draft an answer',
    autoSend: false,
    pinnedEmails: [],
    hostContextOverride: null,
    starterPrompt: { title: { en: 'Draft' }, message: { en: 'Draft an answer' } }
  });

  renderPanel();

  await waitFor(() => expect(screen.getByLabelText('message')).toHaveValue('Draft an answer'));
  expect(mockSendMessage).not.toHaveBeenCalled();
});

test('an app that still needs a required variable is not sent to blindly', async () => {
  setPendingChatStart({ appId: 'chat', text: 'Translate this', autoSend: true, pinnedEmails: [] });

  renderPanel({
    ...app,
    variables: [{ name: 'language', type: 'string', required: true, label: { en: 'Language' } }]
  });

  await waitFor(() => expect(screen.getByLabelText('message')).toHaveValue('Translate this'));
  expect(mockSendMessage).not.toHaveBeenCalled();
});

test('a handoff for another app is left alone', async () => {
  setPendingChatStart({ appId: 'other-app', text: 'Not for you', autoSend: true });

  renderPanel();

  await waitFor(() => expect(screen.getByLabelText('message')).toHaveValue(''));
  expect(mockSendMessage).not.toHaveBeenCalled();
  expect(consumePendingChatStart('other-app')).not.toBeNull();
});

test('a starter prompt keeps the note the user has already typed', async () => {
  renderPanel({
    ...app,
    starterPrompts: [
      {
        title: { en: 'Generate a reply' },
        message: { en: 'Generate a reply to this email.' },
        autoSend: true
      }
    ]
  });

  fireEvent.change(screen.getByLabelText('message'), {
    target: { value: 'Jörg soll das machen.' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Generate a reply' }));

  await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
  const call = mockSendMessage.mock.calls[0][0];
  // The prompt's message first, the note underneath — nothing is dropped, and
  // the chat shows exactly what went out.
  expect(call.apiMessage.content).toBe('Generate a reply to this email.\n\nJörg soll das machen.');
  expect(call.displayMessage).toEqual({
    content: 'Generate a reply to this email.\n\nJörg soll das machen.'
  });
});
