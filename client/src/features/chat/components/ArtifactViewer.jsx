// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useFocusTrap } from '../../../shared/hooks/useFocusTrap';
import { saveBlobAs } from '../../../utils/externalNavigation';
import ArtifactPreview from './ArtifactPreview';
import {
  artifactDisplayName,
  codeLanguageOf,
  isTextArtifact,
  previewTypeOf,
  saveName
} from '../utils/artifactFiles';

/** Preview types that have a rendered view as well as a source view. */
const HAS_CODE_VIEW = ['html', 'svg', 'csv', 'ipynb'];
/** Preview types that can be exported as Markdown / HTML / PDF text documents. */
const EXPORTABLE = ['markdown', 'json', 'code', 'csv', 'ipynb'];

const ICON_BUTTON =
  'inline-flex h-9 w-9 flex-none items-center justify-center rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50';
const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none disabled:opacity-50';

/** A markdown fence long enough to hold `text` whatever backticks it contains. */
function fenced(text, language) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}\n`;
}

/**
 * A popup menu hung off a toolbar button. Open state lives in the viewer so
 * its Escape handling can close the menu before it closes the viewer.
 */
function ToolbarMenu({
  id,
  open,
  onToggle,
  label,
  trigger,
  className = '',
  align = 'left',
  children
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() =>
      menuRef.current?.querySelector('[role="menuitem"]')?.focus()
    );
    const onPointerDown = event => {
      if (!menuRef.current?.parentElement?.contains(event.target)) onToggle(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onToggle]);

  const onKeyDown = event => {
    const items = Array.from(
      menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || []
    );
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      onToggle(false);
    }
  };

  return (
    <div className={`relative ${className}`}>
      {trigger({
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        onClick: () => onToggle(!open)
      })}
      {open && (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={`absolute top-full z-10 mt-1 min-w-[14rem] max-w-[calc(100vw-1rem)] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The immersive view of one artifact: a slim toolbar and the artifact filling
 * the rest of the window, edge to edge.
 *
 * HTML is rendered by {@link ArtifactPreview} in `<iframe sandbox="allow-scripts">`
 * with the preview CSP — here as everywhere. Browser full screen is requested on
 * this component's own container, never inside the frame, so the frame needs no
 * `allow-same-origin`, `allow-popups` or `allow="fullscreen"`.
 *
 * Three shapes:
 * - `mode="dialog"` (default): a modal dialog over the page, with focus trap,
 *   Esc to close and focus returned to what opened it.
 * - With `splitAvailable`, the toolbar gets a "Chat" toggle: the viewer then
 *   takes the right part of the window and the chat stays usable beside it.
 * - `mode="page"`: the viewer is the whole page (standalone and shared links);
 *   no close button. `embed` drops the toolbar too.
 *
 * @param {Object} props
 * @param {Object} props.artifact - The descriptor shown: `{ id, name?, kind?, mimeType, bytes?, data? }`.
 * @param {Object[]} [props.artifacts] - All artifacts to step through (prev/next).
 * @param {(artifact: Object) => void} [props.onSelect] - Called with the artifact stepped to.
 * @param {() => void} [props.onClose] - Close (dialog mode).
 * @param {(artifact: Object) => Promise<Blob>} props.getBlob - The bytes of an artifact.
 * @param {(artifact: Object) => void} [props.onShare] - Adds Share. Absent where sharing is off.
 * @param {(artifact: Object) => void} [props.onShowInFiles] - Adds "Show in files".
 * @param {(artifact: Object) => void} [props.onOpenInNewTab] - Adds "Open in new tab".
 * @param {boolean} [props.splitAvailable] - Offer the "Chat" toggle (a chat sits behind the viewer).
 * @param {'dialog'|'page'} [props.mode]
 * @param {boolean} [props.embed] - Page mode without the toolbar.
 * @param {import('react').ReactNode} [props.toolbarExtra] - Extra content at the start of the right side
 *   of the toolbar (page mode: badges and links).
 */
