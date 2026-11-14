// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
  hasHttpUrl,
  isSourceAttachSupported,
  openSource,
  sourceActionsOf
} from '../sources/sourceActions';
import {
  closeSources,
  highlightCitation,
  openSources,
  releaseCitation,
  sourcesOpener,
  useSourcesPanelHost,
  useSourcesState
} from '../sources/sourcesStore';
import {
  answerScopeLabel,
  fileTypeOf,
  matchesScope,
  originNounOf,
  originSummaryOf,
  scopeLabelOf,
  siteOf,
  sourceScopesOf
} from '../sources/sourcesView';
import ItemProvenance from '../../projects/components/ItemProvenance';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { useArtifactViewer } from '../contexts/ArtifactViewerContext';

// Loaded on demand: the preview pulls in pdf.js, which is a deliberately
// on-demand bundle chunk. Importing it statically here would put pdf.js in
// every chat page load, whether or not anyone opens a document.
const DocumentPreviewModal = lazy(
  () => import('../../documentPreview/components/DocumentPreviewModal')
);

const PASSAGE_TRUNCATE_LENGTH = 200;

/** Sources listed under the answer before the rest fold away. */
const ANSWER_LIST_LIMIT = 5;

/**
 * Everything an answer found — web pages, documents, records, whichever
 * integration found them (`shared/sources`) — behind one entry at the
 * answer's end, next to the badge that says what the answer is based on:
 * "N results" with the sources' icons. It opens the sources panel, a side
 * panel on desktop and a bottom sheet on phones. "Results", not "sources":
 * it counts everything found, and only what the answer cites is a source of
 * it (#3521).
 *
 * Above it, `CitedSources` lists what the answer cites like footnotes; an
 * answer that cites nothing lists what was read for it instead
 * (`ReadSources`).
 *
 * The panel lists what the answer cites, numbered like its inline badges —
 * or, when it cites nothing, what was read for it — and what was found
 * without being cited. A list with nothing in it is left out. Every card
 * offers the actions its source allows (`sources/sourceActions.js`).
 * Hovering or focusing a card highlights the passages that cite it; hovering
 * a badge in the answer highlights its card (see `sourcesStore`).
 *
 * Where the answer's integrations searched or whom they asked ("Searched in
 * Contracts", "Asked HR assistant") heads the panel, every card names the
 * scope its source was found in, and sources found in more than one scope can
 * be narrowed to one (#3056).
 *
 * While the answer streams the entry is hidden (`entryHidden`), so it does not
 * ride the growing text, but the component stays mounted: the inline badges
 * open the panel from the text, and a panel open when the answer completes
 * stays open.
 *
 * When the same answer is rendered more than once (AppChat's phone and
 * desktop layouts), only one copy renders the panel (`useSourcesPanelHost`).
 *
 * @param {Object} props
 * @param {string} props.messageKey - The answer's id
 * @param {{items: Object[], queries: string[]}} props.sources - The answer's source set
 * @param {{cited: Object[], read?: Object[], considered: Object[]}} props.citations - from
 *   `resolveCitations`
 * @param {Function} [props.onOpenInApp] - `(source, appId)`: open the source in a
 *   new chat of another app. Only surfaces with a router pass it (the Outlook
 *   task pane and the extension side panel have none, issue #2453).
 * @param {boolean} [props.entryHidden] - Render only the panel, not the entry
 */
