import { describe, it, expect } from '@jest/globals';
import {
  MCP_APP_MIME_TYPE,
  MCP_UI_EXTENSION,
  MAX_VIEW_PAYLOAD_BYTES,
  boundStoredViews,
  buildAllowAttribute,
  buildClientCapabilities,
  buildSandboxCsp,
  buildViewDescriptor,
  extractUiResource,
  isAppOnly,
  isModelVisible,
  normalizePermissions,
  readToolUiMeta,
  sanitizeCspDomains,
  toViewToolResult
} from '../../services/mcp/mcpApps.js';

/**
 * MCP Apps (SEP-1865) host rules that live on the server: capability
 * negotiation, tool `_meta.ui`, UI resource validation, the sandbox CSP and
 * the view payload handed to the browser.
 */

describe('buildClientCapabilities', () => {
  it('advertises the UI extension with the MCP App MIME type when enabled', () => {
    expect(buildClientCapabilities(true)).toEqual({
      extensions: { [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
    });
  });

  it('advertises nothing when disabled, so servers fall back to text', () => {
    expect(buildClientCapabilities(false)).toEqual({});
  });
});

describe('readToolUiMeta', () => {
  it('reads the nested resource URI and defaults visibility to model + app', () => {
    expect(readToolUiMeta({ _meta: { ui: { resourceUri: 'ui://x/app.html' } } })).toEqual({
      resourceUri: 'ui://x/app.html',
      visibility: ['model', 'app']
    });
  });

  it('accepts the deprecated flat key', () => {
    expect(readToolUiMeta({ _meta: { 'ui/resourceUri': 'ui://x/a' } })?.resourceUri).toBe(
      'ui://x/a'
    );
  });

  it('reads an app-only visibility', () => {
    const ui = readToolUiMeta({ _meta: { ui: { visibility: ['app'] } } });
    expect(ui).toEqual({ resourceUri: null, visibility: ['app'] });
    expect(isModelVisible(ui)).toBe(false);
    expect(isAppOnly(ui)).toBe(true);
  });

  it('ignores non-ui:// URIs and unknown visibility values', () => {
    expect(readToolUiMeta({ _meta: { ui: { resourceUri: 'https://evil.example' } } })).toBeNull();
    expect(readToolUiMeta({ _meta: { ui: { visibility: ['nobody'] } } })).toBeNull();
  });

  it('returns null for an ordinary tool', () => {
    expect(readToolUiMeta({ name: 't' })).toBeNull();
    expect(isModelVisible(null)).toBe(true);
    expect(isAppOnly(null)).toBe(false);
  });
});

describe('sanitizeCspDomains', () => {
  it('keeps origins and wildcard subdomains', () => {
    expect(
      sanitizeCspDomains([
        'https://cdn.example.com',
        'https://*.example.com',
        'wss://rt.example:8443'
      ])
    ).toEqual(['https://cdn.example.com', 'https://*.example.com', 'wss://rt.example:8443']);
  });

  it('drops entries that could inject directives, keywords or blanket sources', () => {
    expect(
      sanitizeCspDomains([
        "https://a.example; script-src 'unsafe-eval'",
        "'unsafe-eval'",
        'https://a.example https://b.example',
        '*',
        'https:',
        'data:',
        'javascript:alert(1)',
        42,
        null
      ])
    ).toEqual([]);
  });
});

describe('buildSandboxCsp', () => {
  it('defaults to no network, no frames and no external resources', () => {
    const csp = buildSandboxCsp({});
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("never grants 'self' to the view: the sandbox page is served from iHub's own origin", () => {
    const directives = buildSandboxCsp({ connectDomains: ['https://api.example'] }).split('; ');
    for (const directive of directives.filter(d => !d.startsWith('frame-ancestors'))) {
      expect(directive).not.toContain("'self'");
    }
  });

  it('adds only the declared, sanitized domains', () => {
    const csp = buildSandboxCsp({
      connectDomains: ['https://api.example', "x; script-src 'unsafe-eval'"],
      resourceDomains: ['https://cdn.example'],
      frameDomains: ['https://www.youtube.com'],
      baseUriDomains: ['https://cdn.example']
    });
    expect(csp).toContain('connect-src https://api.example;');
    expect(csp).toContain(
      "script-src 'unsafe-inline' 'unsafe-eval' blob: data: https://cdn.example;"
    );
    expect(csp).toContain('img-src data: blob: https://cdn.example;');
    expect(csp).toContain('frame-src https://www.youtube.com;');
    expect(csp).toContain('base-uri https://cdn.example;');
    expect(csp.match(/unsafe-eval/g)).toHaveLength(1);
  });
});

describe('permissions', () => {
  it('keeps only the known features and maps them to an allow attribute', () => {
    const permissions = normalizePermissions({ camera: {}, clipboardWrite: {}, usb: {} });
    expect(permissions).toEqual({ camera: {}, clipboardWrite: {} });
    expect(buildAllowAttribute(permissions)).toBe('camera; clipboard-write');
    expect(buildAllowAttribute({})).toBe('');
  });
});

describe('extractUiResource', () => {
  const uri = 'ui://demo/app.html';

  it('returns the HTML with normalized metadata', () => {
    const resource = extractUiResource(
      {
        contents: [
          {
            uri,
            mimeType: 'text/html;profile=mcp-app',
            text: '<!doctype html><p>hi</p>',
            _meta: {
              ui: {
                csp: { resourceDomains: ['https://esm.sh', "'unsafe-eval'"] },
                permissions: { clipboardWrite: {} },
                prefersBorder: true
              }
            }
          }
        ]
      },
      uri
    );
    expect(resource.html).toBe('<!doctype html><p>hi</p>');
    expect(resource.csp.resourceDomains).toEqual(['https://esm.sh']);
    expect(resource.permissions).toEqual({ clipboardWrite: {} });
    expect(resource.prefersBorder).toBe(true);
  });

  it('decodes a base64 blob', () => {
    const blob = Buffer.from('<html>b</html>').toString('base64');
    expect(
      extractUiResource({ contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, blob }] }, uri).html
    ).toBe('<html>b</html>');
  });

  it('rejects other MIME types and empty contents', () => {
    expect(() =>
      extractUiResource({ contents: [{ uri, mimeType: 'text/html', text: '<p/>' }] }, uri)
    ).toThrow(/MIME type/);
    expect(() => extractUiResource({ contents: [] }, uri)).toThrow(/no contents/);
    expect(() =>
      extractUiResource({ contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: '  ' }] }, uri)
    ).toThrow(/empty/);
  });
});

