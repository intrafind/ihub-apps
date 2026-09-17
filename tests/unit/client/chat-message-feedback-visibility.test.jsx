/**
 * The `feedback` registry flag hides the star-rating control and the
 * feedback submission modal everywhere `ChatMessage` renders (main chat,
 * compare mode, canvas, Office add-in), threaded in as the `feedbackEnabled`
 * prop by the shared `ChatMessageList` wrapper (see
 * concepts/2026-09-17 Feedback Visibility Toggle.md). This asserts the
 * observable render output of the real `ChatMessage` component, not that a
 * particular prop was passed — following the render-test conventions used
 * elsewhere in this directory (e.g. generated-image.test.jsx).
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => (typeof def === 'string' ? def : key) })
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendMessageFeedback: jest.fn().mockResolvedValue({}),
  answerInteraction: jest.fn()
}));

jest.mock('../../../client/src/utils/chatId', () => ({
  __esModule: true,
  getConversationId: () => 'conv-1'
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-icon={name} />
}));

jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="markdown">{content}</div>
}));

jest.mock('../../../client/src/features/chat/components/AnswerSourceBadge', () => ({
  __esModule: true,
  default: () => null
}));

// The remaining children ChatMessage imports are all conditionally rendered
// (citations, clarifications, generated images, workflow steps, ...) and stay
// unreached by the minimal assistant message this suite renders. They pull in
// Vite-only syntax (`import.meta.env`, via api/client.js and
// utils/runtimeBasePath.js) transitively, which babel-jest can't parse, so
// they're stubbed out rather than chased dependency by dependency.
jest.mock('../../../client/src/features/chat/components/MessageVariables', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/ClarificationCard', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/GeneratedImage', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/CitationPanel', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/GroundingSources', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/SearchStatusIndicator', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/WorkflowStepIndicator', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/workflows/components/HumanCheckpoint', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/ExportDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/StarRating', () => ({
  __esModule: true,
  default: () => <div data-testid="star-rating" />
}));

const ChatMessage = require('../../../client/src/features/chat/components/ChatMessage').default;

const assistantMessage = {
  id: 'msg-1',
  role: 'assistant',
  content: 'The capital of France is Paris.',
  loading: false
};

function renderMessage(props = {}) {
  return render(
    <ChatMessage
      message={assistantMessage}
      appId="app-1"
      chatId="chat-1"
      modelId="gpt-4o"
      {...props}
    />
  );
}

describe('ChatMessage feedback visibility', () => {
  test('shows the star rating under an AI response when feedback is enabled', () => {
    renderMessage({ feedbackEnabled: true });

    expect(screen.getByTestId('star-rating')).toBeInTheDocument();
  });

  test('hides the star rating under an AI response when feedback is disabled', () => {
    renderMessage({ feedbackEnabled: false });

    expect(screen.queryByTestId('star-rating')).not.toBeInTheDocument();
  });

  test('never renders the feedback modal when feedback is disabled', () => {
    renderMessage({ feedbackEnabled: false });

    // The modal can only open via the (now absent) star-rating control, so its
    // heading must never appear in the rendered output either.
    expect(screen.queryByText('Rate this response')).not.toBeInTheDocument();
  });

  test('defaults to enabled when the prop is not threaded through by a caller', () => {
    renderMessage();

    expect(screen.getByTestId('star-rating')).toBeInTheDocument();
  });

  test('never shows the star rating for a user message, regardless of the flag', () => {
    renderMessage({
      message: { id: 'msg-2', role: 'user', content: 'Where is the capital of France?' },
      feedbackEnabled: true
    });

    expect(screen.queryByTestId('star-rating')).not.toBeInTheDocument();
  });
});
