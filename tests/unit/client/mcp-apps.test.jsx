/**
 * MCP Apps host in the chat (SEP-1865): the JSON-RPC bridge, the projection
 * of tool frames onto `message.mcpApps`, the model-context store, stored
 * messages, and the sandbox the view renders in.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  McpAppHostBridge,
  RPC_ERRORS,
  RpcError,
  isOpenableUrl,
  messageTextFromParams
} from '../../../client/src/features/chat/mcpApps/McpAppHostBridge';
import {
  buildMcpAppViews,
  normalizeMcpAppViews
} from '../../../client/src/features/chat/mcpApps/mcpAppViewList';
import {
  clearMcpAppModelContext,
  setMcpAppModelContext,
  takeMcpAppModelContext
} from '../../../client/src/features/chat/mcpApps/modelContextStore';
import {
  createStreamState,
  reduceRunEvents,
  getRun
} from '../../../client/src/shared/run/runReducer';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';
import McpAppViews from '../../../client/src/features/chat/mcpApps/McpAppViews';

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

jest.mock('../../../client/src/api/endpoints/mcpApps', () => ({
  fetchMcpAppResource: jest.fn(async () => ({
    uri: 'ui://demo/app.html',
    html: '<p>view</p>',
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    permissions: { clipboardWrite: {} },
    allow: 'clipboard-write',
    prefersBorder: true,
    tool: { name: 'show', inputSchema: { type: 'object' } },
    serverId: 'demo'
  })),
  callMcpAppTool: jest.fn(),
  readMcpAppResource: jest.fn(),
  reportMcpAppHandshake: jest.fn(async () => {}),
  buildMcpAppSandboxUrl: csp =>
    `/api/mcp-apps/sandbox?csp=${encodeURIComponent(JSON.stringify(csp))}`
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('McpAppHostBridge', () => {
  function bridgeWith(options = {}) {
    const sent = [];
    const bridge = new McpAppHostBridge({ post: m => sent.push(m), ...options });
    return { bridge, sent };
  }

  test('answers a request with its handler result', async () => {
    const { bridge, sent } = bridgeWith({ requests: { ping: () => ({ pong: true }) } });
    bridge.handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} });
    await flush();
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 7, result: { pong: true } }]);
  });

  test('answers unknown methods and failing handlers with JSON-RPC errors', async () => {
    const { bridge, sent } = bridgeWith({
      requests: {
        fail: () => {
          throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'nope');
        }
      }
    });
    bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'unknown/method' });
    bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'fail' });
    await flush();
    expect(sent[0]).toMatchObject({ id: 1, error: { code: RPC_ERRORS.METHOD_NOT_FOUND } });
    expect(sent[1]).toMatchObject({
      id: 2,
      error: { code: RPC_ERRORS.INVALID_PARAMS, message: 'nope' }
    });
  });

  test('dispatches notifications and ignores anything that is not JSON-RPC 2.0', () => {
    const onSize = jest.fn();
    const { bridge, sent } = bridgeWith({
      notifications: { 'ui/notifications/size-changed': onSize }
    });
    bridge.handleMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { height: 300 }
    });
    bridge.handleMessage({ method: 'ui/notifications/size-changed' });
    bridge.handleMessage('hello');
    expect(onSize).toHaveBeenCalledTimes(1);
    expect(onSize).toHaveBeenCalledWith({ height: 300 });
    expect(sent).toEqual([]);
  });

  test('hands legacy mcp-ui messages to their handler and ignores the rest', () => {
    const onReady = jest.fn();
    const { bridge, sent } = bridgeWith({ legacy: { appReady: onReady } });
    bridge.handleMessage({ type: 'appReady', name: 'Google Maps' });
    bridge.handleMessage({ type: 'somethingElse' });
    bridge.handleMessage({ appReady: true });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({ type: 'appReady', name: 'Google Maps' });
    expect(sent).toEqual([]);
  });

  test('a legacy message with a failing handler does not break the bridge', async () => {
    const { bridge, sent } = bridgeWith({
      requests: { ping: () => ({}) },
      legacy: {
        appReady: () => {
          throw new Error('boom');
        }
      }
    });
    bridge.handleMessage({ type: 'appReady' });
    bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await flush();
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  test('resolves host requests with the view response', async () => {
    const { bridge, sent } = bridgeWith();
    const pending = bridge.request('ui/resource-teardown', { reason: 'x' });
    expect(sent[0]).toMatchObject({ method: 'ui/resource-teardown', params: { reason: 'x' } });
    bridge.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: {} });
    await expect(pending).resolves.toEqual({});
  });

  test('rate-limits a view that floods requests', async () => {
    let now = 0;
    const { bridge, sent } = bridgeWith({ requests: { ping: () => ({}) }, now: () => now });
    for (let i = 0; i < 40; i++) bridge.handleMessage({ jsonrpc: '2.0', id: i, method: 'ping' });
    await flush();
    const limited = sent.filter(m => m.error?.message === 'Rate limit exceeded');
    expect(limited.length).toBeGreaterThan(0);
    now += 5000;
    bridge.handleMessage({ jsonrpc: '2.0', id: 'later', method: 'ping' });
    await flush();
    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 'later', result: {} });
  });

  test('stops answering once closed', async () => {
    const { bridge, sent } = bridgeWith({ requests: { ping: () => ({}) } });
    bridge.close();
    bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await flush();
    expect(sent).toEqual([]);
  });
});

describe('ui/message and ui/open-link helpers', () => {
  test('extracts text from a single block or an array of blocks', () => {
    expect(messageTextFromParams({ role: 'user', content: { type: 'text', text: 'hi' } })).toBe(
      'hi'
    );
    expect(
      messageTextFromParams({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'b' }
        ]
      })
    ).toBe('a\nb');
    expect(messageTextFromParams({})).toBe('');
  });

  test('opens only absolute http(s) links', () => {
    expect(isOpenableUrl('https://app.diagrams.net/#create')).toBe(true);
    expect(isOpenableUrl('http://example.com')).toBe(true);
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableUrl('data:text/html,<script>')).toBe(false);
    expect(isOpenableUrl('/relative')).toBe(false);
  });
});

describe('message.mcpApps', () => {
  const ts = seq => `2026-09-24T10:00:${String(seq).padStart(2, '0')}.000Z`;
  const env = (seq, type, data = {}) => ({ v: 2, seq, runId: 'run-1', ts: ts(seq), type, data });
  const ref = {
    serverId: 'drawio',
    toolName: 'create_diagram',
    resourceUri: 'ui://drawio/mcp-app.html'
  };
  const started = env(1, 'run/started', {
    kind: 'chat',
    refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
  });
  const toolStarted = env(2, 'tool/started', {
    step: 1,
    callId: 'c1',
    toolId: 'drawio__create_diagram',
    name: 'drawio__create_diagram',
    args: { mermaid: 'A-->B' },
    execution: 'server',
    mcpApp: ref
  });
  const toolCompleted = env(3, 'tool/completed', {
    step: 1,
    callId: 'c1',
    toolId: 'drawio__create_diagram',
    name: 'drawio__create_diagram',
    resultPreview: 'ok',
    mcpApp: {
      callId: 'c1',
      toolId: 'drawio__create_diagram',
      ...ref,
      args: { mermaid: 'A-->B' },
      toolResult: { content: [{ type: 'text', text: 'ok' }], structuredContent: { xml: '<x/>' } }
    }
  });
  const runFrom = envelopes =>
    getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');

  test('a running tool shows its view with the input only', () => {
    expect(buildMcpAppViews(runFrom([started, toolStarted]))).toEqual([
      {
        callId: 'c1',
        toolId: 'drawio__create_diagram',
        ...ref,
        args: { mermaid: 'A-->B' },
        status: 'running'
      }
    ]);
  });

  test('a finished tool carries the full result onto the message', () => {
    const { extras } = projectRunToMessage(runFrom([started, toolStarted, toolCompleted]));
    expect(extras.mcpApps).toHaveLength(1);
    expect(extras.mcpApps[0]).toMatchObject({
      status: 'completed',
      toolResult: { structuredContent: { xml: '<x/>' } }
    });
  });

  test('turns without views carry no mcpApps', () => {
    const { extras } = projectRunToMessage(runFrom([started]));
    expect(extras.mcpApps).toBeUndefined();
  });

  test('a stored answer brings its views back', () => {
    const view = { callId: 'c1', toolId: 't', resourceUri: 'ui://a', args: {} };
    expect(
      transformStoredMessage({ id: 'm1', role: 'assistant', content: 'x', mcpApps: [view] }).mcpApps
    ).toEqual([view]);
    expect(normalizeMcpAppViews([view, { callId: 1 }, null])).toEqual([
      { ...view, status: 'completed' }
    ]);
  });
});

describe('model context store', () => {
  test('keeps the latest update per view and hands them over once, newest first', () => {
    setMcpAppModelContext('chat-x', 'c1', 'tool_a', { content: [{ type: 'text', text: 'old' }] });
    setMcpAppModelContext('chat-x', 'c1', 'tool_a', { content: [{ type: 'text', text: 'new' }] });
    setMcpAppModelContext('chat-x', 'c2', 'tool_b', { structuredContent: { n: 1 } });
    const taken = takeMcpAppModelContext('chat-x');
    expect(taken).toHaveLength(2);
    expect(taken.find(c => c.toolId === 'tool_a').content[0].text).toBe('new');
    expect(takeMcpAppModelContext('chat-x')).toEqual([]);
  });

  test('an empty update removes the view, clear drops the chat', () => {
    setMcpAppModelContext('chat-y', 'c1', 't', { content: [{ type: 'text', text: 'x' }] });
    setMcpAppModelContext('chat-y', 'c1', 't', {});
    expect(takeMcpAppModelContext('chat-y')).toEqual([]);
    setMcpAppModelContext('chat-y', 'c1', 't', { content: [{ type: 'text', text: 'x' }] });
    clearMcpAppModelContext('chat-y');
    expect(takeMcpAppModelContext('chat-y')).toEqual([]);
  });
});

describe('McpAppViews', () => {
  const view = {
    callId: 'c1',
    toolId: 'demo__show',
    serverId: 'demo',
    toolName: 'show',
    resourceUri: 'ui://demo/app.html',
    args: {},
    toolResult: { content: [] }
  };

  test('a shared, read-only chat shows where the view was without loading it', () => {
    const { container } = render(
      <McpAppViews views={[view]} appId="app-1" chatId="chat-1" readOnly />
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/open the chat to use it/)).toBeInTheDocument();
  });

  test('renders the view in an opaque-origin sandbox (never allow-same-origin)', async () => {
    const { container } = render(<McpAppViews views={[view]} appId="app-1" chatId="chat-1" />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('src')).toMatch(/^\/api\/mcp-apps\/sandbox\?csp=/);
    expect(iframe.getAttribute('allow')).toBe('clipboard-write');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  test('a view whose payload was dropped explains why it cannot be shown', () => {
    const { container } = render(
      <McpAppViews
        views={[{ ...view, args: undefined, toolResult: undefined, payloadOmitted: true }]}
        appId="app-1"
        chatId="chat-1"
      />
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/too large to keep/)).toBeInTheDocument();
  });
});

describe('McpAppView handshake', () => {
  const { reportMcpAppHandshake } = jest.requireMock('../../../client/src/api/endpoints/mcpApps');
  const view = {
    callId: 'c2',
    toolId: 'demo__show',
    serverId: 'demo',
    toolName: 'show',
    resourceUri: 'ui://demo/app.html',
    args: { q: 'berlin' },
    toolResult: {
      content: [{ type: 'text', text: '{}' }],
      _meta: { 'mcpui.dev/ui-initial-render-data': { center: [52.5, 13.4] } }
    }
  };

  /** Mount a view and wire a fake iframe window: what the view posts, what the host posts. */
  async function mountView() {
    const { container, unmount } = render(
      <McpAppViews views={[view]} appId="app-1" chatId="chat-1" />
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe');
    const posted = [];
    // The component addresses the view through its iframe's window.
    iframe.contentWindow.postMessage = message => posted.push(message);
    const fromView = data => {
      window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
    };
    // The sandbox proxy announces itself first; the host then hands over the resource.
    fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} });
    await flush();
    expect(posted.at(-1)).toMatchObject({ method: 'ui/notifications/sandbox-resource-ready' });
    posted.length = 0;
    return { posted, fromView, unmount };
  }

  const methods = posted => posted.map(m => m.method);

  beforeEach(() => {
    reportMcpAppHandshake.mockClear();
  });

  test('a spec-compliant view gets its data only after ui/notifications/initialized', async () => {
    const { posted, fromView, unmount } = await mountView();
    fromView({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    await flush();
    expect(posted[0]).toMatchObject({ id: 1, result: { protocolVersion: expect.any(String) } });
    expect(methods(posted)).not.toContain('ui/notifications/tool-result');
    fromView({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await flush();
    expect(methods(posted)).toEqual(
      expect.arrayContaining(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
    );
    expect(reportMcpAppHandshake).not.toHaveBeenCalled();
    unmount();
  });

  test('a legacy mcp-ui view is initialized by appReady and gets input and result once', async () => {
    const { posted, fromView, unmount } = await mountView();
    fromView({ type: 'appReady', name: 'Google Maps' });
    await flush();
    const input = posted.find(m => m.method === 'ui/notifications/tool-input');
    const result = posted.find(m => m.method === 'ui/notifications/tool-result');
    expect(input.params).toEqual({ arguments: { q: 'berlin' } });
    // The full CallToolResult including `_meta` — where mcp-ui views read their render data.
    expect(result.params._meta['mcpui.dev/ui-initial-render-data']).toEqual({
      center: [52.5, 13.4]
    });
    expect(reportMcpAppHandshake).toHaveBeenCalledWith({
      appId: 'app-1',
      toolId: 'demo__show',
      handshake: 'legacy'
    });

    // Neither a second appReady nor a late spec handshake delivers anything twice.
    fromView({ type: 'appReady', name: 'Google Maps' });
    fromView({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await flush();
    expect(methods(posted).filter(m => m === 'ui/notifications/tool-input')).toHaveLength(1);
    expect(methods(posted).filter(m => m === 'ui/notifications/tool-result')).toHaveLength(1);
    unmount();
  });

  test('appReady from a view that already started ui/initialize does not short-circuit the handshake', async () => {
    const { posted, fromView, unmount } = await mountView();
    fromView({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    await flush();
    fromView({ type: 'appReady', name: 'Hybrid' });
    await flush();
    expect(methods(posted)).not.toContain('ui/notifications/tool-result');
    expect(reportMcpAppHandshake).not.toHaveBeenCalled();
    fromView({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await flush();
    expect(methods(posted).filter(m => m === 'ui/notifications/tool-result')).toHaveLength(1);
    unmount();
  });
});