function AnswerSources({
  messageKey,
  sources,
  citations,
  onOpenInApp = null,
  entryHidden = false
}) {
  const { t } = useTranslation();
  const triggerRef = useRef(null);
  const { open, highlight } = useSourcesState();
  const isOpen = open?.messageKey === messageKey;
  const isPanelHost = useSourcesPanelHost(messageKey);

  const cited = citations?.cited || [];
  const read = citations?.read || [];
  const considered = citations?.considered || [];
  const total = cited.length + read.length + considered.length;
  if (!sources || total === 0) return null;

  const stack = [...cited, ...read, ...considered].slice(0, 4);
  const highlighted = highlight?.messageKey === messageKey ? highlight.n : null;

  return (
    <>
      {!entryHidden && (
        <button
          ref={triggerRef}
          type="button"
          data-sources-entry-of={messageKey}
          onClick={() =>
            isOpen ? closeSources() : openSources(messageKey, null, { opener: triggerRef.current })
          }
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          className="group inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2.5 text-xs text-gray-700 shadow-xs hover:border-gray-400 hover:bg-gray-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-700 dark:focus-visible:ring-offset-gray-900"
        >
          <Icon
            name={sources.queries?.length ? 'search' : 'book-open'}
            size="sm"
            className="shrink-0 text-gray-500 dark:text-gray-400"
          />
          <span className="truncate">{t('sources.resultsCount', { count: total })}</span>
          {stack.length > 0 && (
            <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
              {stack.map(source => (
                <SourceIcon
                  key={source.id}
                  source={source}
                  className="h-4 w-4 ring-2 ring-white group-hover:ring-gray-50 dark:ring-gray-800 dark:group-hover:ring-gray-700"
                />
              ))}
            </span>
          )}
          <Icon
            name="chevron-right"
            size="sm"
            className="shrink-0 text-gray-500 dark:text-gray-400"
          />
        </button>
      )}
      {isOpen && isPanelHost && (
        <SourcesPanel
          messageKey={messageKey}
          sources={sources}
          cited={cited}
          read={read}
          considered={considered}
          focus={open.focus}
          highlight={highlighted}
          onOpenInApp={onOpenInApp}
        />
      )}
    </>
  );
}

/**
 * Whether an answer has anything for the entry to open: one source or more,
 * cited, read or only considered.
 *
 * @param {{cited: Object[], read?: Object[], considered: Object[]}|null} citations - from
 *   `resolveCitations`
 * @returns {boolean}
 */
export function hasAnswerResults(citations) {
  return Boolean(
    citations &&
    citations.cited.length + (citations.read?.length || 0) + citations.considered.length > 0
  );
}

/**
 * The sources an answer cites, at its end like footnotes: number, icon, title
 * and where it lives. The title opens a source with a link; the number (and
 * the title of one without a link) shows it in the sources panel, where its
 * passages and actions are. Long lists fold after a few entries. What was only
 * considered stays in the panel.
 *
 * @param {Object} props
 * @param {string} props.messageKey - The answer's id
 * @param {Object[]} props.sources - The cited sources, numbered (`resolveCitations().cited`)
 */
export function CitedSources({ messageKey, sources }) {
  const { t } = useTranslation();
  return (
    <AnswerSourceList
      messageKey={messageKey}
      sources={sources}
      title={t('sources.cited', 'Cited in this answer')}
    />
  );
}

/**
 * What was read for an answer that cites none of its sources, in the place of
 * the cited list: the pages and documents whose content the answer was
 * written from (`resolveCitations().read`; the server's producer marks a
 * read). Not numbered: the answer has no badges that point at them.
 *
 * @param {Object} props
 * @param {string} props.messageKey - The answer's id
 * @param {Object[]} props.sources - `resolveCitations().read`
 */
export function ReadSources({ messageKey, sources }) {
  const { t } = useTranslation();
  return (
    <AnswerSourceList
      messageKey={messageKey}
      sources={sources}
      title={t('sources.read', 'Read for this answer')}
    />
  );
}

