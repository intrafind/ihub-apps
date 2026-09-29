import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * The "copy options" menu under a chat message.
 *
 * Issue #2592: the menu was always anchored to its right edge (`right-0`). Under
 * an assistant answer the copy button is the first item of a left-aligned row, so
 * the 10rem menu grew leftward past the pane edge — clipped away entirely in the
 * narrow Outlook task pane. Assistant rows must open rightward (`left-0`); user
 * rows are right-aligned and keep opening leftward (`right-0`).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback || _key, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
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

function openCopyMenu(role) {
  render(
    <ChatMessage
      message={{ id: 'msg-1', role, content: 'Sounds good to me.' }}
      appId="chat"
      chatId="chat-1"
      modelId="m"
    />
  );
  fireEvent.click(screen.getByTitle('Copy Options'));
  // The menu is the positioned container that holds the three format entries.
  return screen.getByText('as Text').parentElement;
}

test('assistant copy menu opens rightward so it stays inside the pane', () => {
  const menu = openCopyMenu('assistant');

  expect(menu).toHaveClass('left-0');
  expect(menu).not.toHaveClass('right-0');
});

test('user copy menu still opens leftward from the right-aligned row', () => {
  const menu = openCopyMenu('user');

  expect(menu).toHaveClass('right-0');
  expect(menu).not.toHaveClass('left-0');
});

test('the menu still offers all three copy formats', () => {
  const menu = openCopyMenu('assistant');

  expect(menu).toHaveTextContent('as Text');
  expect(menu).toHaveTextContent('as Markdown');
  expect(menu).toHaveTextContent('as HTML');
});