describe('view payload', () => {
  const mcp = { serverId: 's', originalName: 'draw', ui: { resourceUri: 'ui://s/a' } };

  it('passes only standard CallToolResult fields to the browser', () => {
    expect(
      toViewToolResult({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { a: 1 },
        _meta: { m: 1 },
        isError: false,
        internal: 'secret'
      })
    ).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { a: 1 },
      _meta: { m: 1 }
    });
  });

  it('describes a view with its input and result', () => {
    const view = buildViewDescriptor({
      callId: 'c1',
      toolId: 's__draw',
      mcp,
      args: { q: 1 },
      toolResult: { content: [] }
    });
    expect(view).toEqual({
      callId: 'c1',
      toolId: 's__draw',
      serverId: 's',
      toolName: 'draw',
      resourceUri: 'ui://s/a',
      args: { q: 1 },
      toolResult: { content: [] }
    });
  });

  it('omits a payload too large to ship', () => {
    const view = buildViewDescriptor({
      callId: 'c1',
      toolId: 's__draw',
      mcp,
      args: { big: 'x'.repeat(MAX_VIEW_PAYLOAD_BYTES + 1) }
    });
    expect(view.payloadOmitted).toBe(true);
    expect(view.args).toBeUndefined();
  });

  it('bounds the views stored with one answer, keeping their references', () => {
    const views = [
      { callId: 'a', args: { x: 'a'.repeat(60) } },
      { callId: 'b', args: { x: 'b'.repeat(60) } }
    ];
    const bounded = boundStoredViews(views, 100);
    expect(bounded[0]).toEqual(views[0]);
    expect(bounded[1]).toEqual({ callId: 'b', payloadOmitted: true });
  });
});
