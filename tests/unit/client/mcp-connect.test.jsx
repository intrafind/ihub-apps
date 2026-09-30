/**
 * Chat "Connect" card for MCP servers with per-user sign-in: the projection of
 * `tool/completed.authRequired` onto `message.mcpAuthRequired`, stored
 * answers, the card's Connect button, and the "Connected" state after the
 * sign-in redirect returns with `?mcp_connected=<serverId>`.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';
import {
  buildMcpAuthPrompts,
  consumeMcpConnectResult,
  normalizeMcpAuthPrompts,
  resetMcpConnectResultForTests
} from '../../../client/src/features/chat/mcpApps/mcpConnectPrompts';
import {
  buildMcpConnectUrl,
  currentReturnUrl
} from '../../../client/src/features/chat/mcpApps/mcpConnectUrl';
import McpConnectCards, {
  McpConnectCard
} from '../../../client/src/features/chat/mcpApps/McpConnectCard';

// The runtime base path module reads `import.meta`, which this jest setup
// cannot load; the other chat tests mock it the same way.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${endpoint.replace(/^\//, '')}`
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
      return Object.entries(options).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
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

// The live connection state the cards ask for (GET /api/mcp/oauth/connections).
const mockConnectionStates = { value: new Map() };
jest.mock('../../../client/src/features/chat/mcpApps/mcpConnectionStatus', () => ({
  fetchMcpConnectionStates: jest.fn(async () => mockConnectionStates.value),
  invalidateMcpConnectionStates: jest.fn()
}));

const AUTH = {
  serverId: 'okta',
  serverName: 'Okta MCP',
  connectUrl: '/api/mcp/oauth/authorize?serverId=okta'
};

const ts = seq => `2026-09-26T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}) => ({ v: 2, seq, runId: 'run-1', ts: ts(seq), type, data });
const started = env(1, 'run/started', {
  kind: 'chat',
  refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
});
const toolFrames = (seq, callId) => [
  env(seq, 'tool/started', {
    step: 1,
    callId,
    toolId: 'okta__get-current-user',
    name: 'okta__get-current-user',
    args: {},
    execution: 'server'
  }),
  env(seq + 1, 'tool/completed', {
    step: 1,
    callId,
    toolId: 'okta__get-current-user',
    name: 'okta__get-current-user',
    resultPreview: { error: 'MCP_AUTH_REQUIRED' },
    authRequired: AUTH
  })
];
const runFrom = envelopes =>
  getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');

afterEach(() => {
  resetMcpConnectResultForTests();
  mockConnectionStates.value = new Map();
  window.history.replaceState(null, '', '/');
});

describe('message.mcpAuthRequired', () => {
  test('projects one prompt per server from tool/completed', () => {
    const run = runFrom([started, ...toolFrames(2, 'c1'), ...toolFrames(4, 'c2')]);
    expect(buildMcpAuthPrompts(run)).toEqual([{ serverId: 'okta', serverName: 'Okta MCP' }]);
    const { extras } = projectRunToMessage(run);
    expect(extras.mcpAuthRequired).toEqual([{ serverId: 'okta', serverName: 'Okta MCP' }]);
  });

  test('turns without auth prompts carry none', () => {
    expect(projectRunToMessage(runFrom([started])).extras.mcpAuthRequired).toBeUndefined();
  });

  test('a stored answer brings its prompts back', () => {
    const message = transformStoredMessage({
      id: 'm1',
      role: 'assistant',
      content: 'Please connect Okta.',
      mcpAuthRequired: [AUTH]
    });
    expect(message.mcpAuthRequired).toEqual([AUTH]);
  });

  test('drops malformed prompts', () => {
    expect(normalizeMcpAuthPrompts([null, { serverName: 'x' }, AUTH, AUTH])).toEqual([
      { serverId: 'okta', serverName: 'Okta MCP' }
    ]);
    expect(normalizeMcpAuthPrompts('nope')).toEqual([]);
  });
});

describe('connect URL', () => {
  test('starts the sign-in for the server and returns to the current page', () => {
    window.history.replaceState(null, '', '/chat/app-1?mcp_error=oauth_failed&keep=1');
    expect(currentReturnUrl()).toBe('http://localhost/chat/app-1?keep=1');
    const url = new URL(buildMcpConnectUrl('okta'), 'http://localhost');
    expect(url.pathname).toMatch(/\/api\/mcp\/oauth\/authorize$/);
    expect(url.searchParams.get('serverId')).toBe('okta');
    expect(url.searchParams.get('returnUrl')).toBe('http://localhost/chat/app-1?keep=1');
  });
});

describe('McpConnectCard', () => {
  test('explains the sign-in and navigates to the connect URL', () => {
    const navigate = jest.fn();
    render(<McpConnectCard prompt={AUTH} navigate={navigate} />);
    expect(screen.getByText('Connect Okta MCP')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('serverId')).toBe('okta');
  });

  test('shows Connected after the redirect back, once, and cleans the URL', () => {
    window.history.replaceState(null, '', '/chat/app-1?mcp_connected=okta&keep=1');
    render(<McpConnectCards prompts={[AUTH]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Okta MCP is connected');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(window.location.search).toBe('?keep=1');
    // Read once per page load: the result does not come back from the cleaned URL.
    expect(consumeMcpConnectResult()).toMatchObject({ connected: 'okta' });
  });

  test('shows a failure returned for this server', () => {
    window.history.replaceState(null, '', '/chat/app-1?mcp_error=exchange_failed&mcp_server=okta');
    render(<McpConnectCard prompt={AUTH} navigate={jest.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('did not succeed');
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();
  });

  test('a stored card of a server the user has connected since shows it as connected', async () => {
    mockConnectionStates.value = new Map([['okta', true]]);
    render(<McpConnectCards prompts={[AUTH]} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Okta MCP is connected');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('a cached "connected" does not outlive a later disconnect', async () => {
    window.history.replaceState(null, '', '/chat/app-1?mcp_connected=okta');
    mockConnectionStates.value = new Map([['okta', false]]);
    render(<McpConnectCard prompt={AUTH} navigate={jest.fn()} />);
    expect(await screen.findByRole('button', { name: /Connect/ })).toBeInTheDocument();
  });

  test('the result applies to the page it returned to only, and the router is told', () => {
    const onPop = jest.fn();
    window.addEventListener('popstate', onPop);
    window.history.replaceState(null, '', '/chat/app-1?mcp_error=exchange_failed&mcp_server=okta');
    expect(consumeMcpConnectResult()).toMatchObject({ error: 'exchange_failed' });
    // The router re-reads the cleaned URL, so it cannot write the parameters back.
    expect(onPop).toHaveBeenCalledTimes(1);
    window.removeEventListener('popstate', onPop);
    // An in-app navigation to another chat: the old result does not apply there.
    window.history.pushState(null, '', '/chat/app-2');
    expect(consumeMcpConnectResult()).toMatchObject({ connected: null, error: null });
  });

  test('a read-only chat shows the notice without a button', () => {
    render(<McpConnectCards prompts={[AUTH]} readOnly />);
    expect(screen.getByText('Connect Okta MCP')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
