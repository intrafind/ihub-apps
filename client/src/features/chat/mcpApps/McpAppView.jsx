import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  buildMcpAppSandboxUrl,
  callMcpAppTool,
  fetchMcpAppResource,
  readMcpAppResource,
  reportMcpAppHandshake
} from '../../../api/endpoints/mcpApps';
import {
  McpAppHostBridge,
  MCP_APPS_PROTOCOL_VERSION,
  RPC_ERRORS,
  RpcError,
  isOpenableUrl,
  messageTextFromParams
} from './McpAppHostBridge';
import {
  HOST_DISPLAY_MODES,
  buildHostContext,
  containerDimensions,
  currentTheme,
  hostStyles
} from './hostContext';
import { setMcpAppModelContext } from './modelContextStore';

/** Inline views grow with their content up to this height (px). */
const INLINE_MAX_HEIGHT = 720;
const INLINE_MIN_HEIGHT = 60;
const INITIAL_HEIGHT = 200;
/**
 * The chat bubble sizes to its content, so a percentage width would collapse
 * the view; a fixed preferred width capped at the bubble's makes the bubble
 * grow to fit a view and still fit narrow screens.
 */
const VIEW_WRAPPER_CLASS = 'my-2 w-[48rem] max-w-full';
/** Height of the bar above a fullscreen view. */
const FULLSCREEN_BAR_HEIGHT = 44;

/** A view's resource is fetched once per app + tool for this long. */
const RESOURCE_TTL_MS = 5 * 60 * 1000;
const resourceCache = new Map();

function loadResource(appId, toolId) {
  const key = `${appId}::${toolId}`;
  const cached = resourceCache.get(key);
  if (cached && Date.now() - cached.at < RESOURCE_TTL_MS) return cached.promise;
  const promise = fetchMcpAppResource(appId, toolId);
  resourceCache.set(key, { promise, at: Date.now() });
  promise.catch(() => resourceCache.delete(key));
  return promise;
}

function errorMessage(error) {
  return error?.response?.data?.error || error?.message || 'Request failed';
}

/**
 * The sandbox page must share iHub's origin: it takes the host's origin from
 * its own URL. When the API is served elsewhere (an API base override, e.g. a
 * browser extension) views cannot be hosted.
 */
function isSameOriginUrl(url) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * One MCP App view (SEP-1865) inside a chat answer.
 *
 * Renders the server's `ui://` HTML in a double-iframe sandbox — iHub's
 * sandbox page in an opaque-origin iframe, the view inside it — and acts as
 * the view's host: answers `ui/initialize` with theme, locale and layout,
 * delivers the tool input and result, proxies `tools/call` and
 * `resources/read` to the view's own MCP server, and handles links, follow-up
 * messages, model-context updates, size changes and fullscreen.
 *
 * Tool data is delivered once the view says it is ready. The specification's
 * way is the `ui/initialize` request followed by `ui/notifications/initialized`.
 * Views written against the older mcp-ui protocol never send those; they post
 * a plain `{ type: "appReady" }` instead and read the tool result's `_meta`
 * (`mcpui.dev/ui-initial-render-data`). Such a view is treated as initialized
 * when `appReady` arrives — unless it already started the `ui/initialize`
 * handshake, which then stays the only trigger — so the same tool input and
 * result reach it exactly once. The fallback is reported to the server so
 * admins can see which servers rely on it.
 *
 * @param {Object} props
 * @param {Object} props.view - View descriptor (see features/chat/mcpApps/mcpAppViewList)
 * @param {string} props.appId - iHub app of the chat
 * @param {string} props.chatId
 * @param {{sendMessage: (text: string) => void, isProcessing: boolean}|null} [props.host] -
 *   What the surrounding chat lets the view do beyond its iframe: `sendMessage`
 *   posts a user message (`ui/message`), `isProcessing` says a turn is running.
 *   Surfaces without a composer (shared chats, Office, compare mode) pass
 *   nothing and the view is told the feature is unavailable.
 */
