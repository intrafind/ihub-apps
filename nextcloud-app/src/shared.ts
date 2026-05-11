// Shared URL/path validation helpers used by both the Files file action and
// the iframe host page. Same security posture as the legacy main.js: the
// iframe target is parsed by `new URL()` so `javascript:` / `data:` and
// opaque-host inputs cannot be smuggled into an `iframe.src` assignment.

// iHub cloudStorage provider ids are admin-controlled identifiers
// (e.g. `nextcloud-main`). Restrict to a safe alphanumeric + dash/underscore
// grammar so attacker-controlled values can't break out of the URL hash.
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,200}$/

export function safeBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  return u.origin
}

export function buildEmbedUrl(
  baseUrl: string,
  providerId: string,
  paths: string[],
): string | null {
  const origin = safeBaseUrl(baseUrl)
  if (!origin) return null
  if (!PROVIDER_ID_RE.test(providerId)) return null
  if (!Array.isArray(paths)) return null
  const safePaths: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return null
    if (p.indexOf('\0') !== -1) return null
    safePaths.push(p)
  }
  const hash = new URLSearchParams()
  hash.set('providerId', providerId)
  hash.set('paths', JSON.stringify(safePaths))
  return origin + '/nextcloud/taskpane.html#' + hash.toString()
}

export interface IhubConfig {
  baseUrl: string
  providerId: string
}
