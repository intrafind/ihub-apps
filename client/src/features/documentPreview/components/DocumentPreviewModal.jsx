// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSourceContent } from '../../../api/endpoints/sources';
import { downloadSource } from '../../chat/sources/sourceActions';
import PdfPassageViewer from './PdfPassageViewer';
import TextPassageViewer from './TextPassageViewer';
import { isOriginalDiscarded, previewFormatFor } from '../utils/textPreview';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.2;

/**
 * In-app PDF preview of a source, with the passages its producer returned
 * highlighted in the document text.
 *
 * The PDF is the provider's PDF rendition (`GET /api/sources/:provider/content
 * ?format=pdf`, `routes/sources.js`). A document kept as text only — a
 * project item, whose original is discarded (`410 ORIGINAL_DISCARDED`) — is
 * shown in text mode instead (`format=text`, `TextPassageViewer`), with the
 * same passage highlighting and navigation. Fetching it as an ArrayBuffer (instead
 * of handing the URL to pdf.js) keeps the request on the app's authenticated
 * `apiClient` path, which also carries the Bearer token the Outlook task pane
 * and the extension side panel sign requests with.
 *
 * @param {Object} props
 * @param {{provider: string, ref: {id: string, scope?: string}, fileName?: string}} props.source -
 *   the source to preview (`shared/sources/source.js`)
 * @param {string} [props.title] document title for the header.
 * @param {string[]} props.passages passage texts to highlight. Expected to be
 *   pre-filtered to passages that actually carry text, so `initialPassageIndex`
 *   indexes the same list that is rendered.
 * @param {number} [props.initialPassageIndex] index into `passages` to focus,
 *   or `-1`/undefined to highlight all of them.
 * @param {Function} props.onClose
 */
