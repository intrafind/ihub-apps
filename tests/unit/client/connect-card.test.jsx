/**
 * The one Connect card of every protocol (#2917) and the retry after a
 * connect:
 *
 *   - `tool/completed.authRequired` projects onto `message.integrationAuthRequired`
 *     (one per integration), and stored answers bring it back;
 *   - the card renders the same for Jira, a per-user MCP server and a cloud
 *     storage provider: why, permissions in plain words, sign-in host,
 *     Connect / Not now;
 *   - needs-reconnect says why and what changes (expired, new permission);
 *   - Connect asks the server for the sign-in URL with the current page as
 *     return URL (reconnect with the new scopes) and leaves for it;
 *   - the sign-in result is read once from the URL;
 *   - after a connect the answer that needed it is retried exactly once, only
 *     when it is the last answer; an adapter or transport failure (no card)
 *     is never retried.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';
import {
  buildAuthPrompts,
  normalizeAuthPrompts
} from '../../../client/src/features/integrations/connect/authPrompts';
import {
  consumeConnectResult,
  currentReturnUrl,
  parseConnectResult,
  readConnectResult,
  resetConnectResultForTests
} from '../../../client/src/features/integrations/connect/connectResult';
import {
  findRetryTarget,
  markRetried,
  pendingRetry,
  resetConnectRetryForTests,
  retryKey,
  wasRetried
} from '../../../client/src/features/integrations/connect/connectRetry';
import { useConnectRetry } from '../../../client/src/features/integrations/connect/useConnectRetry';
import {
  permissionsByEffect,
  resetIntegrationInfoForTests
} from '../../../client/src/features/integrations/connect/integrationInfo';
import ConnectCards, {
  ConnectCard
} from '../../../client/src/features/integrations/connect/ConnectCard';

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${endpoint.replace(/^\//, '')}`
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      const text =
        typeof defaultOrOptions === 'string'
          ? defaultOrOptions
          : typeof options.defaultValue === 'string'
            ? options.defaultValue
            : key;
      return Object.entries(options).reduce(
        (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

// The user integrations API (`GET /api/integrations/:id`, `POST …/connect`).
const mockIntegrations = new Map();
const mockRequestConnectUrl = jest.fn(async () => 'https://auth.example.com/authorize?state=s');
jest.mock('../../../client/src/api/userIntegrationsApi', () => ({
  fetchUserIntegration: jest.fn(async id => mockIntegrations.get(id) || null),
  fetchUserIntegrations: jest.fn(async () => [...mockIntegrations.values()]),
  requestConnectUrl: (...args) => mockRequestConnectUrl(...args),
  disconnectUserIntegration: jest.fn()
}));

const JIRA = {
  id: 'jira',
  name: 'Atlassian Jira',
  protocol: 'native',
  capabilities: ['tools'],
  actions: [
    { name: 'searchTickets', title: 'Search issues', sideEffect: 'read' },
    { name: 'getTicket', title: 'Read an issue', sideEffect: 'read' },
    { name: 'addComment', title: 'Add a comment', sideEffect: 'write' }
  ],
  connection: {
    mode: 'personal',
    status: 'not_connected',
    reason: 'not_connected',
    signInHost: 'auth.atlassian.com'
  }
};
const OKTA = {
  id: 'okta',
  name: 'Okta MCP',
  protocol: 'mcp',
  capabilities: ['tools'],
  actions: [{ name: 'whoami', title: 'whoami', sideEffect: 'read' }],
  connection: { mode: 'personal', status: 'needs_reconnect', reason: 'expired' }
};
const DRIVE = {
  id: 'gdrive-main',
  name: 'Google Drive',
  type: 'storage',
  protocol: 'native',
  capabilities: ['files'],
  actions: [],
  connection: {
    mode: 'personal',
    status: 'not_connected',
    reason: 'not_connected',
    signInHost: 'accounts.google.com'
  }
};

const ts = seq => `2026-11-02T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}) => ({ v: 2, seq, runId: 'run-1', ts: ts(seq), type, data });
const started = env(1, 'run/started', {
  kind: 'chat',
  refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
});
const JIRA_PROMPT = {
  integration: 'jira',
  name: 'Atlassian Jira',
  reason: 'not_connected',
  action: 'Search issues'
};
const toolFrames = (seq, callId, authRequired = JIRA_PROMPT) => [
  env(seq, 'tool/started', {
    step: 1,
    callId,
    toolId: 'jira_searchTickets',
    name: 'jira_searchTickets',
    args: {},
    execution: 'server'
  }),
  env(seq + 1, 'tool/completed', {
    step: 1,
    callId,
    toolId: 'jira_searchTickets',
    name: 'jira_searchTickets',
    resultPreview: { error: 'INTEGRATION_AUTH_REQUIRED' },
    ...(authRequired ? { authRequired } : {})
  })
];
const runFrom = envelopes =>
  getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');

beforeEach(() => {
  mockIntegrations.clear();
  mockIntegrations.set('jira', JIRA);
  mockIntegrations.set('okta', OKTA);
  mockIntegrations.set('gdrive-main', DRIVE);
  mockRequestConnectUrl.mockClear();
});

afterEach(() => {
  resetConnectResultForTests();
  resetConnectRetryForTests();
  resetIntegrationInfoForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('message.integrationAuthRequired', () => {
  test('projects one prompt per integration from tool/completed', () => {
    const run = runFrom([started, ...toolFrames(2, 'c1'), ...toolFrames(4, 'c2')]);
    expect(buildAuthPrompts(run)).toEqual([JIRA_PROMPT]);
    expect(projectRunToMessage(run).extras.integrationAuthRequired).toEqual([JIRA_PROMPT]);
  });

  test('a call that failed inside the adapter carries no prompt', () => {
    const run = runFrom([started, ...toolFrames(2, 'c1', null)]);
    expect(buildAuthPrompts(run)).toBeNull();
    expect(projectRunToMessage(run).extras.integrationAuthRequired).toBeUndefined();
  });

  test('a stored answer brings its prompts back', () => {
    const message = transformStoredMessage({
      id: 'm1',
      role: 'assistant',
      content: 'Please connect Jira.',
      integrationAuthRequired: [JIRA_PROMPT]
    });
    expect(message.integrationAuthRequired).toEqual([JIRA_PROMPT]);
  });

  test('drops malformed prompts and unknown reasons', () => {
    expect(
      normalizeAuthPrompts([
        null,
        { name: 'x' },
        { integration: 'okta', reason: 'bogus' },
        JIRA_PROMPT,
        JIRA_PROMPT
      ])
    ).toEqual([{ integration: 'okta', name: 'okta', reason: 'not_connected' }, JIRA_PROMPT]);
    expect(normalizeAuthPrompts('nope')).toEqual([]);
    // Scopes are non-empty strings, and left out when none remain.
    expect(
      normalizeAuthPrompts([
        { integration: 'okta', reason: 'insufficient_scope', scopes: ['', 3, 'tickets:write'] },
        { integration: 'jira', scopes: [''] }
      ])
    ).toEqual([
      {
        integration: 'okta',
        name: 'okta',
        reason: 'insufficient_scope',
        scopes: ['tickets:write']
      },
      { integration: 'jira', name: 'jira', reason: 'not_connected' }
    ]);
  });
});

describe('sign-in result', () => {
  test('parses the one result shape of every integration', () => {
    expect(parseConnectResult('http://localhost/c?integration_connected=jira')).toEqual({
      connected: 'jira',
      error: null,
      errorIntegration: null
    });
    expect(
      parseConnectResult('http://localhost/c?integration_error=access_denied&integration=okta')
    ).toEqual({ connected: null, error: 'access_denied', errorIntegration: 'okta' });
    // An unknown code never reaches the UI as such.
    expect(parseConnectResult('http://localhost/c?integration_error=<b>x</b>').error).toBe(
      'oauth_failed'
    );
  });

  test('is read once and removed from the URL', () => {
    window.history.replaceState(null, '', '/apps/a/c/1?integration_connected=jira&keep=1');
    expect(consumeConnectResult().connected).toBe('jira');
    expect(window.location.search).toBe('?keep=1');
    // Every later reader on this page sees the same answer.
    expect(consumeConnectResult().connected).toBe('jira');
  });

  test('reading it during render leaves the URL alone; a card removes it after mount', async () => {
    window.history.replaceState(null, '', '/apps/a/c/1?integration_connected=jira&keep=1');
    const replaceState = jest.spyOn(window.history, 'replaceState');
    const popstate = jest.fn();
    window.addEventListener('popstate', popstate);
    try {
      expect(readConnectResult().connected).toBe('jira');
      expect(replaceState).not.toHaveBeenCalled();
      expect(window.location.search).toBe('?integration_connected=jira&keep=1');
      // The card reads it in render; the clean-up runs in an effect.
      render(<ConnectCard prompt={JIRA_PROMPT} />);
      await waitFor(() => expect(window.location.search).toBe('?keep=1'));
      expect(popstate).toHaveBeenCalledTimes(1);
      expect(readConnectResult().connected).toBe('jira');
    } finally {
      replaceState.mockRestore();
      window.removeEventListener('popstate', popstate);
    }
  });

  test('the return URL is the current page without the result parameters', () => {
    window.history.replaceState(null, '', '/apps/a/c/1?integration_error=x&integration=y&keep=1');
    expect(currentReturnUrl()).toBe('http://localhost/apps/a/c/1?keep=1');
  });
});

describe('ConnectCard', () => {
  test('Jira: why, sign-in host, permissions in plain words, Connect / Not now', async () => {
    render(<ConnectCard prompt={JIRA_PROMPT} />);
    expect(
      await screen.findByText(/You will sign in at auth\.atlassian\.com\./)
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect Atlassian Jira' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Connect Atlassian Jira' })).toBeInTheDocument();
    expect(
      screen.getByText(/To run “Search issues” for your request, iHub needs to act as you/)
    ).toBeInTheDocument();
    expect(screen.getByText('Search issues, Read an issue')).toBeInTheDocument();
    expect(screen.getByText('Add a comment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  test('per-user MCP: needs reconnect says why and offers Reconnect', async () => {
    render(<ConnectCard prompt={{ integration: 'okta', name: 'Okta MCP', reason: 'expired' }} />);
    expect(await screen.findByRole('heading', { name: 'Reconnect Okta MCP' })).toBeInTheDocument();
    expect(screen.getByText(/has expired or was revoked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect/ })).toBeInTheDocument();
  });

  test('cloud storage: the same card, worded for files', async () => {
    render(
      <ConnectCard
        prompt={{ integration: 'gdrive-main', name: 'Google Drive', reason: 'not_connected' }}
        context="files"
      />
    );
    expect(
      await screen.findByText(/To show your files, iHub needs to act as you in Google Drive\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/accounts\.google\.com/)).toBeInTheDocument();
  });

  test('a new permission is shown and the reconnect asks for it', async () => {
    const navigate = jest.fn();
    window.history.replaceState(null, '', '/apps/a/c/chat-1');
    render(
      <ConnectCard
        prompt={{
          integration: 'okta',
          name: 'Okta MCP',
          reason: 'insufficient_scope',
          scopes: ['openid', 'tickets:write']
        }}
        navigate={navigate}
      />
    );
    expect(
      await screen.findByRole('heading', { name: 'Okta MCP needs another permission' })
    ).toBeInTheDocument();
    expect(screen.getByText('openid, tickets:write')).toBeInTheDocument();
    expect(screen.getByText(/keeps your connection and adds it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reconnect/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(mockRequestConnectUrl).toHaveBeenCalledWith('okta', {
      reconnect: true,
      scopes: ['openid', 'tickets:write'],
      returnUrl: 'http://localhost/apps/a/c/chat-1'
    });
    expect(navigate).toHaveBeenCalledWith('https://auth.example.com/authorize?state=s');
  });

  test('Connect returns to the same chat', async () => {
    const navigate = jest.fn();
    window.history.replaceState(null, '', '/apps/a/c/chat-1');
    render(<ConnectCard prompt={JIRA_PROMPT} navigate={navigate} />);
    await screen.findByText(/auth\.atlassian\.com/);
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(mockRequestConnectUrl).toHaveBeenCalledWith('jira', {
      reconnect: false,
      scopes: undefined,
      returnUrl: 'http://localhost/apps/a/c/chat-1'
    });
  });

  test('a refused start is announced', async () => {
    mockRequestConnectUrl.mockRejectedValueOnce(new Error('nope'));
    render(<ConnectCard prompt={JIRA_PROMPT} navigate={jest.fn()} />);
    await screen.findByText(/auth\.atlassian\.com/);
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The sign-in to Atlassian Jira could not be started.'
    );
  });

  test('Not now folds the card away and can bring it back', async () => {
    render(<ConnectCard prompt={JIRA_PROMPT} />);
    await screen.findByText(/auth\.atlassian\.com/);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByText('Atlassian Jira is not connected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByRole('region', { name: 'Connect Atlassian Jira' })).toBeInTheDocument();
  });

  test('expired, while the status still says connected: offers Reconnect', async () => {
    mockIntegrations.set('gdrive-main', {
      ...DRIVE,
      connection: { mode: 'personal', status: 'connected', account: 'erin@example.com' }
    });
    render(
      <ConnectCard
        prompt={{ integration: 'gdrive-main', name: 'Google Drive', reason: 'expired' }}
        context="files"
      />
    );
    expect(
      await screen.findByRole('heading', { name: 'Reconnect Google Drive' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect/ })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('expired, then connected from this page: says connected', async () => {
    window.history.replaceState(null, '', '/apps/a/c/1?integration_connected=gdrive-main');
    mockIntegrations.set('gdrive-main', {
      ...DRIVE,
      connection: { mode: 'personal', status: 'connected', account: 'erin@example.com' }
    });
    render(
      <ConnectCard
        prompt={{ integration: 'gdrive-main', name: 'Google Drive', reason: 'expired' }}
      />
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Google Drive is connected as erin@example.com.'
    );
  });

  test('says so when the user is connected by now', async () => {
    mockIntegrations.set('jira', {
      ...JIRA,
      connection: { mode: 'personal', status: 'connected', account: 'daniel@example.com' }
    });
    render(<ConnectCard prompt={JIRA_PROMPT} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Atlassian Jira is connected as daniel@example.com.'
    );
  });

  test('announces a sign-in that came back with an error for this integration', async () => {
    window.history.replaceState(
      null,
      '',
      '/apps/a/c/1?integration_error=access_denied&integration=jira'
    );
    render(<ConnectCard prompt={JIRA_PROMPT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connecting Atlassian Jira did not succeed. Try again.'
    );
  });

  test('shared chats show the notice without buttons', async () => {
    render(<ConnectCards prompts={[JIRA_PROMPT]} readOnly />);
    await screen.findByText(/auth\.atlassian\.com/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('permissions are grouped by side effect in a stable order', () => {
    expect(
      permissionsByEffect([
        { title: 'Delete', sideEffect: 'destructive' },
        { title: 'Read', sideEffect: 'read' },
        { name: 'raw', sideEffect: 'nonsense' },
        { title: 'Read', sideEffect: 'read' }
      ])
    ).toEqual([
      { effect: 'read', titles: ['Read'] },
      { effect: 'destructive', titles: ['Delete'] },
      { effect: 'unknown', titles: ['raw'] }
    ]);
  });
});

describe('retry once after connecting', () => {
  const user = { id: 'u1', role: 'user', content: 'What are my open tickets?' };
  const answer = {
    id: 'a1',
    role: 'assistant',
    content: 'Please connect Jira.',
    integrationAuthRequired: [JIRA_PROMPT]
  };

  test('targets the last answer that needed the connection', () => {
    expect(findRetryTarget([user, answer], 'jira')).toEqual({
      messageId: 'a1',
      prompt: JIRA_PROMPT
    });
    // System notices do not count as moving on.
    expect(
      findRetryTarget([user, answer, { role: 'system', content: 'x' }], 'jira')
    ).not.toBeNull();
  });

  test('not when the user has moved on, another integration was connected or it is still loading', () => {
    expect(findRetryTarget([user, answer, { id: 'u2', role: 'user' }], 'jira')).toBeNull();
    expect(findRetryTarget([user, answer], 'okta')).toBeNull();
    expect(findRetryTarget([user, { ...answer, loading: true }], 'jira')).toBeNull();
  });

  test('a failure inside the adapter or on the transport is never retried', () => {
    const failed = { id: 'a2', role: 'assistant', content: 'Jira answered 500.', error: true };
    expect(findRetryTarget([user, failed], 'jira')).toBeNull();
    expect(pendingRetry({ connected: 'jira', chatId: 'c', messages: [user, failed] })).toBeNull();
  });

  test('is pending until marked, then never again, across reloads', () => {
    const messages = [user, answer];
    const target = pendingRetry({ connected: 'jira', chatId: 'c', messages });
    expect(target).toMatchObject({ messageId: 'a1', key: retryKey('c', 'a1') });
    // Deciding does not claim it.
    expect(pendingRetry({ connected: 'jira', chatId: 'c', messages })).not.toBeNull();
    markRetried(target.key);
    expect(pendingRetry({ connected: 'jira', chatId: 'c', messages })).toBeNull();
    expect(window.sessionStorage.getItem(retryKey('c', 'a1'))).toBe('1');
    // A new page load (in-memory record gone) still finds it in the session.
    resetConnectRetryForTests();
    expect(pendingRetry({ connected: 'jira', chatId: 'c', messages })).toBeNull();
  });

  test('a browser that blocks session storage does not break the chat', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      }
    });
    try {
      expect(wasRetried('k')).toBe(false);
      expect(() => markRetried('k')).not.toThrow();
      // The in-memory record still holds for this page.
      expect(wasRetried('k')).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    }
  });

  function Harness({ messages, ready, busy, send }) {
    useConnectRetry({ chatId: 'chat-1', messages, ready, busy, send });
    return null;
  }

  test('the chat sends one follow-up once the transcript is loaded and idle', async () => {
    window.history.replaceState(null, '', '/apps/a/c/chat-1?integration_connected=jira');
    const send = jest.fn(async () => true);
    const { rerender } = render(<Harness messages={[]} ready={false} busy={false} send={send} />);
    expect(send).not.toHaveBeenCalled();
    rerender(<Harness messages={[user, answer]} ready busy send={send} />);
    expect(send).not.toHaveBeenCalled();
    rerender(<Harness messages={[user, answer]} ready busy={false} send={send} />);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('I connected Atlassian Jira. Please try again.');
    act(() => {
      rerender(<Harness messages={[user, answer]} ready busy={false} send={send} />);
    });
    expect(send).toHaveBeenCalledTimes(1);
    // Marked once the chat took it.
    await waitFor(() => expect(window.sessionStorage.getItem(retryKey('chat-1', 'a1'))).toBe('1'));
  });

  test('a message the chat turned away is not counted as the retry', async () => {
    window.history.replaceState(null, '', '/apps/a/c/chat-1?integration_connected=jira');
    const send = jest.fn(async () => false);
    render(<Harness messages={[user, answer]} ready busy={false} send={send} />);
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(window.sessionStorage.getItem(retryKey('chat-1', 'a1'))).toBeNull();
    expect(wasRetried(retryKey('chat-1', 'a1'))).toBe(false);
  });

  test('nothing is sent without a successful connect', () => {
    window.history.replaceState(
      null,
      '',
      '/apps/a/c/chat-1?integration_error=access_denied&integration=jira'
    );
    const send = jest.fn();
    render(<Harness messages={[user, answer]} ready busy={false} send={send} />);
    expect(send).not.toHaveBeenCalled();
  });
});
