// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import vm from 'node:vm';
import { isAllowedScriptUrl } from '../../../../shared/artifactPreview.js';
import { artifactPolicy } from '../../artifacts/artifactPolicy.js';
import { optionalString, parseStructured, toolFailure } from '../documentToolHelpers.js';
import { chatArtifactCandidates, selectChatFiles } from '../files/fileTools.js';
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
 * `edit_web_artifact` changes such a file by exact text replacements, so a fix
 * or a small change does not make the model write the whole file again.
 *
 * The checks sort what they find into problems that break the preview
 * (`warnings`: the model fixes them before it answers) and notes on things
 * that work but could be better (`notes`: never worth a rewrite).
 *
 * Security invariant: on the wire, `.html` and `.svg` artifacts are stored
 * under `mimeType: 'text/plain'` (`kind: 'code'`) so the server never serves
 * active `text/html` or `image/svg+xml` from a same-origin URL. The client's
 * `ArtifactPreview` renders `.html` inside `<iframe sandbox="allow-scripts"
 * referrerPolicy="no-referrer" srcDoc={…} />` and `.svg` via DOMPurify.
 */

const RELATIVE_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](?!(?:https?:)?\/\/|data:)([^"']+)["']/i;
const RELATIVE_LINK_RE =
  /<link\b[^>]*\bhref\s*=\s*["'](?!(?:https?:)?\/\/|data:)([^"']+\.css[^"']*)["']/i;
// Absolute URLs of scripts and stylesheets (the preview loads them from the
// allowlisted CDN hosts only), and of images and CSS url()/@import targets
// (the preview never loads those).
const EXTERNAL_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
const EXTERNAL_LINK_RE = /<link\b[^>]*\bhref\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
const EXTERNAL_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
const CSS_REMOTE_RE = /(?:@import\s+(?:url\()?|\burl\()\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi;
// Inline classic scripts, for the syntax check. `src` scripts and non-JS types
// (JSON data, templates, text/babel) are skipped; modules too, since `vm`
// compiles classic scripts only.
const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPE_RE = /^(?:text|application)\/(?:javascript|ecmascript)$/i;
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

/** Every capture of a global regex over a text. */
function capturesOf(re, text) {
  return [...text.matchAll(re)].map(match => match[1]);
}

/**
 * Remote URLs the preview will not load: scripts and stylesheets from a host
 * that is not allowlisted (`code`), and every remote image or CSS `url()` /
 * `@import` (`media`).
 */
function blockedRemoteUrls(text, scriptHosts) {
  const code = [
    ...capturesOf(EXTERNAL_SCRIPT_RE, text).filter(url => !isAllowedScriptUrl(url, scriptHosts)),
    ...capturesOf(EXTERNAL_LINK_RE, text).filter(url => !isAllowedScriptUrl(url, scriptHosts))
  ];
  const media = [
    ...capturesOf(EXTERNAL_IMAGE_RE, text),
    ...capturesOf(CSS_REMOTE_RE, text).filter(url => !isAllowedScriptUrl(url, scriptHosts))
  ];
  return { code: [...new Set(code)], media: [...new Set(media)] };
}

/** The first `max` values, quoted and joined. */
function quoteList(values, max) {
  return values
    .slice(0, max)
    .map(value => `"${value}"`)
    .join(', ');
}

/** How often a pattern occurs. */
function countOf(re, text) {
  return (text.match(re) || []).length;
}

/**
 * Signs the markup was cut off mid-file — typically the model ran into its
 * output limit: a `<script>` or `<style>` that never closes, or a document
 * that opens `<html>` and closes neither `<body>` nor `<html>`.
 */
function looksTruncated(text, format) {
  if (format === 'svg') return /<svg\b/i.test(text) && !/<\/svg\s*>/i.test(text);
  if (countOf(/<script\b/gi, text) > countOf(/<\/script\s*>/gi, text)) return true;
  if (countOf(/<style\b/gi, text) > countOf(/<\/style\s*>/gi, text)) return true;
  return /<html\b/i.test(text) && !/<\/body\s*>/i.test(text) && !/<\/html\s*>/i.test(text);
}

/**
 * Syntax errors in the inline classic scripts, as short descriptions. Each
 * script is compiled with `vm.Script`, which parses but never runs it.
 */
function scriptSyntaxErrors(text) {
  const errors = [];
  let index = 0;
  for (const [, attributes, body] of text.matchAll(INLINE_SCRIPT_RE)) {
    index += 1;
    if (/\bsrc\s*=/i.test(attributes) || !body.trim()) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1];
    if (type && !JS_TYPE_RE.test(type)) continue;
    const filename = `script-${index}.js`;
    try {
      new vm.Script(body, { filename });
    } catch (error) {
      if (!(error instanceof SyntaxError)) continue;
      const line = new RegExp(`${filename}:(\\d+)`).exec(String(error.stack))?.[1];
      errors.push(
        `<script> #${index}${line ? `, line ${line}` : ''}: ${error.name}: ${error.message}`
      );
    }
  }
  return errors;
}

/**
 * Inspect HTML or SVG content for sandbox and self-containment pitfalls.
 *
 * A finding is `blocking` when the preview is broken without a fix: the file
 * was cut off, a script does not parse or throws on storage access, code or a
 * library it needs will not load. Everything else (a dead link, a remote
 * image, a missing `viewBox`, a placeholder comment) is a note: the artifact
 * works, and a note is never worth writing the file again.
 *
 * @param {string} content
 * @param {'html'|'svg'} format
 * @param {{scriptHosts?: string[]}} [options] - CDN hosts the preview loads
 *   scripts and stylesheets from (`platform.artifacts.scriptHosts`).
 * @returns {Array<{ text: string, blocking: boolean }>}
 */
export function inspectWebArtifactFindings(content, format, { scriptHosts = [] } = {}) {
  const findings = [];
  const problem = text => findings.push({ text, blocking: true });
  const note = text => findings.push({ text, blocking: false });
  const text = String(content || '');
  const truncated = looksTruncated(text, format);
  if (truncated) {
    problem(
      'The file looks cut off: it ends inside a <script> or <style> block, or before </body>/</html> (or </svg>). This usually means the output limit was reached. Write a more compact version (less sample data, less repeated markup, shorter CSS) and call create_web_artifact again with the complete file.'
    );
  }
  if (format === 'svg') {
    if (!/<svg\b/i.test(text)) {
      problem('The SVG content does not contain an <svg> root element.');
    } else if (!/\bviewBox\s*=/i.test(text)) {
      note(
        'The <svg> element has no viewBox attribute; add viewBox="0 0 W H" so it scales cleanly in the preview.'
      );
    }
    return findings;
  }

  const relScript = RELATIVE_SCRIPT_RE.exec(text);
  if (relScript) {
    problem(
      `Relative <script src="${relScript[1]}"> will not load inside the sandboxed srcDoc preview. Inline all JavaScript inside <script>…</script>.`
    );
  }
  const relLink = RELATIVE_LINK_RE.exec(text);
  if (relLink) {
    problem(
      `Relative stylesheet <link href="${relLink[1]}"> will not load inside the sandboxed srcDoc preview. Inline all CSS inside <style>…</style>.`
    );
  }
  const { code: blockedCode, media: blockedMedia } = blockedRemoteUrls(text, scriptHosts);
  if (blockedCode.length) {
    const allowed = scriptHosts.length
      ? `Scripts and stylesheets load only over https from ${scriptHosts.join(', ')}`
      : 'This installation allows no external scripts or stylesheets at all';
    problem(
      `The sandboxed preview will not load ${quoteList(blockedCode, 3)}, so the code that needs it does not run. ${allowed}. Switch to an allowed host or inline the code.`
    );
  }
  if (blockedMedia.length) {
    note(
      `The preview never loads images, fonts or CSS url()/@import from the network, so ${quoteList(blockedMedia, 3)} will not show. Embed images as data: URIs or inline SVG, or leave them out.`
    );
  }
  if (!truncated) {
    const syntaxErrors = scriptSyntaxErrors(text);
    if (syntaxErrors.length) {
      problem(
        `JavaScript that does not parse, so the script never runs: ${syntaxErrors.slice(0, 3).join('; ')}. Fix the syntax.`
      );
    }
  }
  const deadLinks = findDeadLinks(text);
  if (deadLinks.length || WINDOW_OPEN_RE.test(text)) {
    const shown = quoteList(deadLinks, 5);
    note(
      `Links that cannot work in the sandboxed preview${shown ? ` (href ${shown})` : ''}: it has no network and opens no new windows, so "#", external URLs, file paths and window.open() lead nowhere. Make every link, source or reference do something inside the file: a "#id" anchor to a section that exists, or a button that opens an in-page panel, modal or view that shows the content. Show an external address as plain text, not as a link.`
    );
  }
  if (hasUnguardedStorageAccess(text)) {
    problem(
      'localStorage/sessionStorage is used outside a try/catch block. The preview runs in <iframe sandbox="allow-scripts"> without allow-same-origin, where storage access throws SecurityError unless wrapped in try { … } catch {}.'
    );
  }
  if (PLACEHOLDER_RE.test(text)) {
    note(
      'The artifact appears to contain placeholder comments (e.g. "// TODO" or "// rest of code"). Always write the complete working implementation.'
    );
  }
  return findings;
}

/**
 * The texts of {@link inspectWebArtifactFindings}, problems and notes alike.
 *
 * @param {string} content
 * @param {'html'|'svg'} format
 * @param {{scriptHosts?: string[]}} [options]
 * @returns {string[]}
 */
export function inspectWebArtifact(content, format, options) {
  return inspectWebArtifactFindings(content, format, options).map(finding => finding.text);
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
 * What the model is told about a stored artifact and its findings. A problem
 * is fixed before the answer, with `edit_web_artifact` (or, for a preset, the
 * corrected data); a note is mentioned or fixed in passing, never by writing
 * the file again.
 *
 * @param {Object} params
 * @param {string} params.verb - "Created" or "Updated".
 * @param {'html'|'svg'} params.format
 * @param {string} params.name - The stored file name.
 * @param {Array<{text: string, blocking: boolean}>} params.findings
 * @param {boolean} params.preset - The page came from a preset's data.
 * @returns {{message: string, warnings?: string[], notes?: string[]}}
 */
function reportOf({ verb, format, name, findings, preset }) {
  const warnings = findings.filter(f => f.blocking).map(f => f.text);
  const notes = findings.filter(f => !f.blocking).map(f => f.text);
  const kind = format.toUpperCase();
  const fix = preset
    ? 'call create_web_artifact again with the same filename, the preset and the corrected "data"'
    : `call edit_web_artifact with filename "${name}" and "edits" that replace only the faulty text. Write the whole file again with create_web_artifact only when it was cut off, and then more compactly`;
  let message;
  if (warnings.length) {
    message = `${verb} the ${kind} artifact "${name}", but ${warnings.length} problem(s) in "warnings" break the preview, and the user already sees it broken. Do NOT answer yet: ${fix}. Then answer, without pasting the code or adding a link.`;
  } else {
    message = `${verb} the interactive ${kind} artifact "${name}". The user can interact with it live in the Artifacts panel (Preview | Code) and sees a download card in the chat — do not paste the code or add a link.`;
  }
  if (notes.length) {
    message += ` "notes" lists ${notes.length} thing(s) that work but could be better. Do not create the file again for them: fix one with edit_web_artifact only when it is a small change, otherwise leave it.`;
  }
  return { message, ...(warnings.length ? { warnings } : {}), ...(notes.length ? { notes } : {}) };
}

/**
 * Check, brand and hold a finished web artifact, and say what the model is to
 * do next. Shared by `create_web_artifact` and `edit_web_artifact`.
 *
 * @param {Object} params - The tool call's parameters and trusted context.
 * @param {Object} artifact
 * @param {string} artifact.content - The markup.
 * @param {'html'|'svg'} artifact.format
 * @param {string} artifact.name - File name, extension included or not.
 * @param {string} artifact.verb - "Created" or "Updated".
 * @param {boolean} [artifact.preset]
 * @returns {Promise<Object>} The tool result.
 */
async function packageWebArtifact(params, { content, format, name, verb, preset = false }) {
  const findings = inspectWebArtifactFindings(content, format, {
    scriptHosts: artifactPolicy().scriptHosts
  });

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

  const finalContent = format === 'html' ? injectBrandTokens(content, brand) : content;
  const data = Buffer.from(
    finalContent.endsWith('\n') ? finalContent : `${finalContent}\n`,
    'utf8'
  );

  const file = holdGeneratedFile({
    user: params.user,
    chatId: params.chatId,
    data,
    mimeType: 'text/plain',
    name: safeFileName(name, format)
  });

  return {
    success: true,
    file,
    files: [file],
    ...(bundle?.template?.id ? { template: bundle.template.id } : {}),
    ...reportOf({ verb, format, name: file.name, findings, preset })
  };
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
    return await packageWebArtifact(params, {
      content: rawContent,
      format,
      name: params.filename || params.name || params.title || 'artifact',
      verb: 'Created',
      preset: Boolean(preset)
    });
  } catch (error) {
    return toolFailure(error, 'The web artifact could not be created.');
  }
}

/** Most replacements one `edit_web_artifact` call may carry. */
export const MAX_ARTIFACT_EDITS = 50;

/** Where `needle` occurs in `text`, at most `limit` times. */
function occurrencesOf(text, needle, limit = 3) {
  const found = [];
  let from = 0;
  while (found.length < limit) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}

/**
 * The replacements of an `edit_web_artifact` call, checked.
 *
 * @param {unknown} value - `edits`, as a list or its JSON.
 * @returns {Array<{oldText: string, newText: string}>}
 */
function editsOf(value) {
  const edits = parseStructured(value, 'edits', 'a list of { oldText, newText }');
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new GeneratedFileError(
      '"edits" must be a non-empty list of { oldText, newText }.',
      'invalid'
    );
  }
  if (edits.length > MAX_ARTIFACT_EDITS) {
    throw new GeneratedFileError(
      `One call can carry at most ${MAX_ARTIFACT_EDITS} edits. For a larger change, create the file again with create_web_artifact.`,
      'invalid'
    );
  }
  return edits.map((edit, index) => {
    const oldText = edit?.oldText;
    const newText = edit?.newText ?? '';
    if (typeof oldText !== 'string' || oldText === '' || typeof newText !== 'string') {
      throw new GeneratedFileError(
        `edits[${index}] needs "oldText" (the exact text to replace, not empty) and "newText" (its replacement; "" deletes it).`,
        'invalid'
      );
    }
    return { oldText, newText };
  });
}

/**
 * Apply exact replacements, all or none. Each `oldText` must occur exactly
 * once in the text as the edits before it left it, so a replacement never
 * lands in the wrong place.
 *
 * @param {string} text
 * @param {Array<{oldText: string, newText: string}>} edits
 * @returns {string}
 * @throws {GeneratedFileError} naming the first edit that does not apply.
 */
export function applyArtifactEdits(text, edits) {
  let result = text;
  edits.forEach(({ oldText, newText }, index) => {
    const found = occurrencesOf(result, oldText);
    if (found.length === 0) {
      throw new GeneratedFileError(
        `edits[${index}].oldText does not occur in the current file${index ? ' (after the edits before it)' : ''}. Copy it exactly from the file, whitespace and quotes included; if you do not have the current text, read it with chat_artifacts_read. No edit was applied.`,
        'invalid'
      );
    }
    if (found.length > 1) {
      throw new GeneratedFileError(
        `edits[${index}].oldText occurs ${found.length === 3 ? '3 or more' : found.length} times. Include enough surrounding text to make it unique. No edit was applied.`,
        'invalid'
      );
    }
    result = result.slice(0, found[0]) + newText + result.slice(found[0] + oldText.length);
  });
  return result;
}

/**
 * `edit_web_artifact`: change an `.html` or `.svg` artifact of this chat by
 * exact text replacements and hold the result under the same name, as the
 * file's newest version. The earlier version stays as it was (artifacts are
 * written once).
 *
 * @param {Object} params - `filename`, `edits`, plus trusted context (`user`, `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runEditWebArtifact(params) {
  try {
    const wanted = optionalString(params.filename, 200);
    if (!wanted) {
      throw new GeneratedFileError(
        'Name the artifact to change in "filename" (its name or id in this chat).',
        'invalid'
      );
    }
    const edits = editsOf(params.edits);
    const candidates = await chatArtifactCandidates({
      user: params.user,
      chatId: params.chatId,
      intent: 'read'
    });
    const [target] = selectChatFiles(candidates, [wanted], false);
    const format = /\.svg$/i.test(target.name)
      ? 'svg'
      : /\.html?$/i.test(target.name)
        ? 'html'
        : null;
    if (!format) {
      throw new GeneratedFileError(
        `"${target.name}" is not a web artifact (.html or .svg). edit_web_artifact changes only those; create other files again with their own tool.`,
        'invalid'
      );
    }
    const data = await target.load();
    if (!data) {
      throw new GeneratedFileError(`The file "${target.name}" is no longer stored.`, 'not-found');
    }
    const current = data.toString('utf8');
    const updated = applyArtifactEdits(current, edits);
    if (updated === current) {
      throw new GeneratedFileError(
        'The edits change nothing: every newText equals its oldText.',
        'invalid'
      );
    }
    const result = await packageWebArtifact(params, {
      content: updated.trim(),
      format,
      name: target.name,
      verb: 'Updated'
    });
    return { ...result, edited: edits.length };
  } catch (error) {
    return toolFailure(error, 'The web artifact could not be changed.');
  }
}