function DocumentPreviewModal({ source, title, passages = [], initialPassageIndex = -1, onClose }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // 'pdf' or 'text'; a PDF request that answers "original discarded" switches
  // to text. Re-derived when another source is shown.
  const [mode, setMode] = useState(() => previewFormatFor(source));
  const [modeFor, setModeFor] = useState(source);
  if (modeFor !== source) {
    setModeFor(source);
    setMode(previewFormatFor(source));
  }
  const isText = mode === 'text';
  const [scale, setScale] = useState(1.2);
  const [selectedPassage, setSelectedPassage] = useState(initialPassageIndex);
  const [viewerState, setViewerState] = useState({
    loading: true,
    numPages: 0,
    totalMatches: 0,
    currentMatch: -1
  });
  const controlRef = useRef(null);

  // Fetch the generated PDF, or the text of a text-only document.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setData(null);
    setLoadError(null);

    fetchSourceContent({
      source,
      format: mode,
      responseType: mode === 'text' ? 'text' : 'arraybuffer',
      signal: controller.signal
    })
      .then(response => {
        if (cancelled) return;
        setData(mode === 'text' ? String(response.data ?? '') : response.data);
      })
      .catch(err => {
        if (cancelled || err.name === 'AbortError' || err.code === 'ERR_CANCELED') return;
        if (mode === 'pdf' && isOriginalDiscarded(err)) setMode('text');
        else setLoadError(err.message);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [source, mode]);

  // Close on Escape, navigate matches with Enter / Shift+Enter.
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Enter') return;
      // Enter must still activate whatever control has focus — the toolbar
      // buttons, the download link and the passage chips all rely on it. Only
      // take Enter over when focus is not on something that handles it.
      const target = e.target;
      if (
        target?.isContentEditable ||
        ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName)
      ) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) controlRef.current?.previousMatch();
      else controlRef.current?.nextMatch();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const activePassages = useMemo(
    () =>
      selectedPassage >= 0 && passages[selectedPassage] ? [passages[selectedPassage]] : passages,
    [passages, selectedPassage]
  );

  const handleStateChange = useCallback(state => setViewerState(state), []);

  // Downloading through an authenticated blob fetch rather than a link to the
  // API URL: a plain anchor carries no Bearer token in the embedded hosts, and
  // its `target="_blank"` is popup-blocked there anyway (issue #2453).
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      // The original, or — for a document of which only the text is kept —
      // the text as a `.txt` (the same rule as the panel's Download).
      const result = await downloadSource(source);
      if (!result.ok) {
        setDownloadError(
          t('sources.downloadFailed', 'The document could not be downloaded. Please try again.')
        );
      }
    } finally {
      setDownloading(false);
    }
  }, [source, t]);

  const { loading, numPages, totalMatches, currentMatch } = viewerState;
  const passageCount = passages.length;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex flex-col bg-black/60"
      onClick={onClose}
    >
      <div
        role="presentation"
        className="relative m-2 sm:m-6 flex flex-col flex-1 min-h-0 bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {title || t('documentPreview.title', 'Document preview')}
            </p>
            {downloadError ? (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {downloadError}
              </p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {isText
                  ? t('documentPreview.textOnly', 'Extracted text (the original is not kept)')
                  : loading
                    ? t('documentPreview.loading', 'Loading document…')
                    : t('documentPreview.pageCount', '{{count}} pages', { count: numPages })}
              </p>
            )}
          </div>

          {/* Match navigation */}
          {!loading && passageCount > 0 && (
            <div className="flex items-center gap-1">
              <span
                className={`text-xs px-2 py-1 rounded ${
                  totalMatches > 0
                    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                }`}
              >
                {totalMatches > 0
                  ? t('documentPreview.matchPosition', '{{current}} of {{total}}', {
                      current: currentMatch + 1,
                      total: totalMatches
                    })
                  : t('documentPreview.noMatches', 'Passage not found')}
              </span>
              <button
                onClick={() => controlRef.current?.previousMatch()}
                disabled={totalMatches === 0}
                className="p-1.5 rounded-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40"
                title={t('documentPreview.previousMatch', 'Previous highlight')}
                aria-label={t('documentPreview.previousMatch', 'Previous highlight')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 15l7-7 7 7"
                  />
                </svg>
              </button>
              <button
                onClick={() => controlRef.current?.nextMatch()}
                disabled={totalMatches === 0}
                className="p-1.5 rounded-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40"
                title={t('documentPreview.nextMatch', 'Next highlight')}
                aria-label={t('documentPreview.nextMatch', 'Next highlight')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
            </div>
          )}

          {/* Zoom */}
          <div className={isText ? 'hidden' : 'hidden sm:flex items-center gap-1'}>
            <button
              onClick={() =>
                setScale(s => Math.max(MIN_SCALE, Number((s - SCALE_STEP).toFixed(2))))
              }
              className="p-1.5 rounded-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
              title={t('documentPreview.zoomOut', 'Zoom out')}
              aria-label={t('documentPreview.zoomOut', 'Zoom out')}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400 w-10 text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() =>
                setScale(s => Math.min(MAX_SCALE, Number((s + SCALE_STEP).toFixed(2))))
              }
              className="p-1.5 rounded-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
              title={t('documentPreview.zoomIn', 'Zoom in')}
              aria-label={t('documentPreview.zoomIn', 'Zoom in')}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </button>
          </div>

          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            className="p-1.5 rounded-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-50"
            title={t('sources.download', 'Download')}
            aria-label={t('sources.download', 'Download')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </button>

          <button
            onClick={onClose}
            className="p-1.5 rounded-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
            title={t('common.close', 'Close')}
            aria-label={t('common.close', 'Close')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Passage selector — only meaningful with more than one passage */}
        {passageCount > 1 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
            <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
              {t('documentPreview.highlight', 'Highlight')}
            </span>
            <button
              onClick={() => setSelectedPassage(-1)}
              className={`text-xs px-2 py-1 rounded shrink-0 ${
                selectedPassage === -1
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
              }`}
            >
              {t('documentPreview.allPassages', 'All')}
            </button>
            {passages.map((_, i) => (
              <button
                key={i}
                onClick={() => setSelectedPassage(i)}
                className={`text-xs px-2 py-1 rounded shrink-0 ${
                  selectedPassage === i
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        {loadError ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-red-600 dark:text-red-400">
              {t('documentPreview.loadFailed', 'Could not load the document: {{error}}', {
                error: loadError
              })}
            </p>
          </div>
        ) : data === null ? (
          <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
            <svg className="animate-spin h-6 w-6 mr-2" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                strokeWidth="4"
                stroke="currentColor"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            {t('documentPreview.loading', 'Loading document…')}
          </div>
        ) : isText ? (
          <TextPassageViewer
            text={data}
            passages={activePassages}
            controlRef={controlRef}
            onStateChange={handleStateChange}
          />
        ) : (
          <PdfPassageViewer
            data={data}
            passages={activePassages}
            scale={scale}
            controlRef={controlRef}
            onStateChange={handleStateChange}
          />
        )}
      </div>
    </div>
  );
}

export default DocumentPreviewModal;
