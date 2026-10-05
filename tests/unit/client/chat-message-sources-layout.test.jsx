import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * Where an answer's sources sit: the "Searched for …" entry that opens the
 * sources panel is above the answer, the list of what it cites is at its end
 * — and only once the answer is complete, so it does not grow under the text
 * while it streams.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
      const values = typeof fallback === 'object' ? fallback : options || {};
      return Object.entries(values).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));

jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));

jest.mock('../../../client/src/api/endpoints/sources', () => ({
  __esModule: true,
  fetchSourceContent: jest.fn(),
  fetchSourceMetadata: jest.fn(() => Promise.resolve({}))
}));

jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));

jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
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

const message = {
  id: 'msg-1',
  role: 'assistant',
  content: 'Langdock is an AI platform [1](https://langdock.com/).',
  sources: {
    queries: ['what is langdock'],
    items: [
      {
        id: 'url:langdock.com',
        provider: 'web',
        kind: 'page',
        url: 'https://langdock.com/',
        title: 'Langdock',
        private: false
      }
    ]
  }
};

function renderMessage(overrides = {}) {
  return render(
    <ChatMessage message={{ ...message, ...overrides }} appId="chat" chatId="chat-1" modelId="m" />
  );
}

const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test('the sources entry is above the answer, the cited list below it', () => {
  renderMessage();
  const entry = screen.getByRole('button', { name: /Searched for “what is langdock”/ });
  const content = screen.getByTestId('content');
  const cited = screen.getByRole('list', { name: 'Cited in this answer' });

  expect(follows(entry, content)).toBe(true);
  expect(follows(content, cited)).toBe(true);
});

test('while the answer streams, the entry is there but the cited list is not', () => {
  renderMessage({ loading: true });
  expect(screen.getByRole('button', { name: /Searched for/ })).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Cited in this answer' })).not.toBeInTheDocument();
});