export default function ArtifactViewer({
  artifact,
  artifacts,
  onSelect,
  onClose,
  getBlob,
  onShare = null,
  onShowInFiles = null,
  onOpenInNewTab = null,
  splitAvailable = false,
  mode = 'dialog',
  embed = false,
  toolbarExtra = null
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const containerRef = useRef(null);
  const closeRef = useRef(null);
  const isDialog = mode === 'dialog';
  const [viewMode, setViewMode] = useState('preview');
  const [split, setSplit] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);
  const [notice, setNotice] = useState(null);
  const openMenuRef = useRef(null);
  openMenuRef.current = openMenu;

  const list =
    Array.isArray(artifacts) && artifacts.some(a => a.id === artifact.id) ? artifacts : [artifact];
  const index = Math.max(
    0,
    list.findIndex(a => a.id === artifact.id)
  );
  const name = artifactDisplayName(artifact);
  const type = previewTypeOf(artifact);
  const hasCodeView = HAS_CODE_VIEW.includes(type);
  const isText = isTextArtifact(artifact);
  const canExport = EXPORTABLE.includes(type) || type === 'html';
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled !== false;
  const trapped = isDialog && !split;

  // The element that opened the viewer gets focus back when it closes.
  const openerRef = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useFocusTrap(containerRef, { isActive: trapped, returnFocusOnDeactivate: false });

  useEffect(() => {
    if (!isDialog) return undefined;
    const opener = openerRef.current;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      queueMicrotask(() => {
        if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      });
    };
  }, [isDialog]);

  // Another artifact starts in its rendered view.
  useEffect(() => {
    setViewMode('preview');
    setNotice(null);
  }, [artifact.id]);

  // Esc closes a menu first, then the viewer. Registered while capturing so a
  // panel underneath (which listens for Esc too) does not also close. A dialog
  // above the viewer (the share dialog) keeps its own Esc.
  useEffect(() => {
    if (!isDialog) return undefined;
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      if (openMenuRef.current) {
        event.stopPropagation();
        setOpenMenu(null);
        return;
      }
      const active = document.activeElement;
      if (
        active &&
        !containerRef.current?.contains(active) &&
        active.closest?.('[role="dialog"]')
      ) {
        return;
      }
      event.stopPropagation();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isDialog, onClose]);

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

  const step = delta => {
    if (list.length < 2) return;
    onSelect?.(list[(index + delta + list.length) % list.length]);
  };

  const closeMenu = () => setOpenMenu(null);

  const readText = async () => (await getBlob(artifact)).text();

  const download = async () => {
    closeMenu();
    try {
      const blob = await getBlob(artifact);
      if (!saveBlobAs(blob, saveName(name))) throw new Error('save');
    } catch {
      setNotice({
        tone: 'error',
        text: t('chatArtifacts.downloadFailed', 'The download failed. Please try again.')
      });
    }
  };

  const copy = async () => {
    closeMenu();
    try {
      await navigator.clipboard.writeText(await readText());
      setNotice({ tone: 'info', text: t('chatArtifacts.copied', 'Copied to the clipboard.') });
    } catch {
      setNotice({
        tone: 'error',
        text: t('chatArtifacts.copyFailed', 'The content could not be copied.')
      });
    }
  };

  const exportAs = async format => {
    closeMenu();
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
      setNotice({
        tone: 'error',
        text: t('chatArtifacts.exportFailed', 'The export failed. Please try again.')
      });
    }
  };

  const toggleFullscreen = async () => {
    closeMenu();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen?.();
    } catch {
      // The browser refused (no user gesture, policy): nothing to do.
    }
  };

  const toggleCode = () => {
    closeMenu();
    setViewMode(mode_ => (mode_ === 'code' ? 'preview' : 'code'));
  };

  const onToolbarKeyDown = event => {
    if (event.target.closest('[role="menu"]')) return;
    if (event.key === 'ArrowLeft' && list.length > 1) {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight' && list.length > 1) {
      event.preventDefault();
      step(1);
    }
  };

  const showingCode = viewMode === 'code';
  const codeLabel = showingCode
    ? t('chatArtifacts.showPreview', 'Show preview')
    : t('chatArtifacts.showCode', 'Show code');
  const fullscreenLabel = fullscreen
    ? t('chatArtifacts.exitPresent', 'Exit full screen')
    : t('chatArtifacts.present', 'Full screen');
  const chatLabel = split
    ? t('chatArtifacts.hideChat', 'Hide chat')
    : t('chatArtifacts.showChat', 'Show chat');

  const menuItem = (key, icon, label, onClick, extra = {}) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={MENU_ITEM}
      onClick={onClick}
      {...extra}
    >
      <Icon name={icon} size="sm" />
      {label}
    </button>
  );

  const body = (
    <div
      className="flex min-h-0 flex-1 flex-col bg-white dark:bg-gray-900"
      data-testid="artifact-viewer-body"
    >
      <ArtifactPreview
        key={artifact.id}
        artifact={artifact}
        getBlob={previewGetBlob}
        mode="fill"
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />
    </div>
  );

  const containerClass = isDialog
    ? split
      ? 'fixed inset-y-0 right-0 z-[60] w-full md:w-[60%] border-l border-gray-300 dark:border-gray-600 shadow-2xl'
      : 'fixed inset-0 z-[60]'
    : 'flex h-dvh w-full';

  return (
    <div
      ref={containerRef}
      {...(isDialog
        ? {
            role: 'dialog',
            'aria-modal': split ? 'false' : 'true',
            'aria-label': t('chatArtifacts.viewerLabel', 'Artifact: {{name}}', { name })
          }
        : {})}
      data-testid="artifact-viewer"
      className={`${containerClass} flex-col bg-white dark:bg-gray-900 flex`}
    >
      {!embed && (
        <header
          className="flex h-12 flex-none items-center gap-1 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2"
          data-testid="artifact-viewer-toolbar"
          onKeyDown={onToolbarKeyDown}
        >
          <ToolbarMenu
            id={`${baseId}-menu`}
            open={openMenu === 'file'}
            onToggle={open => setOpenMenu(open ? 'file' : null)}
            label={t('chatArtifacts.fileMenu', 'File actions')}
            className="min-w-0"
            trigger={props => (
              <button
                type="button"
                {...props}
                data-testid="artifact-viewer-name"
                title={name}
                className="inline-flex h-9 max-w-[14rem] sm:max-w-xs md:max-w-md items-center gap-1 rounded-md px-2 text-sm font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <span className="truncate">{name}</span>
                <Icon name="chevron-down" size="xs" className="flex-none" />
              </button>
            )}
          >
            {hasCodeView && menuItem('code', showingCode ? 'eye' : 'code', codeLabel, toggleCode)}
            {isText && menuItem('copy', 'copy', t('chatArtifacts.copy', 'Copy'), copy)}
            {onShare &&
              menuItem('share', 'share', t('chatArtifacts.share', 'Share'), () => {
                closeMenu();
                onShare(artifact);
              })}
            {canExport && (
              <>
                {(type === 'html' || EXPORTABLE.includes(type)) &&
                  menuItem(
                    'export-html',
                    'document-text',
                    t('chatArtifacts.exportHtml', 'Export as HTML'),
                    () => exportAs('html')
                  )}
                {EXPORTABLE.includes(type) &&
                  menuItem(
                    'export-md',
                    'document-text',
                    t('chatArtifacts.exportMarkdown', 'Export as Markdown'),
                    () => exportAs('markdown')
                  )}
                {EXPORTABLE.includes(type) &&
                  menuItem(
                    'export-pdf',
                    'document-text',
                    t('chatArtifacts.exportPdf', 'Export as PDF'),
                    () => exportAs('pdf')
                  )}
              </>
            )}
            {menuItem('download', 'download', t('chatArtifacts.download', 'Download'), download)}
            {onShowInFiles &&
              menuItem(
                'files',
                'archive-box',
                t('chatArtifacts.showInFiles', 'Show in files'),
                () => {
                  closeMenu();
                  onShowInFiles(artifact);
                }
              )}
            {onOpenInNewTab &&
              menuItem(
                'newtab',
                'external-link',
                t('chatArtifacts.openInNewTab', 'Open in new tab'),
                () => {
                  closeMenu();
                  onOpenInNewTab(artifact);
                }
              )}
            {canFullscreen &&
              menuItem('fullscreen', 'arrows-pointing-out', fullscreenLabel, toggleFullscreen)}
            {list.length > 1 &&
              menuItem(
                'prev',
                'chevron-left',
                t('chatArtifacts.previous', 'Previous artifact'),
                () => {
                  closeMenu();
                  step(-1);
                }
              )}
            {list.length > 1 &&
              menuItem('next', 'chevron-right', t('chatArtifacts.next', 'Next artifact'), () => {
                closeMenu();
                step(1);
              })}
          </ToolbarMenu>

          {list.length > 1 && (
            <div className="hidden sm:flex items-center">
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => step(-1)}
                aria-label={t('chatArtifacts.previous', 'Previous artifact')}
                title={t('chatArtifacts.previous', 'Previous artifact')}
              >
                <Icon name="chevron-left" size="sm" />
              </button>
              <span
                className="px-1 text-xs tabular-nums text-gray-600 dark:text-gray-300"
                data-testid="artifact-viewer-position"
              >
                {t('chatArtifacts.position', '{{current}} of {{total}}', {
                  current: index + 1,
                  total: list.length
                })}
              </span>
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => step(1)}
                aria-label={t('chatArtifacts.next', 'Next artifact')}
                title={t('chatArtifacts.next', 'Next artifact')}
              >
                <Icon name="chevron-right" size="sm" />
              </button>
            </div>
          )}

          <div className="ml-auto flex min-w-0 items-center gap-1">
            <span
              role="status"
              aria-live="polite"
              className="hidden min-w-0 truncate px-2 text-xs md:block empty:hidden"
            >
              {notice && (
                <span
                  className={
                    notice.tone === 'error'
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-gray-600 dark:text-gray-300'
                  }
                >
                  {notice.text}
                </span>
              )}
            </span>
            {toolbarExtra}
            {hasCodeView && (
              <button
                type="button"
                className={`${ICON_BUTTON} hidden sm:inline-flex ${showingCode ? 'bg-gray-100 dark:bg-gray-700' : ''}`}
                onClick={toggleCode}
                aria-pressed={showingCode}
                aria-label={codeLabel}
                title={codeLabel}
                data-testid="artifact-viewer-code-toggle"
              >
                <Icon name={showingCode ? 'eye' : 'code'} size="sm" />
              </button>
            )}
            {isText && (
              <button
                type="button"
                className={`${ICON_BUTTON} hidden sm:inline-flex`}
                onClick={copy}
                aria-label={t('chatArtifacts.copy', 'Copy')}
                title={t('chatArtifacts.copy', 'Copy')}
                data-testid="artifact-viewer-copy"
              >
                <Icon name="copy" size="sm" />
              </button>
            )}
            {isDialog && splitAvailable && (
              <button
                type="button"
                className={`${ICON_BUTTON} hidden md:inline-flex ${split ? 'bg-gray-100 dark:bg-gray-700' : ''}`}
                onClick={() => setSplit(value => !value)}
                aria-pressed={split}
                aria-label={chatLabel}
                title={chatLabel}
                data-testid="artifact-viewer-chat-toggle"
              >
                <Icon name="chat-bubble-left-right" size="sm" />
              </button>
            )}
            {onShare && (
              <button
                type="button"
                className={`${ICON_BUTTON} hidden sm:inline-flex`}
                onClick={() => onShare(artifact)}
                aria-label={t('chatArtifacts.share', 'Share')}
                title={t('chatArtifacts.share', 'Share')}
                data-testid="artifact-viewer-share"
              >
                <Icon name="share" size="sm" />
              </button>
            )}
            {canExport && (
              <ToolbarMenu
                id={`${baseId}-export`}
                open={openMenu === 'export'}
                onToggle={open => setOpenMenu(open ? 'export' : null)}
                label={t('chatArtifacts.exportMenu', 'Export')}
                align="right"
                className="hidden sm:block"
                trigger={props => (
                  <button
                    type="button"
                    {...props}
                    className={`${ICON_BUTTON} w-auto gap-1 px-2 text-sm`}
                    aria-label={t('chatArtifacts.exportMenu', 'Export')}
                    title={t('chatArtifacts.exportMenu', 'Export')}
                    data-testid="artifact-viewer-export"
                  >
                    <Icon name="document-text" size="sm" />
                    <Icon name="chevron-down" size="xs" />
                  </button>
                )}
              >
                {menuItem(
                  'e-html',
                  'document-text',
                  t('chatArtifacts.exportHtml', 'Export as HTML'),
                  () => exportAs('html')
                )}
                {EXPORTABLE.includes(type) &&
                  menuItem(
                    'e-md',
                    'document-text',
                    t('chatArtifacts.exportMarkdown', 'Export as Markdown'),
                    () => exportAs('markdown')
                  )}
                {EXPORTABLE.includes(type) &&
                  menuItem(
                    'e-pdf',
                    'document-text',
                    t('chatArtifacts.exportPdf', 'Export as PDF'),
                    () => exportAs('pdf')
                  )}
              </ToolbarMenu>
            )}
            <button
              type="button"
              className={`${ICON_BUTTON} hidden sm:inline-flex`}
              onClick={download}
              aria-label={t('chatArtifacts.downloadNamed', 'Download {{name}}', { name })}
              title={t('chatArtifacts.download', 'Download')}
              data-testid="artifact-viewer-download"
            >
              <Icon name="download" size="sm" />
            </button>
            {canFullscreen && (
              <button
                type="button"
                className={`${ICON_BUTTON} hidden sm:inline-flex`}
                onClick={toggleFullscreen}
                aria-pressed={fullscreen}
                aria-label={fullscreenLabel}
                title={fullscreenLabel}
                data-testid="artifact-viewer-fullscreen"
              >
                <Icon name={fullscreen ? 'arrows-pointing-in' : 'arrows-pointing-out'} size="sm" />
              </button>
            )}
            {isDialog && (
              <button
                ref={closeRef}
                type="button"
                className={ICON_BUTTON}
                onClick={() => onClose?.()}
                aria-label={t('chatArtifacts.closeViewer', 'Close artifact')}
                title={t('chatArtifacts.closeViewer', 'Close artifact')}
                data-testid="artifact-viewer-close"
              >
                <Icon name="x" size="md" />
              </button>
            )}
          </div>
        </header>
      )}
      {body}
    </div>
  );
}
