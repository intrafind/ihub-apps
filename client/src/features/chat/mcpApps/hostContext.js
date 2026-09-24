/**
 * `hostContext` for MCP App views: theme, styles, locale and layout, per the
 * MCP Apps specification (`McpUiHostContext`).
 *
 * @module features/chat/mcpApps/hostContext
 */

/** Display modes iHub offers. `pip` is not supported. */
export const HOST_DISPLAY_MODES = Object.freeze(['inline', 'fullscreen']);

/**
 * Standardised style variables, as `light-dark()` pairs so a view that sets
 * `color-scheme` from `theme` picks the right half. Values follow iHub's
 * Tailwind grays and blues.
 */
const STYLE_VARIABLES = Object.freeze({
  '--color-background-primary': 'light-dark(#ffffff, #1f2937)',
  '--color-background-secondary': 'light-dark(#f9fafb, #111827)',
  '--color-background-tertiary': 'light-dark(#f3f4f6, #374151)',
  '--color-background-inverse': 'light-dark(#111827, #f9fafb)',
  '--color-background-info': 'light-dark(#eff6ff, #1e3a8a)',
  '--color-background-danger': 'light-dark(#fef2f2, #7f1d1d)',
  '--color-background-success': 'light-dark(#f0fdf4, #14532d)',
  '--color-background-warning': 'light-dark(#fffbeb, #78350f)',
  '--color-text-primary': 'light-dark(#111827, #f3f4f6)',
  '--color-text-secondary': 'light-dark(#4b5563, #d1d5db)',
  '--color-text-tertiary': 'light-dark(#6b7280, #9ca3af)',
  '--color-text-inverse': 'light-dark(#f9fafb, #111827)',
  '--color-text-info': 'light-dark(#1d4ed8, #93c5fd)',
  '--color-text-danger': 'light-dark(#b91c1c, #fca5a5)',
  '--color-text-success': 'light-dark(#15803d, #86efac)',
  '--color-text-warning': 'light-dark(#b45309, #fcd34d)',
  '--color-border-primary': 'light-dark(#e5e7eb, #374151)',
  '--color-border-secondary': 'light-dark(#d1d5db, #4b5563)',
  '--color-ring-primary': 'light-dark(#3b82f6, #60a5fa)',
  '--border-radius-sm': '4px',
  '--border-radius-md': '6px',
  '--border-radius-lg': '8px',
  '--border-radius-full': '9999px'
});

/**
 * @returns {'light'|'dark'} iHub's current theme
 */
export function currentTheme() {
  const html = document.documentElement;
  return html.getAttribute('data-theme') === 'dark' || html.classList.contains('dark')
    ? 'dark'
    : 'light';
}

/**
 * @returns {Object} `styles` for the host context
 */
export function hostStyles() {
  const variables = { ...STYLE_VARIABLES };
  try {
    const font = window.getComputedStyle(document.body).fontFamily;
    if (font) variables['--font-sans'] = font;
  } catch {
    /* no computed style (tests) */
  }
  return { variables };
}

/**
 * @param {Object} options
 * @param {'inline'|'fullscreen'} options.displayMode
 * @param {number} options.width - Container width in px
 * @param {number} [options.height] - Fixed height (fullscreen)
 * @param {number} options.maxHeight - Inline height cap
 * @returns {Object} `containerDimensions`
 */
export function containerDimensions({ displayMode, width, height, maxHeight }) {
  const w = Math.max(0, Math.round(width || 0));
  if (displayMode === 'fullscreen' && height) {
    return { width: w, height: Math.max(0, Math.round(height)) };
  }
  return { width: w, maxHeight };
}

/**
 * The full host context sent in the `ui/initialize` response.
 *
 * @param {Object} options
 * @param {string} options.callId - Tool call id of the view
 * @param {Object} options.tool - `{ name, description, inputSchema }`
 * @param {string} options.locale - BCP 47 language
 * @param {'inline'|'fullscreen'} options.displayMode
 * @param {Object} options.dimensions - From `containerDimensions`
 * @returns {Object}
 */
export function buildHostContext({ callId, tool, locale, displayMode, dimensions }) {
  let timeZone;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const touch = typeof window !== 'undefined' && 'ontouchstart' in window;
  return {
    ...(tool ? { toolInfo: { id: callId, tool } } : {}),
    theme: currentTheme(),
    styles: hostStyles(),
    displayMode,
    availableDisplayModes: [...HOST_DISPLAY_MODES],
    containerDimensions: dimensions,
    locale: locale || 'en',
    ...(timeZone ? { timeZone } : {}),
    userAgent: 'ihub-apps',
    platform: 'web',
    deviceCapabilities: {
      touch,
      hover: typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)')?.matches
    }
  };
}
