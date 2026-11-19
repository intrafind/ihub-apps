// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

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

/**
 * The notice under an answer that hit the model's output limit
 * (`finishReason: length`). The server says where it ran out
 * (`limitReachedIn`); the bubble names it in words a user can act on.
 */

function renderAnswer({ content = '', readOnly = false, onResend = jest.fn(), ...message } = {}) {
  render(
    <ChatMessage
      message={{ id: 'msg-1', role: 'assistant', content, finishReason: 'length', ...message }}
      appId="chat"
      chatId="chat-1"
      modelId="m"
      readOnly={readOnly}
      onResend={onResend}
    />
  );
}

describe('ChatMessage output limit notice', () => {
  it('says the thinking used the limit up, and offers a retry', () => {
    renderAnswer({ limitReachedIn: 'reasoning' });
    expect(screen.getByText(/used its whole output limit for thinking/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Truncated')).not.toBeInTheDocument();
  });

  it('says no answer was written when the server did not say why (older answers)', () => {
    renderAnswer();
    expect(screen.getByText(/before it wrote an answer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('says the answer is incomplete when text was written', () => {
    renderAnswer({ content: 'Here are the first jokes', limitReachedIn: 'answer' });
    expect(screen.getByText(/The answer is incomplete/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('offers no Retry where nothing can be resent (shared transcript)', () => {
    renderAnswer({ limitReachedIn: 'reasoning', readOnly: true });
    expect(screen.getByText(/used its whole output limit for thinking/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('does not say "no answer" when the turn produced a file', () => {
    renderAnswer({
      limitReachedIn: 'reasoning',
      generatedFiles: [{ id: 'f1', name: 'report.pdf' }]
    });
    expect(screen.getByText(/The answer is incomplete/)).toBeInTheDocument();
    expect(screen.queryByText(/never got to the answer/)).not.toBeInTheDocument();
  });

  it('shows nothing for an answer that finished normally', () => {
    renderAnswer({ content: 'Done.', finishReason: 'stop' });
    expect(screen.queryByText(/output limit/)).not.toBeInTheDocument();
  });
});
