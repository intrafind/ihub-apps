// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { GHOST_BUTTON } from '../../../shared/utils/buttonTokens';
import { saveBlobAs } from '../../../utils/externalNavigation';
import PaneHeader from '../../workspace/components/PaneHeader';
import SelectionScope from '../../workspace/components/SelectionScope';
import ArtifactPreview from './ArtifactPreview';
import {
  artifactBadge,
  artifactDisplayName,
  codeLanguageOf,
  isTextArtifact,
  previewTypeOf,
  saveName
} from '../utils/artifactFiles';

/** Preview types that have a rendered view as well as a source view (concept §5). */
const HAS_CODE_VIEW = ['markdown', 'html', 'svg', 'csv', 'ipynb'];
/** Preview types that can be exported as Markdown / HTML / PDF text documents. */
const EXPORTABLE = ['markdown', 'json', 'code', 'csv', 'ipynb'];
/** Preview types read as a text column in full screen; the rest fill the pane. */
const READING_COLUMN = ['markdown', 'json', 'code', 'csv', 'ipynb'];
/** A markdown fence long enough to hold `text` whatever backticks it contains. */
function fenced(text, language) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}\n`;
}

/**
 * One artifact under the shared pane header, filling what it is given.
 *
 * HTML is rendered by {@link ArtifactPreview} in `<iframe sandbox="allow-scripts">`
 * with the preview CSP — here as everywhere. Browser full screen is requested on
 * this component's own container, never inside the frame, so the frame needs no
 * `allow-same-origin`, `allow-popups` or `allow="fullscreen"`. The selection chip
 * cannot read a selection inside that frame, so for HTML and SVG it works in the
 * Code view only.
 *
 * Two shapes:
 * - `mode="pane"` (default): inside the workspace pane, which hands it `chrome`
 *   (back link, title switcher, expand, close, the live region).
 * - `mode="page"`: the viewer is the whole page (the standalone `/artifacts/…`
 *   page and shared links): no close button. `embed` drops the header too.
 *
 * @param {Object} props
 * @param {Object} props.artifact - The descriptor shown: `{ id, name?, kind?, mimeType, bytes?, data? }`.
 * @param {(artifact: Object) => Promise<Blob>} props.getBlob - The bytes of an artifact.
 * @param {(artifact: Object) => void} [props.onShare] - Adds Share. Absent where sharing is off.
 * @param {(artifact: Object) => void} [props.onShowInFiles] - Adds "Show in Files".
 * @param {(artifact: Object) => void} [props.onOpenInNewTab] - Adds "Open in new tab".
 * @param {Object[]} [props.artifacts] - Page mode: the artifacts the title switcher offers.
 * @param {(artifact: Object) => void} [props.onSelect] - Page mode: switch to another artifact.
 * @param {Object} [props.chrome] - Pane mode: what the pane gives every detail view.
 * @param {{ prominent: boolean, run: () => Promise<{ ok: boolean, filename?: string,
 *   reason?: string }> }|null} [props.attachToMail] - "Attach to email" (Outlook, while a mail
 *   is being written): a visible header button when `prominent`, else in ⋯.
 * @param {MenuAction[]} [props.extraMore] - More ⋯ items.
 * @param {import('react').ReactNode} [props.headerExtra] - A visible header button.
 * @param {'pane'|'page'} [props.mode]
 * @param {boolean} [props.embed] - Page mode without the header.
 * @param {import('react').ReactNode} [props.toolbarExtra] - Page mode: badges and links before the title.
 */
export default function ArtifactViewer({
  artifact,
  getBlob,
  onShare = null,
  onShowInFiles = null,
  onOpenInNewTab = null,
  artifacts = null,
  onSelect = null,
  chrome = null,
  attachToMail = null,
  extraMore = [],
  headerExtra = null,
  mode = 'pane',
  embed = false,
  toolbarExtra = null
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const isPage = mode === 'page';
  const [viewMode, setViewMode] = useState('preview');
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [attaching, setAttaching] = useState(false);

  const name = artifactDisplayName(artifact);
  const type = previewTypeOf(artifact);
  const hasCodeView = HAS_CODE_VIEW.includes(type);
  const isText = isTextArtifact(artifact);
  const canExport = EXPORTABLE.includes(type) || type === 'html';
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled !== false;
  const showingCode = viewMode === 'code';
  // The chip reads selections in the pane's own DOM: everything but a sandboxed frame.
  const selectable = !(['html', 'svg'].includes(type) && !showingCode) && type !== 'image';

  // A confirmation goes away by itself; an error stays until the next action.
  useEffect(() => {
    if (notice?.tone !== 'info') return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Another artifact starts in its rendered view.
  useEffect(() => {
    setViewMode('preview');
    setNotice(null);
  }, [artifact.id]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement && document.fullscreenElement === containerRef.current) {
        document.exitFullscreen?.().catch?.(() => {});
      }
    };
  }, []);

  // Stable for the preview: a new descriptor object of the same artifact (a
  // streaming answer re-renders the chat) must not reload it.
  const latest = useRef({ artifact, getBlob });
  latest.current = { artifact, getBlob };
  const previewGetBlob = useCallback(
    () => latest.current.getBlob(latest.current.artifact),
    [artifact.id]
  );

  const say = (tone, text) => {
    setNotice({ tone, text });
    chrome?.announce?.(text);
  };

  const readText = async () => (await getBlob(artifact)).text();

  const download = async () => {
    try {
      const blob = await getBlob(artifact);
      if (!saveBlobAs(blob, saveName(name))) throw new Error('save');
    } catch {
      say('error', t('chatArtifacts.downloadFailed', 'The download failed. Please try again.'));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await readText());
      say('info', t('chatArtifacts.copied', 'Copied to the clipboard.'));
    } catch {
      say('error', t('chatArtifacts.copyFailed', 'The content could not be copied.'));
    }
  };

  const copyAsMarkdown = async () => {
    try {
      const text = await readText();
      await navigator.clipboard.writeText(
        type === 'markdown' ? text : fenced(text, codeLanguageOf(name))
      );
      say('info', t('chatArtifacts.copied', 'Copied to the clipboard.'));
    } catch {
      say('error', t('chatArtifacts.copyFailed', 'The content could not be copied.'));
    }
  };

  const exportAs = async format => {
    try {
      if (type === 'html' && format === 'html') {
        if (!saveBlobAs(await getBlob(artifact), saveName(name))) throw new Error('save');
        return;
      }
      const text = await readText();
      const exports = await import('../../../shared/utils/markdownExports');
      const base = saveName(name).replace(/\.[^.]+$/, '') || 'artifact';
      const markdown = type === 'markdown' ? text : fenced(text, codeLanguageOf(name));
      if (format === 'markdown') exports.exportAsMarkdown(markdown, `${base}.md`);
      else if (format === 'html') exports.exportAsHTML(markdown, base);
      else await exports.exportAsPDF(markdown, base);
    } catch {
      say('error', t('chatArtifacts.exportFailed', 'The export failed. Please try again.'));
    }
  };

  // The result is shown, not only announced; a second click while it runs does nothing.
  const attach = async () => {
    if (attaching || !attachToMail) return;
    setAttaching(true);
    try {
      const result = await attachToMail.run();
      if (result?.ok) {
        say(
          'info',
          t('chatFiles.attached', 'Attached {{name}} to your email.', { name: result.filename })
        );
      } else {
        say(
          'error',
          result?.reason === 'tooLarge'
            ? t('chatFiles.attachTooLarge', 'The file is too large to attach to an email.')
            : t('chatFiles.attachFailed', 'The file could not be attached to your email.')
        );
      }
    } catch {
      say('error', t('chatFiles.attachFailed', 'The file could not be attached to your email.'));
    } finally {
      setAttaching(false);
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen?.();
    } catch {
      // The browser refused (no user gesture, policy): nothing to do.
    }
  };

  const copyMenu = [
    ...(isText && type !== 'markdown' && EXPORTABLE.includes(type)
      ? [
          {
            key: 'copy-md',
            icon: 'copy',
            label: t('workspace.copyAsMarkdown', 'Copy as Markdown'),
            onClick: copyAsMarkdown
          }
        ]
      : []),
    ...(canExport
      ? [
          {
            key: 'export-html',
            icon: 'document-text',
            label: t('chatArtifacts.exportHtml', 'Export as HTML'),
            onClick: () => exportAs('html')
          }
        ]
      : []),
    ...(EXPORTABLE.includes(type)
      ? [
          {
            key: 'export-md',
            icon: 'document-text',
            label: t('chatArtifacts.exportMarkdown', 'Export as Markdown'),
            onClick: () => exportAs('markdown')
          },
          {
            key: 'export-pdf',
            icon: 'document-text',
            label: t('chatArtifacts.exportPdf', 'Export as PDF'),
            onClick: () => exportAs('pdf')
          }
        ]
      : [])
  ];

  const more = [
    ...(onOpenInNewTab
      ? [
          {
            key: 'newtab',
            icon: 'external-link',
            label: t('chatArtifacts.openInNewTab', 'Open in new tab'),
            onClick: () => onOpenInNewTab(artifact)
          }
        ]
      : []),
    ...(onShowInFiles
      ? [
          {
            key: 'files',
            icon: 'archive-box',
            label: t('chatArtifacts.showInFiles', 'Show in files'),
            onClick: () => onShowInFiles(artifact)
          }
        ]
      : []),
    ...(attachToMail && !attachToMail.prominent
      ? [
          {
            key: 'attach',
            icon: 'envelope',
            label: t('chatFiles.attachToEmail', 'Attach to email'),
            onClick: attach,
            testId: 'generated-attach-to-email'
          }
        ]
      : []),
    ...extraMore,
    ...(canFullscreen
      ? [
          {
            key: 'browser-fullscreen',
            icon: fullscreen ? 'arrows-pointing-in' : 'arrows-pointing-out',
            label: fullscreen
              ? t('workspace.exitBrowserFullScreen', 'Exit browser full screen')
              : t('workspace.browserFullScreen', 'Browser full screen'),
            onClick: toggleFullscreen
          }
        ]
      : [])
  ];

  // Page mode: the title switches between the artifacts of the chat.
  const pageSwitcher =
    isPage && Array.isArray(artifacts) && artifacts.length > 1 && onSelect
      ? {
          groups: [
            {
              label: t('chatFiles.tabGenerated', 'Generated'),
              items: artifacts.map(item => ({
                key: item.id,
                name: artifactDisplayName(item),
                current: item.id === artifact.id,
                onSelect: () => onSelect(item)
              }))
            }
          ]
        }
      : null;

  const full = isPage || chrome?.full;
  const readingColumn = full && READING_COLUMN.includes(type);

  return (
    <div
      ref={containerRef}
      data-testid="artifact-viewer"
      data-preview-type={type}
      className={`flex min-h-0 flex-1 flex-col bg-white dark:bg-gray-900 ${isPage ? 'h-dvh w-full' : ''}`}
    >
      {!embed && (
        <PaneHeader
          title={name}
          badge={artifactBadge(artifact)}
          headingId={chrome?.headingId}
          headingRef={chrome?.headingRef}
          back={chrome?.back}
          switcher={chrome?.switcher || pageSwitcher}
          leading={toolbarExtra}
          viewToggle={hasCodeView ? { mode: viewMode, onChange: setViewMode } : null}
          copy={isText ? { onCopy: copy, menu: copyMenu } : null}
          download={{
            key: 'download',
            icon: 'download',
            label: t('chatArtifacts.download', 'Download'),
            ariaLabel: t('chatArtifacts.downloadNamed', 'Download {{name}}', { name }),
            onClick: download,
            testId: 'artifact-viewer-download'
          }}
          share={
            onShare
              ? {
                  key: 'share',
                  icon: 'share',
                  label: t('chatArtifacts.share', 'Share'),
                  onClick: () => onShare(artifact),
                  testId: 'artifact-viewer-share'
                }
              : null
          }
          extra={
            attachToMail?.prominent ? (
              <button
                type="button"
                className={GHOST_BUTTON}
                onClick={attach}
                disabled={attaching}
                aria-busy={attaching || undefined}
                data-testid="generated-attach-to-email"
              >
                <Icon name="envelope" size="sm" />
                {t('chatFiles.attachToEmail', 'Attach to email')}
              </button>
            ) : (
              headerExtra
            )
          }
          expand={chrome?.expand}
          close={chrome?.close}
          more={[...(chrome?.more || []), ...more]}
          paneWidth={chrome?.paneWidth}
          full={full}
          notice={notice?.text}
        />
      )}
      {/* The header shows a confirmation from lg up; a narrow pane (the Outlook task
          pane) shows it here. Screen readers hear it from the pane's live region. */}
      {notice?.tone === 'info' && (
        <p
          aria-hidden="true"
          className="flex-none bg-gray-50 dark:bg-gray-800 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 lg:hidden"
          data-testid="artifact-viewer-notice"
        >
          {notice.text}
        </p>
      )}
      {notice?.tone === 'error' && (
        <p
          role="alert"
          className="flex-none bg-red-50 dark:bg-red-900/30 px-3 py-1 text-xs text-red-800 dark:text-red-200"
        >
          {notice.text}
        </p>
      )}
      {/* Page mode has no pane live region: confirmations are said here. */}
      {isPage && (
        <span role="status" aria-live="polite" className="sr-only">
          {notice?.tone === 'info' ? notice.text : ''}
        </span>
      )}
      <SelectionScope
        enabled={selectable && Boolean(chrome?.onQuote)}
        onQuote={chrome?.onQuote}
        source={{ kind: 'artifact', id: artifact.id, name }}
        allowEdit
        // The artifact fills the pane and scrolls behind the (transparent) composer dock.
        dockClearance={chrome?.bottomPadding || 0}
        className="flex min-h-0 flex-1 flex-col bg-white dark:bg-gray-900"
        innerClassName={
          readingColumn ? 'mx-auto flex min-h-0 w-full max-w-[52rem] flex-1 flex-col' : ''
        }
        testId="artifact-viewer-body"
      >
        <ArtifactPreview
          key={artifact.id}
          artifact={artifact}
          getBlob={previewGetBlob}
          mode="fill"
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      </SelectionScope>
    </div>
  );
}