/** A titled list of sources at the answer's end; nothing when it is empty. */
function AnswerSourceList({ messageKey, sources, title }) {
  const { t } = useTranslation();
  const headingId = useId();
  const { highlight: current } = useSourcesState();
  const [showAll, setShowAll] = useState(false);
  if (!sources?.length) return null;
  const highlight = current?.messageKey === messageKey ? current.n : null;
  const shown = showAll ? sources : sources.slice(0, ANSWER_LIST_LIMIT);
  const folded = sources.length - ANSWER_LIST_LIMIT;

  return (
    <div>
      <h4
        id={headingId}
        className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
      >
        {title}
      </h4>
      <ol aria-labelledby={headingId} className="space-y-0.5">
        {shown.map(source => (
          <AnswerSourceRow
            key={source.id}
            source={source}
            messageKey={messageKey}
            active={source.n != null && source.n === highlight}
          />
        ))}
      </ol>
      {folded > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(all => !all)}
          aria-expanded={showAll}
          className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
        >
          {showAll
            ? t('sources.showFewer', 'Show fewer')
            : t('sources.showMoreCited', { count: folded })}
          <Icon
            name="chevron-down"
            size="xs"
            className={`transition-transform ${showAll ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    </div>
  );
}

/**
 * One source under the answer. A cited one carries its number: hover and
 * focus highlight its badges, and the row opens the panel on its card. A
 * source that was only read has no badges and no number.
 */
function AnswerSourceRow({ source, messageKey, active }) {
  const { t } = useTranslation();
  const site = siteOf(source);
  const title = source.title || site || source.url || t('sources.untitled', 'Untitled');
  const where = site || source.fileName || '';
  const numbered = source.n != null;
  // Focus returns to the number (or to the title of a source without one)
  // when the panel closes, however it was opened.
  const openerRef = useRef(null);
  const showInPanel = () =>
    openSources(messageKey, numbered ? source.n : null, { opener: openerRef.current });
  const titleClass =
    'min-w-0 truncate text-left text-gray-800 hover:text-indigo-600 hover:underline dark:text-gray-200 dark:hover:text-indigo-300';
  const rowClass = '-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm';

  const body = (
    <>
      <SourceIcon source={source} className="h-4 w-4" />
      {hasHttpUrl(source) ? (
        // A real link (middle click, copy link address), but a plain click
        // opens it through the host (`openSource`), as on the card. Where the
        // host cannot open it, the panel shows the source and its actions.
        <a
          ref={numbered ? undefined : openerRef}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!openSource(source).ok) showInPanel();
          }}
          className={titleClass}
        >
          {title}
          <span className="sr-only"> {t('sources.opensInNewTab', '(opens in a new tab)')}</span>
        </a>
      ) : (
        <button
          ref={numbered ? undefined : openerRef}
          type="button"
          onClick={showInPanel}
          className={titleClass}
        >
          {title}
        </button>
      )}
      {where && where !== title && (
        <span className="max-w-[40%] shrink-0 truncate text-xs text-gray-500 dark:text-gray-400">
          {where}
        </span>
      )}
    </>
  );

  if (!numbered) return <li className={rowClass}>{body}</li>;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- mouse shortcut; the row's buttons serve the keyboard
    <li
      className={`${rowClass} cursor-pointer transition-colors ${
        active ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''
      }`}
      // The whole row opens the panel, a mouse shortcut for the number button
      // (keyboard users have the buttons). The link and buttons keep their own action.
      onClick={event => {
        if (!event.target.closest('a, button')) showInPanel();
      }}
      onMouseEnter={() => highlightCitation(messageKey, source.n)}
      onMouseLeave={() => releaseCitation(messageKey, source.n)}
      onFocus={() => highlightCitation(messageKey, source.n)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          releaseCitation(messageKey, source.n);
        }
      }}
    >
      <button
        ref={openerRef}
        type="button"
        onClick={showInPanel}
        className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 px-1 text-[0.625rem] font-semibold text-indigo-700 hover:bg-indigo-600 hover:text-white dark:bg-indigo-900/60 dark:text-indigo-200 dark:hover:bg-indigo-500"
        aria-label={t('sources.showInPanel', 'Show source {{n}} in the sources panel', {
          n: source.n
        })}
        title={t('sources.showInPanel', 'Show source {{n}} in the sources panel', {
          n: source.n
        })}
      >
        {source.n}
      </button>
      {body}
    </li>
  );
}

/**
 * Why a download or an attachment failed, as the one who refused said it: the
 * server's problem ("You are not allowed to use this integration.") or Outlook's
 * error ("AttachmentError (9000): …"). Null when neither named a reason.
 */
function failureReason(t, result) {
  const data = result?.error?.response?.data;
  if (data && typeof data === 'object' && !(data instanceof Blob) && (data.code || data.detail)) {
    return apiErrorMessage(result.error, t) || null;
  }
  return typeof result?.message === 'string' && result.message ? result.message : null;
}

/** The message shown when an action did not happen, by action and reason, with the cause when known. */
function describeFailure(t, action, result) {
  const message = failureMessage(t, action, result.reason);
  const reason = result.reason === 'failed' ? failureReason(t, result) : null;
  return reason ? `${message} ${reason}` : message;
}

/** The generic message for an action that did not happen, by action and reason. */
function failureMessage(t, action, reason) {
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

/** A CSS attribute selector value in double quotes. */
const attributeValue = value => String(value).replaceAll(/["\\]/g, String.raw`\$&`);

/**
 * Where focus goes when the sources panel closes: back to what opened it (an
 * inline badge, a number in the cited list, the entry). An inline badge the
 * answer's markup replaced since (it is rebuilt while the answer streams) is
 * found again by its number; else the answer's entry, if it is shown. Nothing
 * when none of them is on the page — focus is not moved somewhere unrelated.
 *
 * Only when focus was in the panel, which is gone now, so it fell to the
 * body. Focus the user moved on stays where it is: the entry they pressed to
 * close the side panel, the message box they were typing in when they pressed
 * Escape, the entry of another answer whose panel replaces this one.
 *
 * Candidates are tried in turn until one takes focus: a page can render the
 * same answer twice (AppChat keeps a phone and a desktop layout, one of them
 * `display: none`), and an element in the hidden copy does not take it.
 *
 * @param {string} messageKey
 */
function returnFocus(messageKey) {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const opener = sourcesOpener();
  const key = attributeValue(messageKey);
  const badges =
    opener?.n != null
      ? document.querySelectorAll(
          `[data-citations-of="${key}"] [data-source-citation="${opener.n}"]`
        )
      : [];
  const entries = document.querySelectorAll(`[data-sources-entry-of="${key}"]`);
  for (const element of [opener?.element, ...badges, ...entries]) {
    if (!element?.isConnected) continue;
    element.focus({ preventScroll: true });
    if (document.activeElement === element) return;
  }
}

/**
 * The sources panel. Rendered into `document.body`: fixed to the right edge
 * from `md` up, a bottom sheet with a scrim below it.
 *
 * The side panel is not modal: the answer stays usable next to it, and its
 * badges keep highlighting the cards. The sheet covers the chat, so it is
 * modal and keeps keyboard focus inside until it is closed — except while one
 * of its dialogs (preview, details, app picker) is open on top of it.
 *
 * Its lists: what the answer cites, what was read for an answer that cites
 * nothing, and the rest it found — each only when it holds something.
 */
function SourcesPanel({
  messageKey,
  sources,
  cited,
  read,
  considered,
  focus,
  highlight,
  onOpenInApp
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // The scope the lists are narrowed to (`ref.scope`), or null for all of them.
  const [scopeFilter, setScopeFilter] = useState(null);
  // The chat's workspace pane, where a preview opens beside the answer.
  const workspace = useArtifactViewer();
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
  // Focus goes back to what opened the panel (see `returnFocus`), so the trap
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

  // Focus moves into the panel on open and back to what opened it on close;
  // Escape closes it (a dialog on top closes first).
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = event => {
      if (event.key === 'Escape' && !dialogRef.current) closeSources();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnFocus(messageKey);
    };
  }, [messageKey]);

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
        const focus = selectPreviewPassages(source.passages, passage);
        // Next to the chat the source opens in the workspace pane, read-only;
        // where there is no split (narrow, embedded) the preview dialog stays.
        if (workspace?.sourcesInPane && workspace.openSource(source, focus)) {
          closeSources();
          return;
        }
        setDialog({ type: 'preview', source, ...focus });
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

      if (!result.ok) setError(describeFailure(t, action, result));
      else if (action === 'copyLink') setNotice(t('sources.linkCopied', 'Link copied.'));
      else if (action === 'attach') {
        setNotice(
          t('sources.attachedToMail', 'Added to your email as {{filename}}.', {
            filename: result.filename
          })
        );
      }
    },
    [t, workspace]
  );

  const closeDialog = useCallback(() => setDialog(null), []);
  const queries = sources.queries || [];
  const answerScopes = sources.scopes || [];
  const cardProps = { messageKey, highlight, host, attachEnabled, onAction: runAction };
  // The scopes the sources were found in; with more than one, the lists can
  // show one at a time. A filter whose scope is gone shows everything.
  const foundIn = useMemo(
    () => sourceScopesOf([...cited, ...read, ...considered]),
    [cited, read, considered]
  );
  // How many cards each origin holds; with two or more, the header says so.
  const originSummary = useMemo(
    () => originSummaryOf(t, [...cited, ...read, ...considered]),
    [t, cited, read, considered]
  );
  const shownScope = foundIn.some(scope => scope.id === scopeFilter) ? scopeFilter : null;
  const shownCited = cited.filter(source => matchesScope(source, shownScope));
  const shownRead = read.filter(source => matchesScope(source, shownScope));
  const shownConsidered = considered.filter(source => matchesScope(source, shownScope));

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
            {originSummary.length > 1 && (
              // Static text, not controls: how many cards each origin holds.
              <ul
                aria-label={t('sources.originSummary')}
                className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-gray-600 dark:text-gray-300"
              >
                {originSummary.map((entry, index) => (
                  <li key={entry.key}>
                    {index > 0 && (
                      <span aria-hidden="true" className="me-1.5">
                        ·
                      </span>
                    )}
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      {entry.noun}
                    </span>{' '}
                    {entry.count}
                  </li>
                ))}
              </ul>
            )}
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
            {answerScopes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
                {answerScopes.map(scope => (
                  <li
                    key={`${scope.integrationId}:${scope.id}`}
                    className="flex items-center gap-1"
                  >
                    <Icon
                      name={scope.action === 'ask' ? 'chat-bubble-left-right' : 'squares-2x2'}
                      size="xs"
                      className="shrink-0 text-gray-500 dark:text-gray-400"
                    />
                    <span className="break-words">
                      {answerScopeLabel(t, scope, i18n?.language)}
                    </span>
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
          {foundIn.length > 1 && (
            <ScopeFilter scopes={foundIn} selected={shownScope} onSelect={setScopeFilter} />
          )}
          {/* No list without sources: an answer that cites nothing gets no
              empty "Cited in this answer", but what was read for it. */}
          {shownCited.length > 0 && (
            <SourceSection
              title={t('sources.cited', 'Cited in this answer')}
              sources={shownCited}
              {...cardProps}
            />
          )}
          {shownRead.length > 0 && (
            <SourceSection
              title={t('sources.read', 'Read for this answer')}
              sources={shownRead}
              {...cardProps}
            />
          )}
          {shownConsidered.length > 0 && (
            <SourceSection
              title={
                shownCited.length || shownRead.length
                  ? t('sources.considered', 'Also considered')
                  : t('sources.consideredOnly', 'Considered')
              }
              sources={shownConsidered}
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

/** A dismissible notice or error at the top of the panel. */
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

/**
 * Narrows the panel to the sources found in one scope ("All", "Contracts 4",
 * "HR policies 2"), for an answer whose sources come from several (#3056).
 *
 * @param {Object} props
 * @param {Array<{id: string, label: string, count: number}>} props.scopes - `sourceScopesOf`
 * @param {string|null} props.selected - the scope shown, null for all
 * @param {(scopeId: string|null) => void} props.onSelect
 */
function ScopeFilter({ scopes, selected, onSelect }) {
  const { t } = useTranslation();
  const total = scopes.reduce((sum, scope) => sum + scope.count, 0);
  const options = [
    { id: null, label: t('sources.scopeFilterAll', 'All'), count: total },
    ...scopes
  ];
  return (
    <fieldset className="mb-3 flex min-w-0 flex-wrap gap-1 border-0 p-0">
      <legend className="sr-only">
        {t('sources.scopeFilter', 'Filter by where the sources were found')}
      </legend>
      {options.map(option => {
        const active = option.id === selected;
        return (
          <button
            key={option.id ?? ''}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(option.id)}
            className={`inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              active
                ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-900/40 dark:text-indigo-200'
                : 'border-gray-500 text-gray-600 hover:bg-gray-50 dark:border-gray-500 dark:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            <span className="truncate">{option.label}</span>
            <span className="shrink-0 text-gray-500 dark:text-gray-400">{option.count}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * A titled list of source cards ("Cited in this answer", "Read for this
 * answer", "Also considered"). Only rendered with sources in it.
 */
function SourceSection({ title, sources, highlight, ...cardProps }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {title} <span className="font-normal">({sources.length})</span>
      </h3>
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
    </section>
  );
}

/** A date in the user's language, or null when it does not parse. */
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
  const scopeLabel = scopeLabelOf(source);
  const originNoun = originNounOf(t, source.origin);
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
            {source.n && (
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 px-1 text-[0.625rem] font-semibold text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200">
                {source.n}
              </span>
            )}
            <SourceIcon source={source} className="h-4 w-4" />
            {/* Where it comes from, as text: the leading glyph already says page,
                file or record. A source without an origin shows none. */}
            {originNoun && (
              <span className="font-medium text-gray-700 dark:text-gray-300">{originNoun}</span>
            )}
            {originNoun && site && originNoun !== site && <span aria-hidden="true">·</span>}
            {site && originNoun !== site && <span className="min-w-0 break-words">{site}</span>}
            {date && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={source.publishedDate} className="shrink-0">
                  {date}
                </time>
              </>
            )}
            {/* Where it was found: the search profile, or another integration
                scope, by its display name (#3056). */}
            {scopeLabel && (
              <span
                className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-gray-100 px-1.5 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                title={t('sources.foundIn', 'Found in {{scope}}', { scope: scopeLabel })}
              >
                <Icon name="squares-2x2" size="xs" className="shrink-0" />
                <span className="truncate" aria-hidden="true">
                  {scopeLabel}
                </span>
                <span className="sr-only">
                  {t('sources.foundIn', 'Found in {{scope}}', { scope: scopeLabel })}
                </span>
              </span>
            )}
          </div>
          {actions.includes('open') ? (
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
              <Icon name="external-link" size="xs" className="mt-0.5 shrink-0 text-gray-500" />
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
          {/* Project documents: "Uploaded", "Picked from SharePoint · text
              taken 12 Oct 2026", "Linked" (#1036). Nothing for other sources. */}
          <ItemProvenance provenance={source.provenance} className="mt-0.5" />
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

/**
 * One passage of a source, clamped until expanded, with "Show in document" when it can be
 * previewed.
 */
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
            {expanded ? t('chat.sourcePassage.less', 'less') : t('chat.sourcePassage.more', 'more')}
          </button>
        )}
      </p>
      {onShow && (
        <button
          type="button"
          onClick={onShow}
          className="shrink-0 self-start rounded-sm p-1 text-gray-500 hover:bg-gray-100 hover:text-indigo-600 dark:hover:bg-gray-700 dark:hover:text-indigo-400"
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

/** Whether the page or document was read, and how much of it. */
function ReadStatus({ source }) {
  const { t } = useTranslation();
  const read = source.read;
  if (!read) return null;
  const isDocument = source.kind === 'document';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {read.ok ? (
        <span
          className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400"
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
          className="text-amber-700 dark:text-amber-400"
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

/** A stable color for a letter avatar, picked by hashing `key`. */
function avatarColor(key) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Colour of a document's icon by its file type. */
function documentColor(type) {
  if (type === 'pdf') return 'text-red-500';
  if (['word', 'doc', 'docx'].includes(type)) return 'text-blue-500';
  if (['excel', 'xls', 'xlsx', 'csv'].includes(type)) return 'text-emerald-700';
  if (['powerpoint', 'ppt', 'pptx'].includes(type)) return 'text-orange-500';
  return 'text-gray-500 dark:text-gray-400';
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
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white text-gray-500 dark:bg-gray-800 ${className}`}
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
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-[0.5625rem] font-semibold text-white ${avatarColor(
        site
      )} ${className}`}
    >
      {initial}
    </span>
  );
}

export default AnswerSources;
