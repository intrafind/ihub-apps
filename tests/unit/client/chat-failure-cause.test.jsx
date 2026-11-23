// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';
import ChatDiagnosticsContext from '../../../client/src/features/chat/contexts/ChatDiagnosticsContext';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import { createRunState } from '../../../shared/run/runReducer.js';
import {
  failureCauseMessage,
  failureDiagnostics
} from '../../../client/src/features/chat/utils/failureCause';

/**
 * A failed model call whose cause the server named (`failureCause`) is told in
 * a translated sentence instead of the server's generic text; in the admin
 * test panel the admin also sees what to check. A cause the client does not
 * know keeps the server's message.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // `t(key, fallback, params)` and `t(key, { defaultValue, ...params })`.
    t: (key, fallbackOrOptions, params) => {
      const options = typeof fallbackOrOptions === 'string' ? params : fallbackOrOptions;
      const text =
        typeof fallbackOrOptions === 'string' ? fallbackOrOptions : (options?.defaultValue ?? key);
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name]);
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

/** `t` that returns the English fallback, like the app without a loaded locale. */
const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const CERTIFICATE_MESSAGE =
  'The AI model could not be reached securely: the iHub server does not trust the certificate of its service. Please tell your administrator.';

function failedRun(error) {
  return { ...createRunState('run-1'), status: 'error', error };
}

describe('failure cause translation', () => {
  test('a known cause gets its translated message; an unknown one keeps the server text', () => {
    expect(failureCauseMessage(t, { failureCause: 'certificateUntrusted' })).toBe(
      CERTIFICATE_MESSAGE
    );
    expect(failureCauseMessage(t, { failureCause: 'somethingNew' })).toBeNull();
    expect(failureCauseMessage(t, { message: 'openai API service error' })).toBeNull();
  });

  test('the projection replaces the generic server message and keeps the facts', () => {
    const run = failedRun({
      code: 'NETWORK',
      message: 'Network error connecting to openai API',
      failureCause: 'certificateUntrusted',
      host: 'llm.corp.local',
      errorCode: 'SELF_SIGNED_CERT_IN_CHAIN'
    });
    const { content, extras } = projectRunToMessage(run, {
      errorMessageFor: error => failureCauseMessage(t, error)
    });
    expect(content).toContain(CERTIFICATE_MESSAGE);
    expect(content).not.toContain('Network error connecting to openai API');
    expect(extras.failureDiagnostics).toEqual({
      messageKey: 'certificateUntrusted',
      host: 'llm.corp.local',
      errorCode: 'SELF_SIGNED_CERT_IN_CHAIN'
    });
  });

  test('a failure without a cause keeps the server message and no diagnostics', () => {
    const run = failedRun({ code: 'PROVIDER_ERROR', message: 'openai API service error.' });
    const { content, extras } = projectRunToMessage(run, {
      errorMessageFor: error => failureCauseMessage(t, error)
    });
    expect(content).toContain('openai API service error.');
    expect(extras.failureDiagnostics).toBeUndefined();
    expect(failureDiagnostics(run.error)).toBeNull();
  });
});

describe('ChatMessage with a failed model call', () => {
  const storedFailure = {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    fromServer: true,
    error: true,
    errorMessage: 'openai API service error. The service might be experiencing issues.',
    failureDiagnostics: { messageKey: 'serverError', upstreamStatus: 502 }
  };

  function renderMessage(message, { diagnostics = false } = {}) {
    render(
      <MemoryRouter>
        <ChatDiagnosticsContext.Provider value={diagnostics}>
          <ChatMessage message={message} appId="chat" chatId="chat-1" modelId="m" />
        </ChatDiagnosticsContext.Provider>
      </MemoryRouter>
    );
  }

  test('an end user reads the translated cause and no admin diagnostics', () => {
    renderMessage(storedFailure);
    expect(screen.getByText(/The service of the AI model failed to answer\./)).toBeInTheDocument();
    expect(screen.queryByText(/openai API service error/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('connection-error-details')).not.toBeInTheDocument();
  });

  test('the admin test panel adds the facts, what to check and the SSL settings link', () => {
    renderMessage(
      {
        ...storedFailure,
        failureDiagnostics: {
          messageKey: 'certificateUntrusted',
          host: 'llm.corp.local',
          errorCode: 'SELF_SIGNED_CERT_IN_CHAIN'
        }
      },
      { diagnostics: true }
    );
    expect(screen.getByText(CERTIFICATE_MESSAGE)).toBeInTheDocument();
    const details = screen.getByTestId('connection-error-details');
    expect(details).toHaveTextContent('llm.corp.local');
    expect(details).toHaveTextContent('SSL domain whitelist');
    expect(screen.getByRole('link', { name: 'Open the SSL / TLS settings' })).toBeInTheDocument();
  });

  test('a stored failure without a cause keeps the stored message', () => {
    const { failureDiagnostics: _omit, ...withoutCause } = storedFailure;
    renderMessage(withoutCause, { diagnostics: true });
    expect(screen.getByText(/openai API service error\./)).toBeInTheDocument();
    expect(screen.queryByTestId('connection-error-details')).not.toBeInTheDocument();
  });
});
