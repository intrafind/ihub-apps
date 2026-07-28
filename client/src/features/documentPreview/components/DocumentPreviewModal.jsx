import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import PdfPassageViewer from './PdfPassageViewer';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.2;

/**
 * In-app PDF preview for an iFinder document, with the passages that the
 * search backend returned highlighted in the document text.
 *
 * The PDF comes from the existing `integrations/ifinder/document` proxy with
 * `convertToPdf=true`, i.e. the same generated PDF the "Preview" action used to
 * open in a browser tab. Fetching it as an ArrayBuffer (instead of handing the
 * URL to pdf.js) keeps the request on the app's `credentials: 'include'` path.
 *
 * @param {Object} props
 * @param {string} props.documentId iFinder document id from the ACCESS link.
 * @param {string} [props.searchProfile]
 * @param {string} [props.title] document title for the header.
 * @param {string[]} props.passages passage texts to highlight.
 * @param {number} [props.initialPassageIndex] index into `passages` to focus,
 *   or `-1`/undefined to highlight all of them.
 * @param {Function} props.onClose
 */
function DocumentPreviewModal({
  documentId,
  searchProfile,
  title,
  passages = [],
  initialPassageIndex = -1,
  onClose
}) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [scale, setScale] = useState(1.2);
  const [selectedPassage, setSelectedPassage] = useState(initialPassageIndex);
  const [viewerState, setViewerState] = useState({
    loading: true,
    numPages: 0,
    totalMatches: 0,
    currentMatch: -1
  });
  const controlRef = useRef(null);

  const documentParams = useMemo(() => {
    const params = new URLSearchParams({ documentId });
    if (searchProfile) params.set('searchProfile', searchProfile);
    return params;
  }, [documentId, searchProfile]);

  // Fetch the generated PDF.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const params = new URLSearchParams(documentParams);
    params.set('convertToPdf', 'true');

    setData(null);
    setLoadError(null);

    fetch(buildApiUrl(`integrations/ifinder/document?${params}`), {
      credentials: 'include',
      signal: controller.signal
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buffer => {
        if (!cancelled) setData(buffer);
      })
      .catch(err => {
        if (!cancelled && err.name !== 'AbortError') setLoadError(err.message);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [documentParams]);

  // Close on Escape, navigate matches with Enter / Shift+Enter.
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) controlRef.current?.previousMatch();
        else controlRef.current?.nextMatch();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const activePassages = useMemo(() => {
    const valid = passages.filter(p => typeof p === 'string' && p.trim().length > 0);
    if (selectedPassage >= 0 && valid[selectedPassage]) return [valid[selectedPassage]];
    return valid;
  }, [passages, selectedPassage]);

  const handleStateChange = useCallback(state => setViewerState(state), []);

  const downloadUrl = buildApiUrl(`integrations/ifinder/document?${documentParams}`);

  const { loading, numPages, totalMatches, currentMatch } = viewerState;
  const passageCount = passages.filter(p => typeof p === 'string' && p.trim().length > 0).length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60" onClick={onClose}>
      <div
        className="relative m-2 sm:m-6 flex flex-col flex-1 min-h-0 bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {title || t('documentPreview.title', 'Document preview')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {loading
                ? t('documentPreview.loading', 'Loading document…')
                : t('documentPreview.pageCount', '{{count}} pages', { count: numPages })}
            </p>
          </div>

          {/* Match navigation */}
          {!loading && passageCount > 0 && (
            <div className="flex items-center gap-1">
              <span
                className={`text-xs px-2 py-1 rounded ${
                  totalMatches > 0
                    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
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
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40"
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
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40"
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
          <div className="hidden sm:flex items-center gap-1">
            <button
              onClick={() => setScale(s => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)))}
              className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
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
              onClick={() => setScale(s => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)))}
              className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
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

          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
            title={t('citations.download', 'Download')}
            aria-label={t('citations.download', 'Download')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </a>

          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
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
            <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
              {t('documentPreview.highlight', 'Highlight')}
            </span>
            <button
              onClick={() => setSelectedPassage(-1)}
              className={`text-xs px-2 py-1 rounded flex-shrink-0 ${
                selectedPassage === -1
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
              }`}
            >
              {t('documentPreview.allPassages', 'All')}
            </button>
            {passages
              .filter(p => typeof p === 'string' && p.trim().length > 0)
              .map((_, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedPassage(i)}
                  className={`text-xs px-2 py-1 rounded flex-shrink-0 ${
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
        ) : !data ? (
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
