/**
 * MCP App views whose tool result embeds the view's own `ui://` resource with
 * the call's data baked into the HTML — the Langdock cookbook ServiceNow
 * `render_ticket` shape. The embedded copy is rendered only for the tool's
 * declared resource URI; everything else keeps the `resources/read` copy.
 */
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import McpAppViews from '../../../client/src/features/chat/mcpApps/McpAppViews';
import {
  MAX_VIEW_HTML_BYTES,
  embeddedViewHtml,
  isViewHtmlMimeType,
  selectViewHtml
} from '../../../client/src/features/chat/mcpApps/embeddedViewHtml';

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

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

jest.mock('../../../client/src/api/endpoints/mcpApps', () => ({
  fetchMcpAppResource: jest.fn(async () => ({
    uri: 'ui://servicenow/ticket.html',
    html: '<p>static ticket view</p>',
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    permissions: { clipboardWrite: {} },
    allow: 'clipboard-write',
    prefersBorder: true,
    tool: { name: 'render_ticket', inputSchema: { type: 'object' } },
    serverId: 'servicenow'
  })),
  callMcpAppTool: jest.fn(),
  readMcpAppResource: jest.fn(),
  reportMcpAppHandshake: jest.fn(async () => {}),
  buildMcpAppSandboxUrl: csp =>
    `/api/mcp-apps/sandbox?csp=${encodeURIComponent(JSON.stringify(csp))}`
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const declaredUri = 'ui://servicenow/ticket.html';
const staticHtml = '<p>static ticket view</p>';
const ticketHtml =
  '<html><head><script>window.TICKET_DATA = {"table":"incident","number":"INC0010023"};</script></head><body></body></html>';

/** The CallToolResult `render_ticket` returns: a text line plus the page with its data baked in. */
const renderTicketResult = (resourceOverrides = {}) => ({
  content: [
    { type: 'text', text: 'Opened INC0010023 from incident.' },
    {
      type: 'resource',
      resource: {
        uri: declaredUri,
        mimeType: 'text/html;profile=mcp-app',
        text: ticketHtml,
        ...resourceOverrides
      }
    }
  ]
});

describe('embeddedViewHtml / selectViewHtml', () => {
  const resource = { uri: declaredUri, html: staticHtml };

  test('uses the embedded copy of the declared resource', () => {
    expect(embeddedViewHtml(renderTicketResult(), declaredUri)).toBe(ticketHtml);
    expect(
      selectViewHtml(resource, { resourceUri: declaredUri, toolResult: renderTicketResult() })
    ).toEqual({ html: ticketHtml, source: 'embedded' });
  });

  test('accepts text/html and the mcp-app profile, nothing else', () => {
    expect(isViewHtmlMimeType('text/html')).toBe(true);
    expect(isViewHtmlMimeType('text/html;profile=mcp-app')).toBe(true);
    expect(isViewHtmlMimeType('Text/HTML; charset=utf-8; profile="mcp-app"')).toBe(true);
    expect(isViewHtmlMimeType('text/html+skybridge')).toBe(false);
    expect(isViewHtmlMimeType('text/html;profile=other')).toBe(false);
    expect(isViewHtmlMimeType('text/plain')).toBe(false);
    expect(isViewHtmlMimeType(undefined)).toBe(false);
    expect(
      embeddedViewHtml(renderTicketResult({ mimeType: 'text/plain' }), declaredUri)
    ).toBeNull();
  });

  test('a different URI keeps the resources/read copy', () => {
    const other = renderTicketResult({ uri: 'ui://servicenow/other.html' });
    expect(embeddedViewHtml(other, declaredUri)).toBeNull();
    expect(selectViewHtml(resource, { resourceUri: declaredUri, toolResult: other })).toEqual({
      html: staticHtml,
      source: 'resource'
    });
  });

  test('no declared resource URI (or a non-ui:// one) never uses embedded HTML', () => {
    expect(embeddedViewHtml(renderTicketResult(), undefined)).toBeNull();
    expect(selectViewHtml(resource, { toolResult: renderTicketResult() })).toEqual({
      html: staticHtml,
      source: 'resource'
    });
    expect(
      embeddedViewHtml(
        renderTicketResult({ uri: 'https://example.com/x' }),
        'https://example.com/x'
      )
    ).toBeNull();
  });

  test('a view whose URI no longer matches the loaded resource keeps the resources/read copy', () => {
    expect(
      selectViewHtml(
        { uri: 'ui://servicenow/ticket-v2.html', html: '<p>v2</p>' },
        { resourceUri: declaredUri, toolResult: renderTicketResult() }
      )
    ).toEqual({ html: '<p>v2</p>', source: 'resource' });
  });

  test('blob-only, empty and oversized embedded HTML fall back to resources/read', () => {
    expect(
      embeddedViewHtml(renderTicketResult({ text: undefined, blob: 'PGgxPg==' }), declaredUri)
    ).toBeNull();
    expect(embeddedViewHtml(renderTicketResult({ text: '   ' }), declaredUri)).toBeNull();
    // Same cap as the server's MAX_UI_RESOURCE_BYTES for resources/read HTML.
    expect(MAX_VIEW_HTML_BYTES).toBe(5 * 1024 * 1024);
    const tooLarge = 'x'.repeat(MAX_VIEW_HTML_BYTES + 1);
    expect(embeddedViewHtml(renderTicketResult({ text: tooLarge }), declaredUri)).toBeNull();
    expect(
      selectViewHtml(resource, {
        resourceUri: declaredUri,
        toolResult: renderTicketResult({ text: tooLarge })
      }).source
    ).toBe('resource');
  });

  test('identical embedded HTML counts as the resource copy, so the view is not reloaded', () => {
    expect(
      selectViewHtml(resource, {
        resourceUri: declaredUri,
        toolResult: renderTicketResult({ text: staticHtml })
      }).source
    ).toBe('resource');
    expect(selectViewHtml(null, { resourceUri: declaredUri })).toBeNull();
  });
});

describe('McpAppView with an embedded view resource', () => {
  const baseView = {
    callId: 'c-ticket',
    toolId: 'servicenow__render_ticket',
    serverId: 'servicenow',
    toolName: 'render_ticket',
    resourceUri: declaredUri,
    args: { id: 'INC0010023' }
  };

  /** Wire the current iframe's window and let the sandbox proxy announce itself. */
  async function proxyReady(container) {
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe');
    const posted = [];
    iframe.contentWindow.postMessage = message => posted.push(message);
    const fromView = data => {
      window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
    };
    fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} });
    await flush();
    return { iframe, posted, fromView };
  }

  const renderedHtml = posted =>
    posted.find(m => m.method === 'ui/notifications/sandbox-resource-ready')?.params.html;

  let infoSpy;
  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  test('renders the HTML embedded in a render_ticket result, in the same sandbox', async () => {
    const view = { ...baseView, toolResult: renderTicketResult() };
    const { container, unmount } = render(
      <McpAppViews views={[view]} appId="app-1" chatId="chat-1" />
    );
    const { iframe, posted, fromView } = await proxyReady(container);
    expect(renderedHtml(posted)).toBe(ticketHtml);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(iframe.getAttribute('src')).toMatch(/^\/api\/mcp-apps\/sandbox\?csp=/);
    expect(iframe.getAttribute('allow')).toBe('clipboard-write');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');

    // The ticket view speaks mcp-ui: appReady still delivers the tool data.
    fromView({ type: 'appReady', name: 'ServiceNow Ticket' });
    await flush();
    expect(posted.map(m => m.method)).toEqual(
      expect.arrayContaining(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
    );
    unmount();
  });

  test('an embedded resource with another URI renders the resources/read HTML', async () => {
    const view = {
      ...baseView,
      callId: 'c-other',
      toolResult: renderTicketResult({ uri: 'ui://servicenow/other.html' })
    };
    const { container, unmount } = render(
      <McpAppViews views={[view]} appId="app-1" chatId="chat-1" />
    );
    const { posted } = await proxyReady(container);
    expect(renderedHtml(posted)).toBe(staticHtml);
    unmount();
  });

  test('a result without an embedded resource renders the resources/read HTML', async () => {
    const view = {
      ...baseView,
      callId: 'c-plain',
      toolResult: { content: [{ type: 'text', text: 'Opened INC0010023.' }] }
    };
    const { container, unmount } = render(
      <McpAppViews views={[view]} appId="app-1" chatId="chat-1" />
    );
    const { posted } = await proxyReady(container);
    expect(renderedHtml(posted)).toBe(staticHtml);
    unmount();
  });

  test('a result that arrives after the view opened reloads the sandbox once with the embedded HTML', async () => {
    const running = { ...baseView, callId: 'c-late', status: 'running' };
    const { container, rerender, unmount } = render(
      <McpAppViews views={[running]} appId="app-1" chatId="chat-1" />
    );
    const first = await proxyReady(container);
    expect(renderedHtml(first.posted)).toBe(staticHtml);

    rerender(
      <McpAppViews
        views={[{ ...running, status: 'completed', toolResult: renderTicketResult() }]}
        appId="app-1"
        chatId="chat-1"
      />
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBe(first.iframe));
    const second = await proxyReady(container);
    expect(renderedHtml(second.posted)).toBe(ticketHtml);
    unmount();
  });
});
