import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * The star rating under an assistant message is gated by two switches: the
 * platform-wide `feedback` feature flag and the app's own `features.feedback`.
 *
 * ChatMessage is the single component every chat surface renders through, so
 * the gate lives there — which is why it is checked here against the real
 * component rather than a stand-in. Only the heavy leaves it renders
 * (markdown streaming, custom renderers) are mocked away.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback || _key, i18n: { language: 'en' } })
}));

const mockPlatformConfig = { featuresMap: {} };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
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
  default: () => null
}));

jest.mock('../../../client/src/shared/components/StarRating', () => ({
  __esModule: true,
  default: () => <div data-testid="star-rating" />
}));

// Leaves that reach for `import.meta` or the DOM, and say nothing about the gate.
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

const assistantMessage = {
  id: 'msg-1',
  role: 'assistant',
  content: 'Paris is the capital of France.'
};

function renderMessage({ features = {}, app = null } = {}) {
  mockPlatformConfig.featuresMap = features;
  return render(
    <ChatMessage message={assistantMessage} appId="chat" chatId="chat-1" modelId="m" app={app} />
  );
}

describe('ChatMessage feedback gate', () => {
  it('shows the rating when nothing opted out', () => {
    renderMessage({ features: {}, app: { id: 'chat' } });
    expect(screen.getByTestId('star-rating')).toBeInTheDocument();
  });

  it('hides the rating when the platform flag is off', () => {
    renderMessage({ features: { feedback: false }, app: { id: 'chat' } });
    expect(screen.queryByTestId('star-rating')).not.toBeInTheDocument();
  });

  it('hides the rating for an app that opted out', () => {
    renderMessage({
      features: { feedback: true },
      app: { id: 'chat', features: { feedback: false } }
    });
    expect(screen.queryByTestId('star-rating')).not.toBeInTheDocument();
  });

  it('keeps the rating for an app that did not opt out', () => {
    renderMessage({
      features: { feedback: true },
      app: { id: 'chat', features: { compareMode: { enabled: true } } }
    });
    expect(screen.getByTestId('star-rating')).toBeInTheDocument();
  });
});
