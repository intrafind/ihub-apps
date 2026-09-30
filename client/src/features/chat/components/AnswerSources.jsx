import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import useFocusTrap from '../../../shared/hooks/useFocusTrap';
import useMediaQuery from '../../../shared/hooks/useMediaQuery';
import AppSelectionModal from '../../workflows/components/AppSelectionModal';
import {
  hasPassageText,
  selectPreviewPassages
} from '../../documentPreview/utils/passageSelection';
import SourceDetailsModal from './SourceDetailsModal';
import {
  attachSourceToMail,
  canAttachSource,
  copySourceLink,
  downloadSource,
  isSourceAttachSupported,
  openSource,
  sourceActionsOf
} from '../sources/sourceActions';
import {
  closeSources,
  highlightCitation,
  openSources,
  releaseCitation,
  useSourcesState
} from '../sources/sourcesStore';
import { fileTypeOf, siteOf, sourcesLabel } from '../sources/sourcesView';

// Loaded on demand: the preview pulls in pdf.js, which is a deliberately
// on-demand bundle chunk. Importing it statically here would put pdf.js in
// every chat page load, whether or not anyone opens a document.
const DocumentPreviewModal = lazy(
  () => import('../../documentPreview/components/DocumentPreviewModal')
);

const PASSAGE_TRUNCATE_LENGTH = 200;

/**
 * Everything an answer found — web pages, documents, records, whichever
 * integration found them (`shared/sources`) — behind one entry under the
 * answer: "Searched for “…”" or "N sources", with the sources' icons. It opens
 * the sources panel, a side panel on desktop and a bottom sheet on phones.
 *
 * The panel lists what the answer cites, numbered like its inline badges, and
 * what was found without being cited. Every card offers the actions its
 * source allows (`sources/sourceActions.js`). Hovering or focusing a card
 * highlights the passages that cite it; hovering a badge in the answer
 * highlights its card (see `sourcesStore`).
 *
 * @param {Object} props
 * @param {string} props.messageKey - The answer's id
 * @param {{items: Object[], queries: string[]}} props.sources - The answer's source set
 * @param {{cited: Object[], considered: Object[]}} props.citations - from `resolveCitations`
 * @param {Function} [props.onOpenInApp] - `(source, appId)`: open the source in a
 *   new chat of another app. Only surfaces with a router pass it (the Outlook
 *   task pane and the extension side panel have none, issue #2453).
 */
function AnswerSources({ messageKey, sources, citations, onOpenInApp = null }) {
  const { t } = useTranslation();
  const triggerRef = useRef(null);
  const { open, highlight } = useSourcesState();
  const isOpen = open?.messageKey === messageKey;

  const cited = citations?.cited || [];
  const considered = citations?.considered || [];
  const total = cited.length + considered.length;
  if (!sources || (total === 0 && !sources.queries?.length)) return null;

  const stack = [...cited, ...considered].slice(0, 4);
  const more = total - stack.length;

  return (
    <div className="mt-2">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? closeSources() : openSources(messageKey))}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        <Icon
          name={sources.queries?.length ? 'search' : 'book-open'}
          size="sm"
          className="shrink-0 text-gray-400 dark:text-gray-500"
        />
        <span className="truncate">{sourcesLabel(t, sources)}</span>
        {stack.length > 0 && (
          <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
            {stack.map(source => (
              <SourceIcon
                key={source.id}
                source={source}
                className="h-4 w-4 ring-2 ring-white dark:ring-gray-800"
              />
            ))}
          </span>
        )}
        {more > 0 && (
          <span className="shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true">
            +{more}
          </span>
        )}
        <span className="sr-only">{t('sources.sourcesCount', { count: total })}</span>
        <Icon name="chevron-right" size="sm" className="shrink-0 text-gray-400" />
      </button>
      {isOpen && (
        <SourcesPanel
          messageKey={messageKey}
          sources={sources}
          cited={cited}
          considered={considered}
          focus={open.focus}
          highlight={highlight?.messageKey === messageKey ? highlight.n : null}
          returnFocusRef={triggerRef}
          onOpenInApp={onOpenInApp}
        />
      )}
    </div>
  );
}

