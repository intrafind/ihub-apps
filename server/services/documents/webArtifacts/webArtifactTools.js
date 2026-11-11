// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { optionalString, toolFailure } from '../documentToolHelpers.js';
import { GeneratedFileError, holdGeneratedFile, safeFileName } from '../generatedFiles.js';
import { templateBundleFor } from '../templates/applyTemplate.js';
import { DASHBOARD_PRESET, renderDashboard } from './dashboardPreset.js';

/**
 * The tool the `web-artifacts` system skill brings (see
 * `server/systemSkills/web-artifacts`): `create_web_artifact` validates and
 * packages a self-contained `.html` micro-app or `.svg` vector graphic,
 * injects corporate brand CSS tokens (`--brand-primary`, `--brand-accent`,
 * `--brand-font`) when a document template or brand colour is configured, and
 * hands the file to the chat as a live-previewable artifact.
 *
 * Security invariant: on the wire, `.html` and `.svg` artifacts are stored
 * under `mimeType: 'text/plain'` (`kind: 'code'`) so the server never serves
 * active `text/html` or `image/svg+xml` from a same-origin URL. The client's
 * `ArtifactPreview` renders `.html` inside `<iframe sandbox="allow-scripts"
 * referrerPolicy="no-referrer" srcDoc={…} />` and `.svg` via DOMPurify.
 */

