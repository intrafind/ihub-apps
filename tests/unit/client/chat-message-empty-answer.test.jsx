// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * A finished answer with no text (a reasoning model can end its turn right
 * after thinking) says so and offers Retry instead of a blank bubble.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) =>
      typeof options === 'string'
        ? options
        : (options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name]),
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

function renderAnswer(message, onResend = jest.fn()) {
  render(
    <ChatMessage
      message={{ id: 'msg-1', role: 'assistant', ...message }}
      appId="chat"
      chatId="chat-1"
      modelId="m"
      onResend={onResend}
    />
  );
  return onResend;
}

describe('ChatMessage empty answer', () => {
  test('a finished answer without text shows a notice and retries', () => {
    const onResend = renderAnswer({ content: '\n\n', finishReason: 'stop' });
    expect(screen.getByText('The model returned no answer.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(onResend).toHaveBeenCalledWith('msg-1');
  });

  test.each([
    ['an answer with text', { content: 'Hello', finishReason: 'stop' }],
    ['a streaming answer', { content: '', finishReason: 'stop', loading: true }],
    ['a cancelled answer', { content: '', finishReason: 'stop', cancelled: true }],
    ['an answer with only images', { content: '', finishReason: 'stop', images: [{ url: 'x' }] }]
  ])('%s shows no notice', (_, message) => {
    renderAnswer(message);
    expect(screen.queryByText('The model returned no answer.')).not.toBeInTheDocument();
  });
});
