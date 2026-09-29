import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessageList from '../../../client/src/features/chat/components/ChatMessageList';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';

/**
 * Issue #2601: an app like the NDA analyzer is used by uploading a document
 * without typing anything. The live turn shows a file chip, but the store keeps
 * only empty content plus the attachment descriptor — and the list dropped
 * every user message without text, so a reopened chat showed the answer with
 * no question above it.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback || _key, i18n: { language: 'en' } })
}));

// `useChatMessages` (for `transformStoredMessage`) imports the debug logger,
// which reads `import.meta`.
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));

jest.mock('../../../client/src/shared/components/integrations/IntegrationAuthPrompts', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));

jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));

jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => <div data-testid="custom-renderer" />
}));

jest.mock('../../../client/src/shared/components/StarRating', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() },
  default: { get: jest.fn(), post: jest.fn() }
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  buildPath: path => path
}));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const app = { id: 'nda-risk-analyzer', customResponseRenderer: 'nda-results' };

function renderList(messages) {
  return render(
    <ChatMessageList
      messages={messages}
      outputFormat="json"
      appId={app.id}
      chatId="chat-1"
      modelId="m"
      app={app}
    />
  );
}

describe('ChatMessageList upload-only user turn', () => {
  it('shows a reopened upload-only turn with the file it sent', () => {
    const messages = [
      transformStoredMessage({
        id: 'u1',
        role: 'user',
        content: '',
        attachments: [{ type: 'application/pdf', name: 'nda.pdf', bytes: 1234 }]
      }),
      transformStoredMessage({ id: 'a1', role: 'assistant', content: '{"clauses":[]}' })
    ];

    renderList(messages);

    expect(screen.getByLabelText('Attachments')).toHaveTextContent('nda.pdf');
    expect(screen.getByTestId('custom-renderer')).toBeInTheDocument();
  });

  it('still hides the empty auto-start turn', () => {
    const { container } = renderList([
      { id: 'u1', role: 'user', content: '', variables: { custom_rules: 'x' } },
      { id: 'a1', role: 'assistant', content: '{"clauses":[]}' }
    ]);

    expect(container.querySelectorAll('.chat-widget-message.user')).toHaveLength(0);
    expect(screen.queryByLabelText('Attachments')).not.toBeInTheDocument();
  });
});
