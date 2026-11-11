// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Embeddable view of a shared artifact: `GET /share/:shareId/embed`.
 *
 * A public artifact share the owner marked `embeddable` can be put in an
 * iframe on the sites an admin allowlisted (`chats.sharing.embedAllowedOrigins`).
 * This is a small server-rendered page, not the SPA: it carries a
 * `frame-ancestors` policy naming only those origins, and shows the artifact
 *
 *  - HTML / SVG / text in an inner `sandbox="allow-scripts"` iframe (opaque
 *    origin, same CSP as the in-app preview), so a model's markup never runs
 *    on the iHub origin;
 *  - images as `<img>`, PDFs in a frame onto the share's artifact endpoint;
 *  - everything else as a name and a download link.
 *
 * Anything that is not an active, public, embeddable artifact share answers
 * 404 and never relaxes the framing policy.
 *
 * @module routes/shareEmbedPage
 */
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { buildServerPath } from '../utils/basePath.js';
import { applyFrameAncestorsCsp } from '../utils/frameAncestors.js';
import { isChatHistoryConfigured } from '../services/chat/chatPersistence.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { getChatShareRepository, isShareId } from '../services/chat/ChatShareRepository.js';
import { authorizeShareView } from '../services/chat/chatShareAccess.js';
import { chatSharingSettings, isChatSharingConfigured } from '../services/chat/chatSharing.js';
import { artifactSettings } from '../services/artifacts/artifactPolicy.js';
import { artifactPreviewCsp, prepareHtmlPreview } from '../../shared/artifactPreview.js';

const COMPONENT = 'ShareEmbedPage';

/** Largest text artifact the embed renders; beyond it the page offers a download. */
const MAX_EMBED_TEXT_BYTES = 512 * 1024;

/**
 * CSP of the embed page. A `srcdoc` frame inherits the embedding page's
 * policy, so the page carries the same directives as the markup inside
 * (`shared/artifactPreview.js`, with the admin's CDN hosts), and may also show
 * images from the share's own artifact endpoint. The page itself runs no
 * script; everything it shows is escaped.
 *
 * @param {string[]} scriptHosts - Hosts HTML artifacts may load scripts from.
 * @returns {string}
 */
export function embedPageCsp(scriptHosts) {
  return artifactPreviewCsp(scriptHosts).replace(
    'img-src data: blob:',
    "img-src 'self' data: blob:"
  );
}

const PAGE_STYLE =
  'html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#fff;color:#111}' +
  'iframe,img,embed{border:0;display:block;width:100%;height:100%;object-fit:contain}' +
  '.note{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:16px;text-align:center}' +
  'a{color:#4f46e5}';

/**
 * Escape text for an HTML text node or a double-quoted attribute.
 *
 * @param {unknown} value - Raw value.
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * How the embed shows an artifact.
 *
 * @param {{kind?: string, mimeType?: string, name?: string}} artifact - Descriptor.
 * @returns {'image'|'pdf'|'html'|'svg'|'text'|'none'}
 */
export function embedTypeOf(artifact) {
  const mimeType = artifact?.mimeType || '';
  const name = typeof artifact?.name === 'string' ? artifact.name.trim() : '';
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.svg$/i.test(name) || mimeType === 'image/svg+xml') return 'svg';
  if (artifact?.kind === 'image' || mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (artifact?.kind === 'code' || mimeType.startsWith('text/')) return 'text';
  return 'none';
}

function page(body, { title = '' } = {}) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>` +
    `<body>${body}</body></html>`
  );
}

function sandboxedFrame(markup, title) {
  return `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(
    title
  )}" srcdoc="${escapeHtml(markup)}"></iframe>`;
}

function notFound(res) {
  res
    .status(404)
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(page('<div class="note">Not found</div>'));
}

/**
 * Render the body for an artifact.
 *
 * @param {Object} share - Share document.
 * @param {Object} stored - `{ data: Buffer, mimeType, name }` from the artifact store.
 * @param {string[]} scriptHosts - Hosts an HTML artifact may load scripts from.
 * @returns {string} Body markup.
 */
function renderBody(share, stored, scriptHosts) {
  const withCsp = html => prepareHtmlPreview(html, { scriptHosts });
  const artifact = { ...share.artifact, mimeType: stored.mimeType, name: stored.name };
  const type = embedTypeOf(artifact);
  const title = share.title || stored.name || 'Shared artifact';
  const url = buildServerPath(`/api/shares/${share.id}/artifacts/${stored.id}`);
  const tooLarge = stored.data.length > MAX_EMBED_TEXT_BYTES;

  if (type === 'image') return `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}">`;
  if (type === 'pdf')
    return `<iframe src="${escapeHtml(url)}" title="${escapeHtml(title)}"></iframe>`;
  if (!tooLarge && type === 'html') {
    return sandboxedFrame(withCsp(stored.data.toString('utf8')), title);
  }
  if (!tooLarge && type === 'svg') {
    return sandboxedFrame(
      withCsp(`<!doctype html><body style="margin:0">${stored.data.toString('utf8')}</body>`),
      title
    );
  }
  if (!tooLarge && type === 'text') {
    return sandboxedFrame(
      withCsp(
        `<!doctype html><body style="margin:8px"><pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace">${escapeHtml(
          stored.data.toString('utf8')
        )}</pre></body>`
      ),
      title
    );
  }
  return (
    `<div class="note"><strong>${escapeHtml(stored.name || title)}</strong>` +
    `<a href="${escapeHtml(url)}?download=1" rel="noopener" target="_blank">Download</a></div>`
  );
}

/**
 * Register the embed page.
 *
 * @param {import('express').Application} app - Express application.
 * @returns {void}
 */
export default function registerShareEmbedPageRoutes(app) {
  app.get(buildServerPath('/share/:shareId/embed'), async (req, res) => {
    try {
      const features = configCache.getFeatures();
      const platform = configCache.getPlatform() || {};
      const settings = chatSharingSettings(platform);
      const repository = getChatShareRepository();
      const { shareId } = req.params;
      if (
        !isShareId(shareId) ||
        !settings.embedEnabled ||
        !isChatHistoryConfigured(features, platform) ||
        !isChatSharingConfigured(features, platform) ||
        !repository.isAvailable() ||
        !getChatRepository().isAvailable()
      ) {
        return notFound(res);
      }
      const share = await repository.getShare(shareId);
      // No viewer identity on purpose: only a public link can be embedded, and
      // the owner's or an admin's own preview must be counted like any other.
      const access = await authorizeShareView(share, undefined, { purpose: 'artifact' });
      if (
        !access.ok ||
        share.target !== 'artifact' ||
        share.mode !== 'public' ||
        share.embeddable !== true ||
        !share.artifact?.id
      ) {
        return notFound(res);
      }
      const stored = await getArtifactRepository().get(
        getChatRepository().artifactScope(share.chatId),
        share.artifact.id
      );
      if (!stored) return notFound(res);

      const { scriptHosts } = artifactSettings(platform);

      if (access.counts) {
        const { counted } = await repository.recordView(share.id, null, { recordAs: null });
        if (!counted) return notFound(res);
      }

      applyFrameAncestorsCsp(res, settings.embedAllowedOrigins, [
        embedPageCsp(scriptHosts),
        "frame-src 'self'"
      ]);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        page(renderBody(share, { ...stored, id: share.artifact.id }, scriptHosts), {
          title: share.title
        })
      );
    } catch (error) {
      logger.error('Failed to render embedded share', {
        component: COMPONENT,
        error: error.message
      });
      return notFound(res);
    }
  });
}
