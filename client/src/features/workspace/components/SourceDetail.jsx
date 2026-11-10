// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { ICON_BUTTON } from '../../../shared/utils/buttonTokens';
import { fetchIntegrationFileContent } from '../../../api/endpoints/integrationFiles';
import {
  copySourceLink,
  downloadSource,
  hasHttpUrl,
  openSource
} from '../../chat/sources/sourceActions';
import { selectPreviewPassages } from '../../documentPreview/utils/passageSelection';
import { isOriginalDiscarded, previewFormatFor } from '../../documentPreview/utils/textPreview';
import TextPassageViewer from '../../documentPreview/components/TextPassageViewer';
import PaneHeader from './PaneHeader';
import SelectionScope from './SelectionScope';

// pdf.js is large: loaded when a PDF source is first shown.
const PdfPassageViewer = lazy(() => import('../../documentPreview/components/PdfPassageViewer'));

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.2;

/**
 * A cited source in the workspace pane, read-only (concept §3, §5): the PDF
 * rendition (or the text of a text-only document) with its passages
 * highlighted, passage navigation in the header's version slot, Download,
 * "Open in source system" in Share's place, and a small zoom control floating
 * at the bottom right of the PDF. A source without a document to show (a web
 * page) shows its passages and snippet as text.
 *
 * `DocumentPreviewModal` stays for project items and for surfaces without a
 * split (the sheet fallback).
 *
 * @param {Object} props
 * @param {Object} props.source - `shared/sources/source.js`
 * @param {{ passages?: string[], initialPassageIndex?: number }} [props.focus] - Passages to
 *   highlight and the one to start at; by default all of the source's own.
 * @param {Object} props.chrome - What the pane gives every detail view.
 */
