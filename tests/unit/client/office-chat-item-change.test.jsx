import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Outlook fires SelectedItemsChanged for far more than "the user opened a
 * different email" — re-selecting the same message, Ctrl-selecting, list
 * refreshes on incoming mail. The pane used to wipe the conversation on every
 * such event, losing finished answers without warning (issue #2450). The chat
 * may only start over when ItemChanged reports a genuinely different item,
 * and even then the previous conversation must be restorable.
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

// Transcripts keyed by chatId, like the per-chat session storage the real
// chat hook reads back when the chatId changes.
const mockTranscripts = {};
const mockClearMessages = jest.fn();
let mockProcessing = false;
jest.mock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ chatId }) => {
      const [, rerender] = React.useReducer(n => n + 1, 0);
      return {
        messages: mockTranscripts[chatId] || [],
        processing: mockProcessing,
        clarificationPending: false,
        sendMessage: ({ displayMessage }) => {
          mockTranscripts[chatId] = [
            ...(mockTranscripts[chatId] || []),
            { id: `u${Date.now()}`, role: 'user', content: displayMessage.content },
            { id: `a${Date.now()}`, role: 'assistant', content: 'Answer' }
          ];
          rerender();
        },
        clearMessages: () => {
          mockClearMessages();
          rerender();
        },
        deleteMessage: jest.fn(),
        editMessage: jest.fn(),
        resendMessage: jest.fn(),
        cancelGeneration: jest.fn()
      };
    }
  };
});

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
  default: ({ value, onChange }) => (
    <textarea aria-label="message" value={value} onChange={e => onChange?.(e)} />
  )
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => null
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
  default: ({ messages }) => (
    <ul aria-label="messages">
      {messages.map(m => (
        <li key={m.id}>{m.content}</li>
      ))}
    </ul>
  )
}));

jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ value, onChange, onSubmit }) => (
    <form onSubmit={onSubmit}>
      <textarea aria-label="message" value={value} onChange={e => onChange?.(e)} />
      <button type="submit">Send</button>
    </form>
  )
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => null
}));

const OfficeChatPanel =
  require('../../../client/src/features/office/components/OfficeChatPanel').default;

const app = {
  id: 'chat',
  name: { en: 'Chat' },
  system: { en: 'You are helpful.' },
  starterPrompts: []
};

function openItem(itemId) {
  global.Office = {
    context: { mailbox: { item: itemId ? { itemId, itemType: 'message' } : null } }
  };
}

function fire(source) {
  act(() => {
    document.dispatchEvent(new CustomEvent('ihub:itemchanged', { detail: { source } }));
  });
}

const messages = () => screen.getByRole('list', { name: 'messages' });

function renderPanelWithAnswer() {
  render(
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
  fireEvent.change(screen.getByLabelText('message'), { target: { value: 'Summarize' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(messages()).toHaveTextContent('Answer');
}

beforeEach(() => {
  for (const key of Object.keys(mockTranscripts)) delete mockTranscripts[key];
  mockClearMessages.mockReset();
  mockProcessing = false;
  openItem('ITEM-A');
});

afterEach(() => {
  delete global.Office;
});

test('repeated events for the same item leave the conversation untouched', () => {
  renderPanelWithAnswer();
  fireEvent.change(screen.getByLabelText('message'), { target: { value: 'half-typed' } });

  fire('ItemChanged');
  fire('ItemChanged');
  fire('SelectedItemsChanged');

  expect(mockClearMessages).not.toHaveBeenCalled();
  expect(messages()).toHaveTextContent('Answer');
  expect(screen.getByLabelText('message')).toHaveValue('half-typed');
});

test('a selection change never clears the chat, even when the live item differs', () => {
  renderPanelWithAnswer();

  openItem('ITEM-B');
  fire('SelectedItemsChanged');
  // Deselecting / multi-selecting leaves no single item open.
  openItem(null);
  fire('ItemChanged');

  expect(mockClearMessages).not.toHaveBeenCalled();
  expect(messages()).toHaveTextContent('Answer');
});

test('a different email starts a new chat that can be undone', () => {
  renderPanelWithAnswer();
  fireEvent.change(screen.getByLabelText('message'), { target: { value: 'follow-up' } });

  openItem('ITEM-B');
  fire('SelectedItemsChanged');
  fire('ItemChanged');

  expect(mockClearMessages).toHaveBeenCalledTimes(1);
  expect(messages()).not.toHaveTextContent('Answer');
  expect(screen.getByLabelText('message')).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent('New chat started for this email.');

  fireEvent.click(screen.getByRole('button', { name: 'Restore previous chat' }));

  expect(messages()).toHaveTextContent('Answer');
  expect(screen.getByLabelText('message')).toHaveValue('follow-up');
  expect(screen.queryByRole('button', { name: 'Restore previous chat' })).not.toBeInTheDocument();
});

test('an answer still streaming is not cleared by an item change', () => {
  renderPanelWithAnswer();
  mockProcessing = true;
  // Re-render so the panel sees the adapter's processing state.
  fireEvent.change(screen.getByLabelText('message'), { target: { value: 'more' } });

  openItem('ITEM-B');
  fire('ItemChanged');

  expect(mockClearMessages).not.toHaveBeenCalled();
  expect(messages()).toHaveTextContent('Answer');
});