const RELATIVE_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](?!https?:\/\/|data:)([^"']+)["']/i;
const RELATIVE_LINK_RE =
  /<link\b[^>]*\bhref\s*=\s*["'](?!https?:\/\/|data:)([^"']+\.css[^"']*)["']/i;
// An absolute URL the preview's CSP (no network) blocks: script, stylesheet or image.
const EXTERNAL_RESOURCE_RE =
  /<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref|img\b[^>]*\bsrc)\s*=\s*["'](?:https?:)?\/\/[^"']+["']/i;
// An <a> whose target cannot work in the sandboxed preview: an empty or bare "#",
// "javascript:", an absolute or root-relative URL, or a relative file path. Only
// "#section" anchors that point at an element of the same document work.
const ANCHOR_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gis;
const WINDOW_OPEN_RE = /\bwindow\.open\s*\(/;
const STORAGE_RE = /\b(?:localStorage|sessionStorage)\b/g;
const TRY_OPEN_RE = /\btry\s*\{/g;
const BRAND_TOKEN_DEFINITION_RE = /--brand-primary\s*:|\bid\s*=\s*["']ihub-brand-tokens["']/i;
const PLACEHOLDER_RE =
  /\/\/\s*(?:TODO|FIXME|rest of (?:the )?code|implement .* here)|\bplaceholder only\b/i;

function detectFormat(filename, requestedFormat, content) {
  // An explicit, valid `format` wins over what the filename suggests.
  if (requestedFormat === 'svg' || requestedFormat === 'html') return requestedFormat;
  if (/\.svg$/i.test(String(filename || ''))) return 'svg';
  if (/\.html?$/i.test(String(filename || ''))) return 'html';
  const trimmed = String(content || '').trim();
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(trimmed)) return 'svg';
  return 'html';
}

/**
 * The `[start, end)` ranges of every `try { … }` block body in a script, found
 * by matching braces (braces inside strings or comments are not special-cased).
 */
function tryBlockRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(TRY_OPEN_RE)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    ranges.push([open, end]);
  }
  return ranges;
}

/** Whether a `localStorage`/`sessionStorage` access sits outside every `try` block. */
function hasUnguardedStorageAccess(text) {
  const ranges = tryBlockRanges(text);
  for (const match of text.matchAll(STORAGE_RE)) {
    const guarded = ranges.some(([start, end]) => match.index > start && match.index < end);
    if (!guarded) return true;
  }
  return false;
}

/**
 * Links that do nothing in the sandboxed preview, as short descriptions. A link
 * with `href="#"` or an external URL is a dead end there: the frame has no
 * network and no popups, so everything a link points to must be inside the file.
 */
function findDeadLinks(text) {
  const ids = new Set([...text.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
  const dead = [];
  for (const match of text.matchAll(ANCHOR_HREF_RE)) {
    const href = match[2].trim();
    if (/^(?:mailto|tel|data|blob):/i.test(href)) continue;
    if (href.startsWith('#') && href.length > 1 && ids.has(href.slice(1))) continue;
    dead.push(href || '(empty)');
  }
  return [...new Set(dead)];
}

/**
 * Inspect HTML or SVG content for sandbox and self-containment pitfalls.
 *
 * @param {string} content
 * @param {'html'|'svg'} format
 * @returns {string[]}
 */
export function inspectWebArtifact(content, format) {
  const warnings = [];
  const text = String(content || '');
  if (format === 'svg') {
    if (!/<svg\b/i.test(text)) {
      warnings.push('The SVG content does not contain an <svg> root element.');
    } else if (!/\bviewBox\s*=/i.test(text)) {
      warnings.push(
        'The <svg> element has no viewBox attribute; add viewBox="0 0 W H" so it scales cleanly in the preview.'
      );
    }
    return warnings;
  }

  const relScript = RELATIVE_SCRIPT_RE.exec(text);
  if (relScript) {
    warnings.push(
      `Relative <script src="${relScript[1]}"> will not load inside the sandboxed srcDoc preview. Inline all JavaScript inside <script>…</script>.`
    );
  }
  const relLink = RELATIVE_LINK_RE.exec(text);
  if (relLink) {
    warnings.push(
      `Relative stylesheet <link href="${relLink[1]}"> will not load inside the sandboxed srcDoc preview. Inline all CSS inside <style>…</style>.`
    );
  }
  if (EXTERNAL_RESOURCE_RE.test(text)) {
    warnings.push(
      'An external script, stylesheet or image URL is blocked in the sandboxed preview, which has no network access. Inline all JavaScript and CSS, and embed images as data: URIs.'
    );
  }
  const deadLinks = findDeadLinks(text);
  if (deadLinks.length || WINDOW_OPEN_RE.test(text)) {
    const shown = deadLinks
      .slice(0, 5)
      .map(href => `"${href}"`)
      .join(', ');
    warnings.push(
      `Links that cannot work in the sandboxed preview${shown ? ` (href ${shown})` : ''}: it has no network and opens no new windows, so "#", external URLs, file paths and window.open() lead nowhere. Make every link, source or reference do something inside the file: a "#id" anchor to a section that exists, or a button that opens an in-page panel, modal or view that shows the content. Show an external address as plain text, not as a link.`
    );
  }
  if (hasUnguardedStorageAccess(text)) {
    warnings.push(
      'localStorage/sessionStorage is used outside a try/catch block. The preview runs in <iframe sandbox="allow-scripts"> without allow-same-origin, where storage access throws SecurityError unless wrapped in try { … } catch {}.'
    );
  }
  if (PLACEHOLDER_RE.test(text)) {
    warnings.push(
      'The artifact appears to contain placeholder comments (e.g. "// TODO" or "// rest of code"). Always write the complete working implementation.'
    );
  }
  return warnings;
}

/**
 * A value that is safe inside a `<style>` custom property: letters, digits, spaces
 * and the few characters colours and font stacks use. Anything that could end the
 * declaration or the style block (`;`, `}`, `<`, `>`) is dropped.
 */
function cssValue(value, fallback) {
  let clean = String(value ?? '')
    .replaceAll(/[^\w\s#%.,'"()-]/g, '')
    .trim();
  // An unbalanced quote would open a CSS string that swallows the rest of the rule.
  for (const quote of ["'", '"']) {
    if (clean.split(quote).length % 2 === 0) clean = clean.replaceAll(quote, '');
  }
  return clean.trim() || fallback;
}

/**
 * Inject `--brand-primary`, `--brand-accent`, `--brand-text` and `--brand-font`
 * CSS custom properties into an HTML document if not already defined.
 */
export function injectBrandTokens(html, brand = {}) {
  const primary = cssValue(brand.primaryColor, '#1e3a8a');
  const accent = cssValue(brand.accentColor, '#0f766e');
  const text = cssValue(brand.textColor, '#0f172a');
  const font = cssValue(brand.font, 'system-ui, -apple-system, sans-serif');
  if (BRAND_TOKEN_DEFINITION_RE.test(html)) return html;
  const styleTag = `<style id="ihub-brand-tokens">:root{--brand-primary:${primary};--brand-accent:${accent};--brand-text:${text};--brand-font:${font};}</style>`;
  // Function replacers: a `$&` or `$'` in a value must not be read as a replacement pattern.
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, (_, tag) => `${tag}\n${styleTag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/(<html\b[^>]*>)/i, (_, tag) => `${tag}\n<head>${styleTag}</head>`);
  }
  return `${styleTag}\n${html}`;
}

/**
 * `create_web_artifact`: validate, package and hold an interactive `.html` or
 * `.svg` artifact for the chat.
 *
 * @param {Object} params - Tool arguments plus trusted context (`user`, `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runCreateWebArtifact(params) {
  try {
    const preset = optionalString(params.preset, 40);
    if (preset && preset !== DASHBOARD_PRESET) {
      throw new GeneratedFileError(
        `Unknown preset "${preset}". The only preset is "${DASHBOARD_PRESET}".`,
        'invalid'
      );
    }
    // A preset is a page the server lays out from a small JSON spec; the
    // markup of any other artifact comes from the model.
    const rawContent = preset
      ? renderDashboard(params.data)
      : typeof params.content === 'string'
        ? params.content.trim()
        : '';
    if (!rawContent) {
      throw new GeneratedFileError(
        'Provide the HTML or SVG markup in "content", or a preset with its "data".',
        'invalid'
      );
    }
    const format = preset
      ? 'html'
      : detectFormat(params.filename || params.name, params.format, rawContent);
    const warnings = inspectWebArtifact(rawContent, format);

    const bundle = await templateBundleFor({
      format: 'xlsx',
      app: params.appConfig,
      requested: params.template
    });
    const templateBrand = bundle?.template?.brand || {};
    const brand = {
      primaryColor:
        templateBrand.primaryColor || optionalString(params.primaryColor, 20) || '#1e3a8a',
      accentColor: templateBrand.accentColor || optionalString(params.accentColor, 20) || '#0f766e',
      textColor: templateBrand.textColor || '#0f172a',
      font:
        templateBrand.bodyFont ||
        optionalString(params.font, 80) ||
        'system-ui, -apple-system, sans-serif'
    };

    const finalContent = format === 'html' ? injectBrandTokens(rawContent, brand) : rawContent;
    const data = Buffer.from(
      finalContent.endsWith('\n') ? finalContent : `${finalContent}\n`,
      'utf8'
    );
    const name = safeFileName(params.filename || params.name || params.title || 'artifact', format);

    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data,
      mimeType: 'text/plain',
      name
    });

    return {
      success: true,
      file,
      files: [file],
      ...(bundle?.template?.id ? { template: bundle.template.id } : {}),
      ...(warnings.length ? { warnings } : {}),
      message: warnings.length
        ? `Created the ${format.toUpperCase()} artifact "${file.name}", but it has ${warnings.length} problem(s) listed in "warnings" and the user already sees the faulty version. Do NOT answer yet: fix every warning and call create_web_artifact again with the same filename and the complete corrected content. Only then answer, without pasting the code or adding a link.`
        : `Created the interactive ${format.toUpperCase()} artifact "${file.name}". The user can interact with it live in the Artifacts panel (Preview | Code) and sees a download card in the chat — do not paste the code or add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The web artifact could not be created.');
  }
}
