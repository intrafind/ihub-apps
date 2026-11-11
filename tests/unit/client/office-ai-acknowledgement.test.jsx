import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * The AI-use acknowledgement in the Outlook pane / extension side panel
 * (EU AI Act Art. 50, epic #3324): the gate sits in OfficeChatPanel.submitMessage,
 * before the draft is cleared. Declined keeps the draft; a context that moved
 * while the dialog was open is not sent on its own.
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
let mockAdapterProps = null;
jest.mock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => ({
  __esModule: true,
  default: props => {
    mockAdapterProps = props;
    return {
      messages: [],
      processing: false,
      clarificationPending: false,
      sendMessage: mockSendMessage,
      clearMessages: jest.fn(),
      deleteMessage: jest.fn(),
      editMessage: jest.fn(),
      resendMessage: jest.fn(),
      cancelGeneration: jest.fn()
    };
  }
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
let mockSnapshot = { loading: false, ctx: null };
jest.mock('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot', () => ({
  __esModule: true,
  default: () => ({
    loading: mockSnapshot.loading,
    ctx: mockSnapshot.ctx,
    visibleAttachments: [],
    removedAttachmentIds: new Set(),
    removeAttachment: jest.fn(),
    restoreAttachments: jest.fn(),
    buildSnapshotOverride: () => (mockSnapshot.ctx ? { ...mockSnapshot.ctx } : null),
    includeBody: true,
    setIncludeBody: jest.fn(),
    generation: 0
  })
}));

jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/office/components/chat/ChatHeader', () => ({
  __esModule: true,
  default: ({ menuItems = [] }) => (
    <ul aria-label="menu">
      {menuItems.map(item => (
        <li key={item.key}>
          <button type="button" onClick={item.onClick}>
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}));

let mockGate = null;
jest.mock('../../../client/src/shared/hooks/useAiAcknowledgement', () => ({
  useAiAcknowledgement: () => mockGate
}));

const {
  setPendingChatStart,
  consumePendingChatStart
} = require('../../../client/src/features/chat/startChatHandoff');
const OfficeChatPanel =
  require('../../../client/src/features/office/components/OfficeChatPanel').default;

const authData = { user: { name: 'Ada' } };
const app = { id: 'chat', name: { en: 'Chat' }, system: { en: 'You are helpful.' } };
const mail = id => ({
  available: true,
  itemKind: 'message',
  itemId: id,
  subject: `Mail ${id}`,
  bodyText: 'Body',
  attachments: []
});

const renderPanel = () =>
  render(
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

const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const type = text =>
  fireEvent.change(screen.getByLabelText('message'), { target: { value: text } });

beforeEach(() => {
  mockSendMessage.mockReset();
  mockAdapterProps = null;
  mockModelsLoading = false;
  mockSnapshot = { loading: false, ctx: mail('A') };
  mockGate = null;
  consumePendingChatStart('chat');
});

// The chat input is mocked as a bare textarea; this stands in for "press Send".
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ value, onChange, onSubmit }) => (
    <form onSubmit={onSubmit}>
      <textarea aria-label="message" value={value} onChange={e => onChange?.(e)} />
      <button type="submit">Send</button>
    </form>
  )
}));

describe('without an acknowledgement gate (a host that has none)', () => {
  test('sends at once and clears the draft, as before', async () => {
    renderPanel();
    type('Hello');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('message')).toHaveValue('');
  });
});