function McpAppView({ view, appId, chatId, host = null }) {
  const { t, i18n } = useTranslation();
  const iframeRef = useRef(null);
  const containerRef = useRef(null);
  const bridgeRef = useRef(null);
  const [resource, setResource] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [displayMode, setDisplayMode] = useState('inline');

  // Latest values for the long-lived message handlers.
  const viewRef = useRef(view);
  viewRef.current = view;
  const hostRef = useRef(host);
  hostRef.current = host;
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const localeRef = useRef(i18n.language);
  localeRef.current = i18n.language;

  // Per-connection protocol state, reset whenever the bridge is rebuilt.
  const protocolRef = useRef(null);

  // A view keeps its app and tool for its whole life (it is keyed by its call
  // id), so the resource is loaded once per mount.
  useEffect(() => {
    let cancelled = false;
    loadResource(appId, view.toolId).then(
      data => {
        if (!cancelled) setResource(data);
      },
      error => {
        if (!cancelled) setLoadError(errorMessage(error));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [appId, view.toolId]);

  const sandboxUrl = useMemo(
    () => (resource ? buildMcpAppSandboxUrl(resource.csp) : null),
    [resource]
  );
  const sandboxUsable = !sandboxUrl || isSameOriginUrl(sandboxUrl);

  const dimensions = useCallback(() => {
    const width = containerRef.current?.clientWidth || 0;
    return displayModeRef.current === 'fullscreen'
      ? containerDimensions({
          displayMode: 'fullscreen',
          width: window.innerWidth,
          height: window.innerHeight - FULLSCREEN_BAR_HEIGHT
        })
      : containerDimensions({ displayMode: 'inline', width, maxHeight: INLINE_MAX_HEIGHT });
  }, []);

  /** Push a partial host context once the view is initialized. */
  const notifyContext = useCallback(partial => {
    const state = protocolRef.current;
    if (!state?.initialized) return;
    bridgeRef.current?.notify('ui/notifications/host-context-changed', partial);
  }, []);

  /**
   * Deliver whatever tool data the view has not seen yet: the input once, then
   * the result — or a cancellation when the call failed without one.
   */
  const flushToolData = useCallback(() => {
    const bridge = bridgeRef.current;
    const state = protocolRef.current;
    const current = viewRef.current;
    if (!bridge || !state?.initialized) return;
    if (!state.inputSent && current.args) {
      bridge.notify('ui/notifications/tool-input', { arguments: current.args });
      state.inputSent = true;
    }
    if (state.resultSent || state.cancelledSent) return;
    if (current.toolResult) {
      bridge.notify('ui/notifications/tool-result', current.toolResult);
      state.resultSent = true;
    } else if (current.cancelled || current.status === 'error') {
      bridge.notify('ui/notifications/tool-cancelled', {
        reason: current.cancelled ? 'Tool call failed' : 'Tool call ended with an error'
      });
      state.cancelledSent = true;
    }
  }, []);

  // The bridge lives as long as the resource (and so the iframe) does.
  useEffect(() => {
    if (!resource || !sandboxUsable) return undefined;
    const iframe = iframeRef.current;
    if (!iframe) return undefined;

    const state = {
      resourceSent: false,
      /** 'spec' once `ui/initialize` arrived, 'legacy' once `appReady` did; null before either. */
      handshake: null,
      initialized: false,
      inputSent: false,
      resultSent: false,
      cancelledSent: false,
      appModes: null
    };
    protocolRef.current = state;

    const toolRef = { appId, toolId: viewRef.current.toolId };
    const bridge = new McpAppHostBridge({
      // The sandbox runs in an opaque origin, so it cannot be addressed by
      // origin; the target is this specific iframe's window.
      post: message => iframe.contentWindow?.postMessage(message, '*'),
      requests: {
        'ui/initialize': params => {
          if (!state.handshake) state.handshake = 'spec';
          const modes = params?.appCapabilities?.availableDisplayModes;
          state.appModes = Array.isArray(modes) ? modes : null;
          return {
            protocolVersion: MCP_APPS_PROTOCOL_VERSION,
            hostInfo: { name: 'ihub-apps', version: '1.0.0' },
            hostCapabilities: {
              openLinks: {},
              serverTools: {},
              serverResources: {},
              logging: {},
              sandbox: { permissions: resource.permissions || {}, csp: resource.csp || {} }
            },
            hostContext: buildHostContext({
              callId: viewRef.current.callId,
              tool: resource.tool,
              locale: localeRef.current,
              displayMode: displayModeRef.current,
              dimensions: dimensions()
            })
          };
        },
        ping: () => ({}),
        'tools/call': async params => {
          if (typeof params.name !== 'string' || !params.name) {
            throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Missing tool name');
          }
          try {
            return await callMcpAppTool({ ...toolRef, name: params.name, args: params.arguments });
          } catch (error) {
            throw new RpcError(RPC_ERRORS.HOST, errorMessage(error));
          }
        },
        'resources/read': async params => {
          if (typeof params.uri !== 'string' || !params.uri) {
            throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Missing resource URI');
          }
          try {
            return await readMcpAppResource({ ...toolRef, uri: params.uri });
          } catch (error) {
            throw new RpcError(RPC_ERRORS.HOST, errorMessage(error));
          }
        },
        'ui/open-link': params => {
          if (!isOpenableUrl(params.url)) {
            throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Invalid URL');
          }
          window.open(params.url, '_blank', 'noopener,noreferrer');
          return {};
        },
        'ui/message': params => {
          const text = messageTextFromParams(params);
          if (!text) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Message has no text');
          const chat = hostRef.current;
          if (typeof chat?.sendMessage !== 'function') {
            throw new RpcError(RPC_ERRORS.HOST, 'Sending messages is not available here');
          }
          if (chat.isProcessing) {
            throw new RpcError(RPC_ERRORS.HOST, 'The chat is busy');
          }
          chat.sendMessage(text);
          return {};
        },
        'ui/update-model-context': params => {
          const current = viewRef.current;
          setMcpAppModelContext(chatId, current.callId, current.toolId, params);
          return {};
        },
        'ui/request-display-mode': params => {
          const mode = params.mode;
          const allowed =
            HOST_DISPLAY_MODES.includes(mode) && (!state.appModes || state.appModes.includes(mode));
          if (allowed) setDisplayMode(mode);
          return { mode: allowed ? mode : displayModeRef.current };
        }
      },
      notifications: {
        'ui/notifications/sandbox-proxy-ready': () => {
          if (state.resourceSent) return;
          state.resourceSent = true;
          bridge.notify('ui/notifications/sandbox-resource-ready', {
            html: resource.html,
            permissions: resource.permissions || {},
            title: viewRef.current.toolName
          });
        },
        'ui/notifications/initialized': () => {
          if (state.initialized) return;
          if (!state.handshake) state.handshake = 'spec';
          state.initialized = true;
          flushToolData();
        },
        'ui/notifications/size-changed': params => {
          const next = Number(params.height);
          if (!Number.isFinite(next)) return;
          setHeight(Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, Math.ceil(next))));
        },
        'notifications/message': params => {
          console.debug('[MCP App]', viewRef.current.toolName, params?.level, params?.data);
        }
      },
      legacy: {
        // mcp-ui's "I am ready" — the only handshake views written before MCP
        // Apps know. A view that already began `ui/initialize` is spec-driven
        // and is not initialized early by this.
        appReady: () => {
          if (state.initialized || state.handshake) return;
          state.handshake = 'legacy';
          state.initialized = true;
          const current = viewRef.current;
          console.info(
            '[MCP App]',
            current.toolName,
            'uses the legacy mcp-ui handshake (appReady); tool data delivered without ui/initialize'
          );
          reportMcpAppHandshake({ appId, toolId: current.toolId, handshake: 'legacy' }).catch(
            () => {}
          );
          flushToolData();
        }
      }
    });
    bridgeRef.current = bridge;

    const onMessage = event => {
      if (event.source !== iframe.contentWindow) return;
      bridge.handleMessage(event.data);
    };
    window.addEventListener('message', onMessage);

    return () => {
      window.removeEventListener('message', onMessage);
      // Best effort: the iframe goes away with this component, so there is no
      // waiting for the answer the specification lets the host wait for. A
      // legacy view does not know the request and would only let it time out.
      if (state.initialized && state.handshake === 'spec') {
        bridge.request('ui/resource-teardown', { reason: 'View closed' }).catch(() => {});
      }
      bridge.close();
      bridgeRef.current = null;
      protocolRef.current = null;
    };
  }, [resource, sandboxUsable, appId, chatId, dimensions, flushToolData]);

  // New tool data (the call finished while the view was open).
  useEffect(() => {
    flushToolData();
  }, [view.args, view.toolResult, view.cancelled, view.status, flushToolData]);

  // Theme follows iHub's dark-mode switch.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      notifyContext({ theme: currentTheme(), styles: hostStyles() });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class']
    });
    return () => observer.disconnect();
  }, [notifyContext]);

  useEffect(() => {
    notifyContext({ locale: i18n.language });
  }, [i18n.language, notifyContext]);

  // Width changes (window resize, sidebar) and display mode switches.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = 0;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      notifyContext({ containerDimensions: dimensions() });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resource, dimensions, notifyContext]);

  useEffect(() => {
    notifyContext({ displayMode, containerDimensions: dimensions() });
  }, [displayMode, dimensions, notifyContext]);

  useEffect(() => {
    if (displayMode !== 'fullscreen') return undefined;
    const onKey = event => {
      if (event.key === 'Escape') setDisplayMode('inline');
    };
    const onResize = () => notifyContext({ containerDimensions: dimensions() });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [displayMode, dimensions, notifyContext]);

  const name = view.toolName || view.toolId;
  const caption = (
    <div className="flex items-center gap-1.5 mb-1 text-xs text-gray-500 dark:text-gray-400">
      <Icon name="cube" size="sm" className="shrink-0" />
      <span className="truncate">
        {t('mcpApps.caption', 'Interactive view · {{name}}', { name })}
      </span>
      {view.status === 'running' && (
        <Icon name="spinner" size="sm" className="shrink-0 animate-spin" />
      )}
    </div>
  );

  const notice = (icon, text) => (
    <div className={VIEW_WRAPPER_CLASS}>
      {caption}
      <div className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2 text-sm text-gray-600 dark:text-gray-300">
        <Icon name={icon} size="sm" className="mt-0.5 shrink-0" />
        <span>{text}</span>
      </div>
    </div>
  );

  if (view.payloadOmitted) {
    return notice(
      'information-circle',
      t(
        'mcpApps.payloadOmitted',
        'This interactive view was too large to keep and cannot be shown again.'
      )
    );
  }
  if (loadError) {
    return notice(
      'warning',
      t('mcpApps.loadFailed', 'The interactive view could not be loaded: {{error}}', {
        error: loadError
      })
    );
  }
  if (!sandboxUsable) {
    return notice(
      'information-circle',
      t('mcpApps.unsupportedSurface', 'Interactive views are not available in this window.')
    );
  }
  if (!resource) {
    return (
      <div className={VIEW_WRAPPER_CLASS}>
        {caption}
        <div
          className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400"
          style={{ height: INITIAL_HEIGHT }}
        >
          <Icon name="spinner" size="sm" className="animate-spin" />
          <span>{t('mcpApps.loading', 'Loading interactive view…')}</span>
        </div>
      </div>
    );
  }

  const fullscreen = displayMode === 'fullscreen';
  const bordered = resource.prefersBorder !== false;
  return (
    <div className={VIEW_WRAPPER_CLASS}>
      {caption}
      <div
        ref={containerRef}
        className={
          fullscreen
            ? 'fixed inset-0 z-[100] flex flex-col bg-white dark:bg-gray-900'
            : `relative w-full overflow-hidden rounded-lg ${
                bordered
                  ? 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                  : ''
              }`
        }
        role={fullscreen ? 'dialog' : undefined}
        aria-modal={fullscreen ? 'true' : undefined}
        aria-label={fullscreen ? name : undefined}
      >
        {fullscreen && (
          <div
            className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-700 dark:text-gray-200"
            style={{ height: FULLSCREEN_BAR_HEIGHT }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name="cube" size="sm" className="shrink-0" />
              <span className="truncate">{name}</span>
            </span>
            <button
              type="button"
              onClick={() => setDisplayMode('inline')}
              className="rounded-sm p-1 hover:bg-gray-100 dark:hover:bg-gray-800"
              aria-label={t('mcpApps.exitFullscreen', 'Exit full screen')}
              title={t('mcpApps.exitFullscreen', 'Exit full screen')}
            >
              <Icon name="x-mark" size="md" />
            </button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={sandboxUrl}
          title={t('mcpApps.frameTitle', 'Interactive view: {{name}}', { name })}
          // No allow-same-origin: the sandbox and the view run in an opaque
          // origin and cannot reach iHub's DOM, cookies or storage.
          sandbox="allow-scripts allow-forms"
          allow={resource.allow || undefined}
          referrerPolicy="no-referrer"
          className="block w-full border-0 bg-transparent"
          style={fullscreen ? { flex: '1 1 auto', height: 'auto' } : { height }}
        />
      </div>
    </div>
  );
}

export default McpAppView;