/** The message shown when an action did not happen, by action and reason. */
function describeFailure(t, action, reason) {
  if (action === 'download') {
    return reason === 'unavailable'
      ? t('sources.downloadUnavailable', 'This document cannot be downloaded from here.')
      : t('sources.downloadFailed', 'The document could not be downloaded. Please try again.');
  }
  if (action === 'open') {
    return reason === 'unavailable'
      ? t('sources.openUnavailable', 'This source has no link to open.')
      : t(
          'sources.openBlocked',
          'The link could not be opened — this window blocked it. Try opening it from iHub in your browser.'
        );
  }
  if (action === 'attach') {
    if (reason === 'notComposing') {
      return t(
        'sources.attachNeedsDraft',
        'Open a new email or a reply first, then add the document from there.'
      );
    }
    if (reason === 'tooLarge') {
      return t(
        'sources.attachTooLarge',
        'This document is too large to attach. Download it instead.'
      );
    }
    return reason === 'unavailable'
      ? t('sources.attachUnavailable', 'This document cannot be attached from here.')
      : t('sources.attachFailed', 'The document could not be attached to your email.');
  }
  if (action === 'copyLink') return t('sources.copyFailed', 'The link could not be copied.');
  return t('sources.actionFailed', 'That action could not be completed.');
}

/**
 * The sources panel. Rendered into `document.body`: fixed to the right edge
 * from `md` up, a bottom sheet with a scrim below it.
 *
 * The side panel is not modal: the answer stays usable next to it, and its
 * badges keep highlighting the cards. The sheet covers the chat, so it is
 * modal and keeps keyboard focus inside until it is closed — except while one
 * of its dialogs (preview, details, app picker) is open on top of it.
 */