export default function SourceDetail({ source, focus = null, chrome }) {
  const { t } = useTranslation();
  const hasRef = typeof source?.ref?.id === 'string' && Boolean(source.ref.id);
  const derived = useMemo(() => selectPreviewPassages(source?.passages || []), [source]);
  const passages = focus?.passages || derived.passages;
  const [mode, setMode] = useState(() => previewFormatFor(source));
  const [modeFor, setModeFor] = useState(source);
  if (modeFor !== source) {
    setModeFor(source);
    setMode(previewFormatFor(source));
  }
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [selectedPassage, setSelectedPassage] = useState(focus?.initialPassageIndex ?? -1);
  const [viewerState, setViewerState] = useState({
    loading: true,
    numPages: 0,
    totalMatches: 0,
    currentMatch: -1
  });
  const [notice, setNotice] = useState(null);
  const controlRef = useRef(null);

  useEffect(() => {
    setSelectedPassage(focus?.initialPassageIndex ?? -1);
  }, [source?.id, focus]);

  useEffect(() => {
    if (!hasRef) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    setData(null);
    setLoadError(null);
    fetchIntegrationFileContent({
      integration: source.provider,
      ref: source.ref,
      format: mode,
      responseType: mode === 'text' ? 'text' : 'arraybuffer',
      signal: controller.signal
    })
      .then(response => {
        if (!cancelled) setData(mode === 'text' ? String(response.data ?? '') : response.data);
      })
      .catch(err => {
        if (cancelled || err.name === 'AbortError' || err.code === 'ERR_CANCELED') return;
        if (mode === 'pdf' && isOriginalDiscarded(err)) setMode('text');
        else setLoadError(err.message || 'error');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [source, mode, hasRef, retry]);

  const activePassages = useMemo(
    () =>
      selectedPassage >= 0 && passages[selectedPassage] ? [passages[selectedPassage]] : passages,
    [passages, selectedPassage]
  );
  const handleStateChange = useCallback(state => setViewerState(state), []);

  const say = (tone, text) => {
    setNotice({ tone, text });
    chrome?.announce?.(text);
  };

  const download = async () => {
    const result = await downloadSource(source);
    if (!result.ok) {
      say(
        'error',
        t('sources.downloadFailed', 'The document could not be downloaded. Please try again.')
      );
    }
  };

  const { totalMatches, currentMatch } = viewerState;
  const isText = mode === 'text';
  const title = source?.title || source?.fileName || t('documentPreview.title', 'Document preview');

  const passageNav =
    hasRef && passages.length > 0 ? (
      <div
        className="ml-1 hidden items-center gap-0.5 sm:inline-flex"
        role="group"
        aria-label={t('workspace.passages', 'Passages')}
        data-testid="source-passage-nav"
      >
        <span className="px-1 text-xs tabular-nums text-gray-600 dark:text-gray-300">
          {totalMatches > 0
            ? t('workspace.passagePosition', 'Passage {{current}}/{{total}}', {
                current: currentMatch + 1,
                total: totalMatches
              })
            : viewerState.loading
              ? ''
              : t('documentPreview.noMatches', 'Passage not found')}
        </span>
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={totalMatches === 0}
          onClick={() => controlRef.current?.previousMatch()}
          aria-label={t('documentPreview.previousMatch', 'Previous highlight')}
          title={t('documentPreview.previousMatch', 'Previous highlight')}
        >
          <Icon name="chevron-up" size="sm" />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={totalMatches === 0}
          onClick={() => controlRef.current?.nextMatch()}
          aria-label={t('documentPreview.nextMatch', 'Next highlight')}
          title={t('documentPreview.nextMatch', 'Next highlight')}
        >
          <Icon name="chevron-down" size="sm" />
        </button>
      </div>
    ) : null;

  // Enter / Shift+Enter step through the highlights, where Enter does nothing else.
  const onBodyKeyDown = event => {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (
      target?.isContentEditable ||
      ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName)
    ) {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) controlRef.current?.previousMatch();
    else controlRef.current?.nextMatch();
  };

  let body;
  if (!hasRef) {
    body = (
      <div className="space-y-3 p-4 text-sm text-gray-800 dark:text-gray-100">
        {source?.snippet && <p>{source.snippet}</p>}
        {passages.map((passage, index) => (
          <blockquote
            key={index}
            className="rounded-md border-l-2 border-amber-400 bg-amber-50 px-3 py-2 dark:bg-amber-900/20"
          >
            {passage}
          </blockquote>
        ))}
        {!source?.snippet && passages.length === 0 && (
          <p className="text-gray-600 dark:text-gray-300">
            {t(
              'workspace.sourceNoPreview',
              'There is no preview of this source. Open it in its system.'
            )}
          </p>
        )}
      </div>
    );
  } else if (loadError) {
    body = (
      <div
        className="m-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-900/20"
        role="alert"
      >
        <p className="font-medium text-red-800 dark:text-red-200">
          {t('workspace.previewFailed', "Couldn't load preview")}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="text-indigo-700 underline dark:text-indigo-300"
            onClick={() => setRetry(value => value + 1)}
          >
            {t('app.retry', 'Retry')}
          </button>
          <button
            type="button"
            className="text-indigo-700 underline dark:text-indigo-300"
            onClick={download}
          >
            {t('workspace.downloadOriginal', 'Download original')}
          </button>
        </div>
      </div>
    );
  } else if (data === null) {
    body = (
      <div
        className="space-y-2 p-6"
        role="status"
        aria-label={t('documentPreview.loading', 'Loading document…')}
      >
        {[0, 1, 2, 3].map(line => (
          <div
            key={line}
            className="h-3 rounded bg-gray-100 dark:bg-gray-800 motion-safe:animate-pulse"
            style={{ width: `${90 - line * 12}%` }}
          />
        ))}
      </div>
    );
  } else if (isText) {
    body = (
      <TextPassageViewer
        text={data}
        passages={activePassages}
        controlRef={controlRef}
        onStateChange={handleStateChange}
      />
    );
  } else {
    body = (
      <Suspense fallback={null}>
        <PdfPassageViewer
          data={data}
          passages={activePassages}
          scale={scale}
          controlRef={controlRef}
          onStateChange={handleStateChange}
        />
      </Suspense>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="source-detail">
      <PaneHeader
        title={title}
        badge={t('workspace.sourceBadge', 'Source')}
        headingId={chrome?.headingId}
        headingRef={chrome?.headingRef}
        back={chrome?.back}
        switcher={chrome?.switcher}
        center={passageNav}
        download={
          hasRef
            ? {
                key: 'download',
                icon: 'download',
                label: t('sources.download', 'Download'),
                onClick: download,
                testId: 'source-download'
              }
            : null
        }
        share={
          hasHttpUrl(source)
            ? {
                key: 'open',
                icon: 'external-link',
                label: t('workspace.openInSourceSystem', 'Open in source system'),
                onClick: () => {
                  if (!openSource(source).ok) {
                    say('error', t('workspace.openFailed', 'The link could not be opened.'));
                  }
                },
                testId: 'source-open'
              }
            : null
        }
        expand={chrome?.expand}
        close={chrome?.close}
        more={[
          ...(hasHttpUrl(source)
            ? [
                {
                  key: 'copy-link',
                  icon: 'copy',
                  label: t('sources.copyLink', 'Copy link'),
                  onClick: async () => {
                    const result = await copySourceLink(source);
                    say(
                      result.ok ? 'info' : 'error',
                      result.ok
                        ? t('sources.linkCopied', 'Link copied.')
                        : t('chatArtifacts.copyFailed', 'The content could not be copied.')
                    );
                  }
                }
              ]
            : []),
          ...(chrome?.more || [])
        ]}
        paneWidth={chrome?.paneWidth}
        full={chrome?.full}
        notice={notice?.tone === 'info' ? notice.text : null}
      />
      {notice?.tone === 'error' && (
        <p
          role="alert"
          className="flex-none bg-red-50 px-3 py-1 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200"
        >
          {notice.text}
        </p>
      )}
      {isText && hasRef && data !== null && (
        <p className="flex-none px-4 pt-2 text-xs text-gray-600 dark:text-gray-300">
          {t('documentPreview.textOnly', 'Extracted text (the original is not kept)')}
        </p>
      )}
      {passages.length > 1 && hasRef && (
        <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
          <span className="shrink-0 text-xs text-gray-600 dark:text-gray-300">
            {t('documentPreview.highlight', 'Highlight')}
          </span>
          {[-1, ...passages.map((_, index) => index)].map(index => (
            <button
              key={index}
              type="button"
              aria-pressed={selectedPassage === index}
              onClick={() => setSelectedPassage(index)}
              className={`h-7 shrink-0 rounded px-2 text-xs ${
                selectedPassage === index
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
              }`}
            >
              {index === -1 ? t('documentPreview.allPassages', 'All') : index + 1}
            </button>
          ))}
        </div>
      )}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Enter steps highlights; the controls stay the way to do it */}
      <div className="relative flex min-h-0 flex-1 flex-col" onKeyDown={onBodyKeyDown}>
        <SelectionScope
          enabled
          onQuote={chrome?.onQuote}
          source={{ kind: 'source', id: source?.id, name: title }}
          bottomPadding={chrome?.bottomPadding || 0}
          className="flex min-h-0 flex-1 flex-col overflow-auto"
          testId="source-body"
        >
          {body}
        </SelectionScope>
        {hasRef && !isText && data !== null && !loadError && (
          <div
            className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-0.5 rounded-full border border-gray-200 bg-white/95 p-0.5 shadow-md backdrop-blur dark:border-gray-700 dark:bg-gray-800/95"
            style={chrome?.bottomPadding ? { bottom: chrome.bottomPadding + 12 } : undefined}
            role="group"
            aria-label={t('workspace.zoom', 'Zoom')}
          >
            <button
              type="button"
              className={`${ICON_BUTTON} rounded-full`}
              onClick={() =>
                setScale(s => Math.max(MIN_SCALE, Number((s - SCALE_STEP).toFixed(2))))
              }
              aria-label={t('documentPreview.zoomOut', 'Zoom out')}
              title={t('documentPreview.zoomOut', 'Zoom out')}
            >
              <span aria-hidden="true" className="text-base leading-none">
                −
              </span>
            </button>
            <span className="w-10 text-center text-xs tabular-nums text-gray-600 dark:text-gray-300">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className={`${ICON_BUTTON} rounded-full`}
              onClick={() =>
                setScale(s => Math.min(MAX_SCALE, Number((s + SCALE_STEP).toFixed(2))))
              }
              aria-label={t('documentPreview.zoomIn', 'Zoom in')}
              title={t('documentPreview.zoomIn', 'Zoom in')}
            >
              <span aria-hidden="true" className="text-base leading-none">
                +
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
