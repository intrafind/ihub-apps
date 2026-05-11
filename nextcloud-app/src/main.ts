// Iframe host bootstrap for templates/main.php. Reads the iHub base URL
// and provider id from initial state (set by PageController) and mounts an
// iframe pointing at the iHub embed page. Forwards selection changes via
// postMessage to the iframe's origin (never `*`).

import { translate as t } from '@nextcloud/l10n'
import { loadState } from '@nextcloud/initial-state'
import { buildEmbedUrl, safeBaseUrl } from './shared'

const APP_ID = 'ihub_chat'

function parsePathsFromHash(): string[] | null {
  const raw = (window.location.hash || '').replace(/^#/, '')
  if (!raw) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return null
  }
  const json = params.get('paths')
  if (!json) return null
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return null
    return arr.filter((s): s is string => typeof s === 'string' && s.length > 0)
  } catch {
    return null
  }
}

function bootstrap() {
  const rootEl = document.getElementById('ihub-chat-root')
  if (!rootEl) return

  const baseUrl = String(loadState(APP_ID, 'baseUrl', '') || '').replace(/\/+$/, '')
  const providerId = String(loadState(APP_ID, 'providerId', 'nextcloud-main'))
  if (!baseUrl) {
    // The template already shows a config-missing message in this case.
    return
  }

  const initialPaths = parsePathsFromHash() || []
  const src = buildEmbedUrl(baseUrl, providerId, initialPaths)
  const targetOrigin = safeBaseUrl(baseUrl)
  if (!src || !targetOrigin) {
    rootEl.textContent = t(
      APP_ID,
      'iHub Chat could not load: the configured iHub base URL or provider id is invalid.',
    )
    return
  }

  const iframe = document.createElement('iframe')
  // Assigning `src` to a URL parsed by `new URL()` (via `safeBaseUrl`) is safe:
  // `javascript:` / `data:` / opaque-host inputs have already been rejected.
  iframe.src = src
  iframe.allow = 'clipboard-write'
  iframe.style.cssText =
    'border:0;width:100%;height:100vh;min-height:600px;background:#fff;'
  rootEl.appendChild(iframe)

  // Forward subsequent selection changes (when the user navigates Files in
  // another tab and this host stays open). We use the iframe's origin as
  // `targetOrigin`, never `*`.
  window.addEventListener('hashchange', () => {
    const paths = parsePathsFromHash()
    if (!paths) return
    iframe.contentWindow?.postMessage(
      { kind: 'ihub.nextcloud.selection', providerId, paths },
      targetOrigin,
    )
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap)
} else {
  bootstrap()
}
