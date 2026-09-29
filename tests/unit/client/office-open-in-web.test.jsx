import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * "Open in web" in the task pane (issue #2591): the pane's conversation lives
 * only in the pane, so continuing it in the browser means storing a copy as a
 * durable chat and opening that chat's URL. These tests drive the real panel,
 * header menu and hook; only the network, the host and the chat engine are
 * doubles.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      typeof defaultValue === 'string'
        ? defaultValue.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '')
        : key,
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

const mockFetchPlatformConfig = jest.fn();
const mockImportChat = jest.fn();
const mockFetchChat = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchApps: jest.fn(() => Promise.resolve([])),
  fetchPlatformConfig: (...args) => mockFetchPlatformConfig(...args),
  importChat: (...args) => mockImportChat(...args),
  fetchChat: (...args) => mockFetchChat(...args)
}));

const mockOpenExternalUrl = jest.fn();
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  openExternalUrl: (...args) => mockOpenExternalUrl(...args)
}));

jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => ({
    baseUrl: 'https://ihub.example.com/ihub',
    starterPrompts: [],
    calendarStarterPrompts: []
  })
}));

let mockMessages = [];
let mockProcessing = false;
jest.mock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => ({
  __esModule: true,
  default: () => ({
    messages: mockMessages,
    processing: mockProcessing,
    clarificationPending: false,
    sendMessage: jest.fn(),
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

jest.mock('../../../client/src/features/office/hooks/useOutlookMailActions', () => ({
  __esModule: true,
  default: () => ({
    actions: [],
    defaultActionId: null,
    runAction: jest.fn(),
    notice: null,
    dismissNotice: jest.fn()
  })
}));

jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: () => <textarea aria-label="message" />
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => null
}));

const OfficeChatPanel =
  require('../../../client/src/features/office/components/OfficeChatPanel').default;

const app = { id: 'chat', name: { en: 'Chat' }, system: { en: 'Helpful.' }, starterPrompts: [] };

const conversation = () => [
  { id: 'g', role: 'assistant', content: 'Hello!', isGreeting: true },
  { id: 'u1', role: 'user', content: 'Reply that we accept.' },
  { id: 'a1', role: 'assistant', content: 'Dear Mara, we accept.' }
];

// A fresh element every time so a re-render reaches the panel.
const panel = () => (
  <MemoryRouter initialEntries={['/chat']}>
    <OfficeChatPanel
      authData={{ user: { name: 'Ada' } }}
      selectedApp={app}
      setSelectedApp={jest.fn()}
      onLogout={jest.fn()}
      homePath="/start"
    />
  </MemoryRouter>
);

/**
 * What `importChat` rejects with. `handleApiResponse` does not rethrow the axios
 * error: it throws a fresh one with `status`, and the axios error — the one
 * that has the server's response — as `originalError`.
 */
const apiError = (status, code) =>
  Object.assign(new Error('Request failed'), {
    status,
    originalError: { response: { status, data: { details: { code } } } }
  });

/** Render, let the "does the server store chats?" answer land, open the ☰ menu. */
async function renderWithMenuOpen() {
  const view = render(panel());
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  return view;
}

const openInWebButton = () => screen.queryByRole('button', { name: 'Open in web' });
const clickOpenInWeb = () => act(async () => fireEvent.click(openInWebButton()));

beforeEach(() => {
  mockMessages = conversation();
  mockProcessing = false;
  mockFetchPlatformConfig.mockReset().mockResolvedValue({ chats: { persistence: true } });
  mockImportChat.mockReset().mockResolvedValue({ chat: { id: 'chat-web-1' } });
  mockFetchChat.mockReset().mockResolvedValue({ chat: { id: 'chat-web-1' }, messages: [] });
  mockOpenExternalUrl.mockReset().mockReturnValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

test('stores the conversation and opens the chat in the browser', async () => {
  await renderWithMenuOpen();

  await clickOpenInWeb();

  expect(mockImportChat).toHaveBeenCalledTimes(1);
  expect(mockImportChat).toHaveBeenCalledWith({
    appId: 'chat',
    modelId: 'gpt',
    // The greeting is not something anyone said.
    messages: [
      { role: 'user', content: 'Reply that we accept.' },
      { role: 'assistant', content: 'Dear Mara, we accept.' }
    ]
  });
  // Through the host-aware opener — window.open is a silent no-op in Outlook —
  // at the route the web app's own history uses, under the deployment base path.
  expect(mockOpenExternalUrl).toHaveBeenCalledWith(
    'https://ihub.example.com/ihub/apps/chat/c/chat-web-1'
  );
});

test('is not offered when the installation stores no chats', async () => {
  mockFetchPlatformConfig.mockResolvedValue({ chats: { persistence: false } });
  await renderWithMenuOpen();

  expect(screen.queryByText('Open in web')).not.toBeInTheDocument();
});

test('is not offered when the platform config cannot be read', async () => {
  mockFetchPlatformConfig.mockRejectedValue(new Error('offline'));
  await renderWithMenuOpen();

  expect(screen.queryByText('Open in web')).not.toBeInTheDocument();
});

test('is shown but inert while there is nothing to continue', async () => {
  mockMessages = [{ id: 'g', role: 'assistant', content: 'Hello!', isGreeting: true }];
  await renderWithMenuOpen();

  expect(screen.getByText('Open in web')).toBeInTheDocument();
  expect(openInWebButton()).not.toBeInTheDocument();
  expect(mockImportChat).not.toHaveBeenCalled();
});

test('is inert while an answer is still streaming', async () => {
  mockProcessing = true;
  await renderWithMenuOpen();

  expect(screen.getByText('Open in web')).toBeInTheDocument();
  expect(openInWebButton()).not.toBeInTheDocument();
});

test('asking again for an unchanged conversation opens the copy that exists', async () => {
  const { rerender } = await renderWithMenuOpen();
  await clickOpenInWeb();

  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  await act(async () => rerender(panel()));
  await clickOpenInWeb();

  expect(mockImportChat).toHaveBeenCalledTimes(1);
  expect(mockFetchChat).toHaveBeenCalledWith('chat-web-1');
  expect(mockOpenExternalUrl).toHaveBeenCalledTimes(2);
  expect(mockOpenExternalUrl).toHaveBeenLastCalledWith(
    'https://ihub.example.com/ihub/apps/chat/c/chat-web-1'
  );
});

test('a conversation that moved on is stored again, as its own chat', async () => {
  const { rerender } = await renderWithMenuOpen();
  await clickOpenInWeb();

  mockMessages = [
    ...conversation(),
    { id: 'u2', role: 'user', content: 'Shorter, please.' },
    { id: 'a2', role: 'assistant', content: 'Dear Mara, yes.' }
  ];
  mockImportChat.mockResolvedValue({ chat: { id: 'chat-web-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  await act(async () => rerender(panel()));
  await clickOpenInWeb();

  expect(mockImportChat).toHaveBeenCalledTimes(2);
  expect(mockImportChat.mock.calls[1][0].messages).toHaveLength(4);
  expect(mockOpenExternalUrl).toHaveBeenLastCalledWith(
    'https://ihub.example.com/ihub/apps/chat/c/chat-web-2'
  );
});

test('stores it again when the earlier copy has been deleted', async () => {
  const { rerender } = await renderWithMenuOpen();
  await clickOpenInWeb();

  mockFetchChat.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
  mockImportChat.mockResolvedValue({ chat: { id: 'chat-web-3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  await act(async () => rerender(panel()));
  await clickOpenInWeb();

  expect(mockImportChat).toHaveBeenCalledTimes(2);
  expect(mockOpenExternalUrl).toHaveBeenLastCalledWith(
    'https://ihub.example.com/ihub/apps/chat/c/chat-web-3'
  );
});

test('says so when the server stores no chats after all, and opens nothing', async () => {
  mockImportChat.mockRejectedValue(apiError(503, 'CHAT_PERSISTENCE_UNAVAILABLE'));
  await renderWithMenuOpen();

  await clickOpenInWeb();

  expect(await screen.findByRole('alert')).toHaveTextContent('does not store chats');
  expect(mockOpenExternalUrl).not.toHaveBeenCalled();
});

test('says so when the user may not use the app in the web app', async () => {
  mockImportChat.mockRejectedValue(apiError(403, 'APP_ACCESS_DENIED'));
  await renderWithMenuOpen();

  await clickOpenInWeb();

  expect(await screen.findByRole('alert')).toHaveTextContent('do not have access');
});

test('gives the address when the host would not open the browser', async () => {
  mockOpenExternalUrl.mockReturnValue(false);
  await renderWithMenuOpen();

  await clickOpenInWeb();

  // The copy exists either way; the user just has to get to it.
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'https://ihub.example.com/ihub/apps/chat/c/chat-web-1'
  );
});

test('the notice can be dismissed', async () => {
  mockImportChat.mockRejectedValue(new Error('Network Error'));
  await renderWithMenuOpen();
  await clickOpenInWeb();
  await screen.findByRole('alert');

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