function SourcesPanel({
  messageKey,
  sources,
  cited,
  considered,
  focus,
  highlight,
  returnFocusRef,
  onOpenInApp
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // { type: 'preview'|'details'|'app', source, passages?, initialPassageIndex? }
  const [dialog, setDialog] = useState(null);
  const dialogRef = useRef(null);
  dialogRef.current = dialog;
  // Why an action did not happen, or a confirmation of one whose result is
  // not visible here ("Add to email", "Copy link").
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // `md`, where the sheet becomes the side panel (as in AppSidebar).
  const isSidePanel = useMediaQuery('(min-width: 768px)');
  // Focus goes back to the entry below (not to where it was), so the trap
  // does not restore it.
  useFocusTrap(panelRef, {
    isActive: !isSidePanel && !dialog,
    initialFocusRef: closeRef,
    returnFocusOnDeactivate: false
  });

  // "Add to email" exists in the Outlook task pane only, and works while a
  // mail is being written; which item is open is re-read on every change.
  const attachSupported = isSourceAttachSupported();
  const [attachEnabled, setAttachEnabled] = useState(canAttachSource);
  useEffect(() => {
    if (!attachSupported) return undefined;
    const handler = () => setAttachEnabled(canAttachSource());
    document.addEventListener('ihub:itemchanged', handler);
    return () => document.removeEventListener('ihub:itemchanged', handler);
  }, [attachSupported]);
  const host = useMemo(
    () => ({ attachSupported, canOpenInApp: typeof onOpenInApp === 'function' }),
    [attachSupported, onOpenInApp]
  );

  // Focus moves into the panel on open and back to the entry on close;
  // Escape closes it (a dialog on top closes first).
  useEffect(() => {
    const trigger = returnFocusRef.current;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = event => {
      if (event.key === 'Escape' && !dialogRef.current) closeSources();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);

  // Scroll to the card a clicked badge points at.
  useEffect(() => {
    if (!focus) return;
    const card = panelRef.current?.querySelector(`[data-source-number="${focus}"]`);
    card?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  const runAction = useCallback(
    async (action, source, passage = null) => {
      setError(null);
      setNotice(null);
      if (action === 'preview') {
        setDialog({ type: 'preview', source, ...selectPreviewPassages(source.passages, passage) });
        return;
      }
      if (action === 'details' || action === 'openInApp') {
        setDialog({ type: action === 'details' ? 'details' : 'app', source });
        return;
      }
      let result;
      if (action === 'open') result = openSource(source);
      else if (action === 'download') result = await downloadSource(source);
      else if (action === 'copyLink') result = await copySourceLink(source);
      else if (action === 'attach') result = await attachSourceToMail(source);
      else result = { ok: false, reason: 'unsupported' };

      if (!result.ok) setError(describeFailure(t, action, result.reason));
      else if (action === 'copyLink') setNotice(t('sources.linkCopied', 'Link copied.'));
      else if (action === 'attach') {
        setNotice(
          t('sources.attachedToMail', 'Added to your email as {{filename}}.', {
            filename: result.filename
          })
        );
      }
    },
    [t]
  );

  const closeDialog = useCallback(() => setDialog(null), []);
  const queries = sources.queries || [];
  const cardProps = { messageKey, highlight, host, attachEnabled, onAction: runAction };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
        onClick={closeSources}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal={isSidePanel ? undefined : 'true'}
        aria-labelledby={titleId}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-96 md:rounded-none md:border-t-0 md:border-s"
      >
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('sources.title', 'Sources')}
            </h2>
            {queries.length > 0 && (
              <ul
                className="mt-1 flex flex-wrap gap-1"
                aria-label={t('sources.queries', 'Searches')}
              >
                {queries.map(query => (
                  <li
                    key={query}
                    className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  >
                    <Icon name="search" size="xs" className="shrink-0" />
                    <span className="break-all">{query}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={closeSources}
            className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="md" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <Banner tone="error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}
          {notice && (
            <Banner tone="notice" onDismiss={() => setNotice(null)}>
              {notice}
            </Banner>
          )}
          <SourceSection
            title={t('sources.cited', 'Cited in this answer')}
            empty={t('sources.noneCited', 'The answer cites none of the sources directly.')}
            sources={cited}
            {...cardProps}
          />
          {considered.length > 0 && (
            <SourceSection
              title={t('sources.considered', 'Also considered')}
              sources={considered}
              {...cardProps}
            />
          )}
        </div>
      </aside>
      {dialog?.type === 'preview' && (
        <Suspense fallback={null}>
          <DocumentPreviewModal
            source={dialog.source}
            title={dialog.source.title}
            passages={dialog.passages}
            initialPassageIndex={dialog.initialPassageIndex}
            onClose={closeDialog}
          />
        </Suspense>
      )}
      {dialog?.type === 'details' && (
        <SourceDetailsModal source={dialog.source} onClose={closeDialog} />
      )}
      <AppSelectionModal
        isOpen={dialog?.type === 'app'}
        onClose={closeDialog}
        onSelect={app => {
          onOpenInApp?.(dialog.source, app.id);
          closeDialog();
        }}
      />
    </>,
    document.body
  );
}

function Banner({ tone, onDismiss, children }) {
  const { t } = useTranslation();
  const error = tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`mb-3 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
        error
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300'
          : 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300'
      }`}
    >
      <span className="flex-1">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-sm p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
        aria-label={t('common.close', 'Close')}
      >
        <Icon name="x" size="xs" />
      </button>
    </div>
  );
}

function SourceSection({ title, empty, sources, highlight, ...cardProps }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {title} <span className="font-normal">({sources.length})</span>
      </h3>
      {sources.length === 0 ? (
        empty && <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p>
      ) : (
        <ol className="space-y-2">
          {sources.map(source => (
            <SourceCard
              key={source.id}
              source={source}
              active={Boolean(source.n) && source.n === highlight}
              {...cardProps}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function formatDate(value, language) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(language || undefined, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * One source: its number when the answer cites it, its icon and where it
 * lives, its title (a link when it has one), an excerpt or cited passage, its
 * passages, whether it was read, and its actions.
 */
function SourceCard({ source, messageKey, active, host, attachEnabled, onAction }) {
  const { t, i18n } = useTranslation();
  const [showPassages, setShowPassages] = useState(false);
  const actions = sourceActionsOf(source, host);
  const site = siteOf(source);
  const date = source.publishedDate ? formatDate(source.publishedDate, i18n.language) : null;
  const passages = source.passages || [];
  const canPreview = actions.includes('preview');
  const title = source.title || site || source.url || t('sources.untitled', 'Untitled');
  const hover = source.n
    ? {
        onMouseEnter: () => highlightCitation(messageKey, source.n),
        onMouseLeave: () => releaseCitation(messageKey, source.n),
        onFocus: () => highlightCitation(messageKey, source.n),
        onBlur: event => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            releaseCitation(messageKey, source.n);
          }
        }
      }
    : {};

  return (
    <li
      data-source-number={source.n || undefined}
      className={`rounded-lg border p-3 transition-colors ${
        active
          ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-900/30'
          : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
      }`}
      {...hover}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            {source.n && (
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200">
                {source.n}
              </span>
            )}
            <SourceIcon source={source} className="h-4 w-4" />
            {site && <span className="truncate">{site}</span>}
            {date && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={source.publishedDate} className="shrink-0">
                  {date}
                </time>
              </>
            )}
          </div>
          {source.url ? (
            // A real link (middle click, copy link address), but a plain click
            // opens it through the host (`openSource`): in the Outlook task pane
            // and the extension side panel a new tab is a silent no-op.
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={event => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onAction('open', source);
              }}
              title={t('sources.openExternal', 'Open in browser')}
              className="mt-1 flex items-start gap-1 text-sm font-medium text-gray-900 hover:text-indigo-600 hover:underline dark:text-gray-100 dark:hover:text-indigo-300"
            >
              <span className="line-clamp-2 break-words">{title}</span>
              <Icon name="external-link" size="xs" className="mt-0.5 shrink-0 text-gray-400" />
              <span className="sr-only">{t('sources.opensInNewTab', '(opens in a new tab)')}</span>
            </a>
          ) : (
            <p className="mt-1 line-clamp-2 break-words text-sm font-medium text-gray-900 dark:text-gray-100">
              {title}
            </p>
          )}
          {source.fileName && source.fileName !== title && (
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
              {source.fileName}
            </p>
          )}
          {passages.length > 0 ? (
            <p className="mt-1 line-clamp-3 text-xs italic text-gray-600 dark:text-gray-400">
              “{passages[0].text}”
            </p>
          ) : (
            source.snippet && (
              <p className="mt-1 line-clamp-3 text-xs text-gray-600 dark:text-gray-400">
                {source.snippet}
              </p>
            )
          )}
          {(passages.length > 1 || (passages.length === 1 && canPreview)) && (
            <button
              type="button"
              onClick={() => setShowPassages(shown => !shown)}
              aria-expanded={showPassages}
              className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
            >
              {t('sources.passages', { count: passages.length })}
              <Icon
                name="chevron-down"
                size="xs"
                className={`transition-transform ${showPassages ? 'rotate-180' : ''}`}
              />
            </button>
          )}
          {showPassages && (
            <ul className="mt-1.5 space-y-1.5 border-t border-gray-100 pt-1.5 dark:border-gray-700">
              {passages.map(passage => (
                <PassageItem
                  key={passage.marker || passage.text}
                  passage={passage}
                  onShow={
                    canPreview && hasPassageText(passage)
                      ? () => onAction('preview', source, passage)
                      : null
                  }
                />
              ))}
            </ul>
          )}
          <ReadStatus source={source} />
        </div>
        <ActionsMenu
          source={source}
          // Opening is the title's own click.
          actions={actions.filter(action => action !== 'open')}
          attachEnabled={attachEnabled}
          onAction={onAction}
        />
      </div>
    </li>
  );
}

function PassageItem({ passage, onShow }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const long = passage.text.length > PASSAGE_TRUNCATE_LENGTH;
  return (
    <li className="flex gap-2 text-xs text-gray-600 dark:text-gray-400">
      <p className="flex-1 whitespace-pre-wrap leading-relaxed">
        {long && !expanded ? `${passage.text.slice(0, PASSAGE_TRUNCATE_LENGTH)}… ` : passage.text}
        {long && (
          <button
            type="button"
            onClick={() => setExpanded(shown => !shown)}
            className="ml-0.5 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {expanded ? t('common.showLess', 'less') : t('common.showMore', 'more')}
          </button>
        )}
      </p>
      {onShow && (
        <button
          type="button"
          onClick={onShow}
          className="shrink-0 self-start rounded-sm p-1 text-gray-400 hover:bg-gray-100 hover:text-indigo-600 dark:hover:bg-gray-700 dark:hover:text-indigo-400"
          title={t('sources.showInDocument', 'Show this passage in the document')}
          aria-label={t('sources.showInDocument', 'Show this passage in the document')}
        >
          <Icon name="magnifying-glass" size="sm" />
        </button>
      )}
    </li>
  );
}

/** Icon and label of each action in the menu. */
const MENU_ACTIONS = {
  preview: { icon: 'eye', key: 'sources.preview', label: 'Preview (PDF)' },
  download: { icon: 'download', key: 'sources.download', label: 'Download' },
  attach: { icon: 'paper-clip', key: 'sources.attachToMail', label: 'Add to email' },
  openInApp: { icon: 'chat-bubble-left-right', key: 'sources.openInApp', label: 'Open in App' },
  details: { icon: 'information-circle', key: 'sources.details', label: 'Details' },
  copyLink: { icon: 'link', key: 'sources.copyLink', label: 'Copy link' }
};

/**
 * The source's other actions. "Add to email" is shown disabled, with the
 * reason, while no mail is being written — a received message has nothing to
 * attach to, which the entry says rather than leaving it to be discovered.
 */
function ActionsMenu({ source, actions, attachEnabled, onAction }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = event => {
      if (event.key === 'Escape') {
        // Closes the menu, not the panel around it.
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!actions.length) return null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(shown => !shown)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-sm p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        title={t('sources.actions', 'Actions')}
        aria-label={t('sources.actionsFor', 'Actions for {{title}}', {
          title: source.title || siteOf(source)
        })}
      >
        <Icon name="ellipsis-vertical" size="sm" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-[170px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {actions.map(action => {
            const item = MENU_ACTIONS[action];
            const disabled = action === 'attach' && !attachEnabled;
            return (
              <button
                key={action}
                type="button"
                role="menuitem"
                disabled={disabled}
                title={
                  disabled
                    ? t(
                        'sources.attachNeedsDraft',
                        'Open a new email or a reply first, then add the document from there.'
                      )
                    : undefined
                }
                onClick={() => {
                  setOpen(false);
                  onAction(action, source);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:text-gray-200 dark:hover:bg-gray-700 dark:disabled:hover:bg-transparent"
              >
                <Icon name={item.icon} size="sm" />
                {t(item.key, item.label)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReadStatus({ source }) {
  const { t } = useTranslation();
  const read = source.read;
  if (!read) return null;
  const isDocument = source.kind === 'document';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {read.ok ? (
        <span
          className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
          title={
            isDocument
              ? t('toolActivity.readDocumentTitle', 'The document was read')
              : t('toolActivity.readTitle', 'The page was fetched and read')
          }
        >
          <Icon name="eye" size="xs" />
          {t('toolActivity.read', 'Read')}
        </span>
      ) : (
        <span
          className="text-amber-600 dark:text-amber-400"
          title={t('toolActivity.readFailedTitle', 'The page could not be fetched')}
        >
          {t('toolActivity.readFailed', 'Not readable')}
        </span>
      )}
      {read.words > 0 && (
        <span className="text-gray-500 dark:text-gray-400">
          {t('toolActivity.wordsRead', { count: read.words })}
        </span>
      )}
      {read.truncated && (
        <span
          className="text-gray-500 dark:text-gray-400"
          title={t('toolActivity.truncatedTitle', 'The page is longer than what was read')}
        >
          {t('toolActivity.truncated', 'truncated')}
        </span>
      )}
    </div>
  );
}

/** Background colours for sites without a favicon, picked by site. */
const AVATAR_COLORS = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-orange-500'
];

function avatarColor(key) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Colour of a document's icon by its file type. */
function documentColor(type) {
  if (type === 'pdf') return 'text-red-500';
  if (['word', 'doc', 'docx'].includes(type)) return 'text-blue-500';
  if (['excel', 'xls', 'xlsx', 'csv'].includes(type)) return 'text-emerald-600';
  if (['powerpoint', 'ppt', 'pptx'].includes(type)) return 'text-orange-500';
  return 'text-gray-400 dark:text-gray-500';
}

/**
 * A page's favicon as the search provider returned it, else its initial on a
 * colour of its own (no favicon is fetched from a third-party service); a
 * document's file icon, coloured by its type; a record's icon.
 */
function SourceIcon({ source, className = '' }) {
  const [failed, setFailed] = useState(false);
  const site = siteOf(source) || source.provider || '?';
  const initial = useMemo(
    () =>
      site
        .replace(/^www\./, '')
        .charAt(0)
        .toUpperCase(),
    [site]
  );
  if (source.kind === 'document') {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white dark:bg-gray-800 ${className}`}
      >
        <Icon name="document-text" size="xs" className={documentColor(fileTypeOf(source))} />
      </span>
    );
  }
  if (source.kind === 'item') {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white text-gray-400 dark:bg-gray-800 ${className}`}
      >
        <Icon name="cube" size="xs" />
      </span>
    );
  }
  if (source.favicon && !failed) {
    return (
      <img
        src={source.favicon}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full bg-white object-contain ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white ${avatarColor(
        site
      )} ${className}`}
    >
      {initial}
    </span>
  );
}

export default AnswerSources;
