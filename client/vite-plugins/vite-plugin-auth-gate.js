import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vite plugin that implements a pre-auth gate for ihub-apps.
 *
 * In production builds:
 * - Extracts all Vite-generated <script type="module">, <link rel="modulepreload">,
 *   and <link rel="stylesheet" href="./assets/..."> tags from the output HTML
 * - Stores their paths in a JSON data element
 * - Inlines the auth gate JS + CSS so it runs before any React code
 * - Result: unauthenticated users never download the React bundle
 *
 * In development:
 * - No-op by default (preserves HMR)
 * - Set VITE_AUTH_GATE=true to test the gate in dev mode
 */
export default function authGatePlugin() {
  const isDevGateEnabled = process.env.VITE_AUTH_GATE === 'true';
  let isBuild = false;

  return {
    name: 'vite-plugin-auth-gate',

    config(_, { command }) {
      isBuild = command === 'build';
    },

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!isBuild && !isDevGateEnabled) {
          return html;
        }

        const gateSrcDir = resolve(__dirname, '../src/auth-gate');

        // Read gate source files
        const gateJS = readFileSync(resolve(gateSrcDir, 'auth-gate.js'), 'utf-8');
        const gateCSS = readFileSync(resolve(gateSrcDir, 'auth-gate.css'), 'utf-8');
        const gateI18n = readFileSync(resolve(gateSrcDir, 'i18n.js'), 'utf-8');

        if (isBuild) {
          return transformForBuild(html, gateJS, gateCSS, gateI18n);
        }

        // Dev mode with gate enabled
        return transformForDev(html, gateJS, gateCSS, gateI18n);
      }
    }
  };
}

/**
 * Production build: extract Vite assets, remove them from HTML, inject gate inline.
 */
function transformForBuild(html, gateJS, gateCSS, gateI18n) {
  // Extract <script type="module" ...> tags (Vite entry + chunks)
  const moduleScriptRegex = /<script\s+type="module"[^>]*\s+src="([^"]+)"[^>]*><\/script>/g;
  const moduleScripts = [];
  let match;
  while ((match = moduleScriptRegex.exec(html)) !== null) {
    moduleScripts.push(match[1]);
  }

  // Extract <link rel="modulepreload" ...> tags
  const preloadRegex = /<link\s+rel="modulepreload"[^>]*\s+href="([^"]+)"[^>]*\/?>/g;
  const preloads = [];
  while ((match = preloadRegex.exec(html)) !== null) {
    preloads.push(match[1]);
  }

  // Extract <link rel="stylesheet" href="./assets/..."> tags (Vite-generated CSS)
  const stylesheetRegex =
    /<link\s+rel="stylesheet"[^>]*\s+href="(\.[^"]*\/assets\/[^"]+\.css)"[^>]*\/?>/g;
  const stylesheets = [];
  while ((match = stylesheetRegex.exec(html)) !== null) {
    stylesheets.push(match[1]);
  }

  // Build asset data JSON
  const assetData = {
    scripts: moduleScripts,
    preloads: preloads,
    stylesheets: stylesheets
  };

  // Remove extracted tags from HTML
  let result = html;
  result = result.replace(moduleScriptRegex, '');
  result = result.replace(preloadRegex, '');
  result = result.replace(stylesheetRegex, '');

  // Clean up empty lines left behind
  result = result.replace(/^\s*\n/gm, '');

  // Inject gate CSS into <head>
  const gateCSSTag = `    <style id="auth-gate-styles">\n${gateCSS}\n    </style>`;
  result = result.replace('</head>', `${gateCSSTag}\n  </head>`);

  // Inject asset data and gate script after #auth-gate-root (or after #root if gate root doesn't exist)
  const assetDataTag = `    <script id="auth-gate-data" type="application/json">${JSON.stringify(assetData)}</script>`;

  // Combine i18n + gate JS into a single inline script
  const combinedJS = `// Auth Gate i18n\n${gateI18n}\n\n// Auth Gate\n${gateJS}`;
  const gateScriptTag = `    <script id="auth-gate-script">\n${combinedJS}\n    </script>`;

  // Insert after </div> of auth-gate-root, before #root
  if (result.includes('id="auth-gate-root"')) {
    result = result.replace(
      '<div id="root"></div>',
      `<div id="root"></div>\n${assetDataTag}\n${gateScriptTag}`
    );
  } else {
    // Fallback: add auth-gate-root and inject before root
    result = result.replace(
      '<div id="root"></div>',
      `<div id="auth-gate-root"></div>\n    <div id="root"></div>\n${assetDataTag}\n${gateScriptTag}`
    );
  }

  return result;
}

/**
 * Dev mode: inject gate that hides #root until auth, but doesn't remove module scripts.
 */
function transformForDev(html, gateJS, gateCSS, gateI18n) {
  // In dev mode, we set a flag so the gate knows not to inject scripts (they're already in HTML)
  const devFlag = 'window.__AUTH_GATE_DEV_MODE__ = true;';

  const gateCSSTag = `    <style id="auth-gate-styles">\n${gateCSS}\n    </style>`;
  const combinedJS = `${devFlag}\n\n// Auth Gate i18n\n${gateI18n}\n\n// Auth Gate\n${gateJS}`;
  const gateScriptTag = `    <script id="auth-gate-script">\n${combinedJS}\n    </script>`;

  let result = html;

  // Inject CSS into head
  result = result.replace('</head>', `${gateCSSTag}\n  </head>`);

  // Inject gate script (no asset data needed in dev - scripts are already in HTML)
  if (result.includes('id="auth-gate-root"')) {
    result = result.replace('<div id="root"></div>', `<div id="root"></div>\n${gateScriptTag}`);
  } else {
    result = result.replace(
      '<div id="root"></div>',
      `<div id="auth-gate-root"></div>\n    <div id="root"></div>\n${gateScriptTag}`
    );
  }

  return result;
}
