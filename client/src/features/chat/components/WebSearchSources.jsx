import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { hostOf } from '../../../../../shared/webCitations.js';
import { webSearchLabel } from '../webSearch';
import {
  closeWebSources,
  highlightCitation,
  openWebSources,
  releaseCitation,
  useWebSourcesState
} from '../webSourcesStore';

/**
 * The web sources behind an answer: an entry under the answer — "Searched for
 * “…”" with the sites' icons — that opens the sources view, a side panel on
 * desktop and a bottom sheet on phones.
 *
 * The view lists what the answer cites, numbered like its inline badges, and
 * what the searches returned or read without being cited. Hovering or
 * focusing a card highlights the passages that cite it; hovering a badge in
 * the answer highlights its card (see `webSourcesStore`).
 *
 * @param {Object} props
 * @param {string} props.messageKey - The answer's id
 * @param {{queries: string[], sources: Object[]}} props.webSearch
 * @param {{cited: Object[], considered: Object[]}} props.citations - from `resolveCitations`
 */
function WebSearchSources({ messageKey, webSearch, citations }) {
  const { t } = useTranslation();
  const triggerRef = useRef(null);
  const { open, highlight } = useWebSourcesState();
  const isOpen = open?.messageKey === messageKey;

  const cited = citations?.cited || [];
  const considered = citations?.considered || [];
  const total = cited.length + considered.length;
  if (!webSearch || (total === 0 && !webSearch.queries?.length)) return null;

  const stack = [...cited, ...considered].slice(0, 4);
  const more = total - stack.length;

  return (
    <div className="mt-2">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? closeWebSources() : openWebSources(messageKey))}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        <Icon name="globe-alt" size="sm" className="shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="truncate">{webSearchLabel(t, webSearch)}</span>
        {stack.length > 0 && (
          <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
            {stack.map(source => (
              <SiteIcon
                key={source.url}
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
        <span className="sr-only">{t('webSources.sourcesCount', { count: total })}</span>
        <Icon name="chevron-right" size="sm" className="shrink-0 text-gray-400" />
      </button>
      {isOpen && (
        <WebSourcesPanel
          messageKey={messageKey}
          webSearch={webSearch}
          cited={cited}
          considered={considered}
          focus={open.focus}
          highlight={highlight?.messageKey === messageKey ? highlight.n : null}
          returnFocusRef={triggerRef}
        />
      )}
    </div>
  );
}

/**
 * The sources view. Rendered into `document.body`: fixed to the right edge
 * from `md` up, a bottom sheet with a scrim below it.
 */
function WebSourcesPanel({
  messageKey,
  webSearch,
  cited,
  considered,
  focus,
  highlight,
  returnFocusRef
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  // Focus moves into the view on open and back to the entry on close; Escape closes.
  useEffect(() => {
    const trigger = returnFocusRef.current;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = event => {
      if (event.key === 'Escape') closeWebSources();
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

  const queries = webSearch.queries || [];

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
        onClick={closeWebSources}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-labelledby={titleId}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-96 md:rounded-none md:border-t-0 md:border-s"
      >
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('webSources.title', 'Sources')}
            </h2>
            {queries.length > 0 && (
              <ul
                className="mt-1 flex flex-wrap gap-1"
                aria-label={t('webSources.queries', 'Searches')}
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
            onClick={closeWebSources}
            className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="md" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <SourceSection
            title={t('webSources.cited', 'Cited in this answer')}
            empty={t('webSources.noneCited', 'The answer cites none of the sources directly.')}
            sources={cited}
            messageKey={messageKey}
            highlight={highlight}
          />
          {considered.length > 0 && (
            <SourceSection
              title={t('webSources.considered', 'Also considered')}
              sources={considered}
              messageKey={messageKey}
              highlight={highlight}
            />
          )}
        </div>
      </aside>
    </>,
    document.body
  );
}

function SourceSection({ title, empty, sources, messageKey, highlight }) {
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
              key={source.url}
              source={source}
              messageKey={messageKey}
              active={Boolean(source.n) && source.n === highlight}
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
 * One source: favicon, site, title (opens the page in a new tab), snippet or
 * cited passage, date, and whether it was read.
 */
function SourceCard({ source, messageKey, active }) {
  const { t, i18n } = useTranslation();
  const host = source.host || hostOf(source.url);
  const date = source.publishedDate ? formatDate(source.publishedDate, i18n.language) : null;
  const excerpt = source.citedText || source.snippet;
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
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        {source.n && (
          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200">
            {source.n}
          </span>
        )}
        <SiteIcon source={source} className="h-4 w-4" />
        <span className="truncate">{host}</span>
        {date && (
          <>
            <span aria-hidden="true">·</span>
            <time dateTime={source.publishedDate} className="shrink-0">
              {date}
            </time>
          </>
        )}
      </div>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 flex items-start gap-1 text-sm font-medium text-gray-900 hover:text-indigo-600 hover:underline dark:text-gray-100 dark:hover:text-indigo-300"
      >
        <span className="line-clamp-2 break-words">{source.title || host || source.url}</span>
        <Icon name="external-link" size="xs" className="mt-0.5 shrink-0 text-gray-400" />
        <span className="sr-only">{t('webSources.opensInNewTab', '(opens in a new tab)')}</span>
      </a>
      {excerpt && (
        <p
          className={`mt-1 line-clamp-3 text-xs text-gray-600 dark:text-gray-400 ${
            source.citedText ? 'italic' : ''
          }`}
        >
          {source.citedText ? `“${source.citedText}”` : source.snippet}
        </p>
      )}
      <ReadStatus source={source} />
    </li>
  );
}

function ReadStatus({ source }) {
  const { t } = useTranslation();
  if (!source.read && !source.readFailed) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {source.read && (
        <span
          className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
          title={t('toolActivity.readTitle', 'The page was fetched and read')}
        >
          <Icon name="eye" size="xs" />
          {t('toolActivity.read', 'Read')}
        </span>
      )}
      {source.readFailed && (
        <span
          className="text-amber-600 dark:text-amber-400"
          title={t('toolActivity.readFailedTitle', 'The page could not be fetched')}
        >
          {t('toolActivity.readFailed', 'Not readable')}
        </span>
      )}
      {Number.isInteger(source.wordCount) && source.wordCount > 0 && (
        <span className="text-gray-500 dark:text-gray-400">
          {t('toolActivity.wordsRead', { count: source.wordCount })}
        </span>
      )}
      {source.truncated && (
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

/** Background colours for sites without a favicon, picked by host. */
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

function avatarColor(host) {
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * The site's favicon as the search provider returned it, else its initial on
 * a colour of its own. No favicon is fetched from a third-party service.
 */
function SiteIcon({ source, className = '' }) {
  const [failed, setFailed] = useState(false);
  const host = source.host || hostOf(source.url) || '?';
  const initial = useMemo(
    () =>
      host
        .replace(/^www\./, '')
        .charAt(0)
        .toUpperCase(),
    [host]
  );
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
        host
      )} ${className}`}
    >
      {initial}
    </span>
  );
}

export default WebSearchSources;