describe('with the acknowledgement gate', () => {
  test('nothing is sent or cleared until the user has confirmed; then the same message goes out', async () => {
    const gate = deferred();
    mockGate = { ensureAcknowledged: jest.fn(() => gate.promise), available: true };
    renderPanel();
    type('  Reply politely ');
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(mockGate.ensureAcknowledged).toHaveBeenCalledTimes(1));
    expect(mockGate.ensureAcknowledged).toHaveBeenCalledWith(
      expect.objectContaining({ hasPendingMessage: true })
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    // The draft is still in the composer while the dialog is open.
    expect(screen.getByLabelText('message')).toHaveValue('  Reply politely ');

    gate.resolve(true);
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    expect(mockSendMessage.mock.calls[0][0].apiMessage.content).toBe('Reply politely');
    expect(screen.getByLabelText('message')).toHaveValue('');
  });

  test('Cancel keeps the draft and the context and sends nothing', async () => {
    mockGate = { ensureAcknowledged: jest.fn(() => Promise.resolve(false)), available: true };
    renderPanel();
    type('My question');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mockGate.ensureAcknowledged).toHaveBeenCalled());
    await act(async () => {});
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('message')).toHaveValue('My question');
  });

  test('a start-page hand-off that is declined puts its text into the input', async () => {
    mockGate = { ensureAcknowledged: jest.fn(() => Promise.resolve(false)), available: true };
    setPendingChatStart({
      appId: 'chat',
      text: 'Summarise this thread',
      autoSend: true,
      pinnedEmails: [],
      hostContextOverride: mail('A')
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByLabelText('message')).toHaveValue('Summarise this thread')
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a start-page hand-off that is confirmed is sent once', async () => {
    mockGate = { ensureAcknowledged: jest.fn(() => Promise.resolve(true)), available: true };
    setPendingChatStart({
      appId: 'chat',
      text: 'Summarise this thread',
      autoSend: true,
      pinnedEmails: [],
      hostContextOverride: mail('A')
    });
    renderPanel();
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    expect(mockSendMessage.mock.calls[0][0].apiMessage.content).toBe('Summarise this thread');
  });

  test('the user opened another email while the dialog was open: not sent, draft kept, note shown', async () => {
    const gate = deferred();
    mockGate = {
      ensureAcknowledged: jest.fn(({ onAsk }) => {
        onAsk();
        return gate.promise;
      }),
      available: true
    };
    const view = renderPanel();
    type('About this mail');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mockGate.ensureAcknowledged).toHaveBeenCalled());

    // Outlook moved to email B while the dialog was open.
    mockSnapshot = { loading: false, ctx: mail('B') };
    view.rerender(
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
    gate.resolve(true);

    expect(await screen.findByTestId('ai-ack-context-changed')).toHaveTextContent(
      'What you selected changed while you were confirming'
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('message')).toHaveValue('About this mail');

    // One more press sends it, now about the open email.
    mockGate.ensureAcknowledged = jest.fn(() => Promise.resolve(true));
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    expect(mockSendMessage.mock.calls[0][0].params.hostContextOverride.itemId).toBe('B');
  });

  test('the same email after the dialog is sent on its own', async () => {
    mockGate = {
      ensureAcknowledged: jest.fn(({ onAsk }) => {
        onAsk();
        return Promise.resolve(true);
      }),
      available: true
    };
    renderPanel();
    type('Same mail');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
  });

  test('no dialog shown (already confirmed): a context that is still loading does not hold the send back', async () => {
    mockGate = { ensureAcknowledged: jest.fn(() => Promise.resolve(true)), available: true };
    mockSnapshot = { loading: true, ctx: null };
    renderPanel();
    type('Quick');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
  });

  test('a reactive 428 that the user declines restores the text and the files', async () => {
    mockGate = { ensureAcknowledged: jest.fn(() => Promise.resolve(true)), available: true };
    renderPanel();
    expect(typeof mockAdapterProps.onSendRefused).toBe('function');
    act(() => {
      mockAdapterProps.onSendRefused({
        displayMessage: { content: 'Typed question' },
        apiMessage: {
          content: 'Typed question',
          imageData: null,
          // An email attachment (no `type`) is re-read fresh, never put back.
          fileData: [{ type: 'document', name: 'a.pdf' }, { name: 'mail-attachment.docx' }]
        }
      });
    });
    expect(screen.getByLabelText('message')).toHaveValue('Typed question');
  });

  test('the pane menu has an "AI-use notice" entry that reopens the notice, only while the feature is on', async () => {
    const review = jest.fn();
    mockGate = { ensureAcknowledged: jest.fn(), available: true, review };
    const view = renderPanel();
    fireEvent.click(screen.getByText('AI-use notice'));
    expect(review).toHaveBeenCalledTimes(1);
    view.unmount();

    mockGate = { ensureAcknowledged: jest.fn(), available: false, review };
    renderPanel();
    expect(screen.queryByText('AI-use notice')).toBeNull();
  });

  test('after a declined dialog the composer shows the note with a way back', async () => {
    const review = jest.fn();
    mockGate = {
      ensureAcknowledged: jest.fn(),
      available: true,
      pending: true,
      declined: true,
      review
    };
    renderPanel();
    expect(screen.getByTestId('ai-ack-note')).toHaveTextContent(
      'Please confirm the AI-use notice to send messages.'
    );
    fireEvent.click(screen.getByText('Review notice'));
    expect(review).toHaveBeenCalled();
  });
});
