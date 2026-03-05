import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { scrollToElement } from '../../../utils/citationTransformer';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import AppSelectionModal from '../../workflows/components/AppSelectionModal';

const PASSAGE_TRUNCATE_LENGTH = 150;

/**
 * Safely extract a value from additional_document_metadata.
 * Values are typically arrays (e.g. ["Filesystem"]), so we unwrap the first element.
 */
const getMeta = (item, key, fallback = '') => {
  const val = item?.additional_document_metadata?.[key];
  return Array.isArray(val) && val.length > 0 ? val[0] : val || fallback;
};

const getDeepLink = item => getMeta(item, 'accessInfo.deepLink');

const getFileName = item => getMeta(item, 'file.name');

const getSourceType = item => getMeta(item, 'sourceType');

const getApplication = item => getMeta(item, 'application').toLowerCase();

/**
 * Extract document access info (documentId + searchProfile) from a citation item's links array.
 * Returns null if no ACCESS link is present.
 */
const getDocumentAccess = item => {
  const links = item?.links;
  if (!Array.isArray(links)) return null;
  const accessLink = links.find(l => l.type === 'ACCESS');
  if (!accessLink?.documentId) return null;
  return { documentId: accessLink.documentId, searchProfile: accessLink.searchProfile };
};

/**
 * Check if the document can be accessed via the iFinder proxy.
 */
const hasProxyAccess = item => !!getDocumentAccess(item);

/**
 * Returns a document type icon based on the `application` metadata field.
 */
const DocIcon = ({ item }) => {
  const app = getApplication(item);
  const base = 'w-5 h-5 flex-shrink-0';

  const iconPath =
    'M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z';

  let colorClass = 'text-gray-400 dark:text-gray-500';
  if (app === 'pdf') colorClass = 'text-red-500';
  else if (app === 'word' || app === 'docx') colorClass = 'text-blue-500';
  else if (app === 'powerpoint' || app === 'pptx') colorClass = 'text-orange-500';
  else if (app === 'html') colorClass = 'text-gray-500';

  return (
    <svg className={`${base} ${colorClass}`} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d={iconPath} clipRule="evenodd" />
    </svg>
  );
};

/**
 * A single passage with truncate/expand behavior.
 */
const PassageText = ({ content, index, t }) => {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = content && content.length > PASSAGE_TRUNCATE_LENGTH;

  const displayText =
    needsTruncation && !expanded ? content.slice(0, PASSAGE_TRUNCATE_LENGTH) : content;

  return (
    <div className="flex gap-2 text-sm text-gray-600 dark:text-gray-400">
      {index != null && (
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300 text-[10px] font-medium flex-shrink-0 mt-0.5">
          {index}
        </span>
      )}
      <p className="whitespace-pre-wrap text-xs leading-relaxed">
        {displayText}
        {needsTruncation && !expanded && '\u2026 '}
        {needsTruncation && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium ml-0.5"
          >
            {expanded ? t('common.showLess', 'less') : t('common.showMore', 'more')}
          </button>
        )}
      </p>
    </div>
  );
};

/**
 * Overflow menu with click-outside dismiss.
 */
const OverflowMenu = ({ item, onAction, onOpenInApp, t }) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = e => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const canProxy = hasProxyAccess(item);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={e => {
          e.stopPropagation();
          setOpen(o => !o);
        }}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500 dark:text-gray-400"
        title={t('common.menu', 'Menu')}
        aria-label={t('common.menu', 'Menu')}
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-30 min-w-[160px]">
          {canProxy && (
            <button
              onClick={e => {
                e.stopPropagation();
                onAction('preview', item);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                />
              </svg>
              {t('citations.preview', 'Preview (PDF)')}
            </button>
          )}
          {canProxy && (
            <button
              onClick={e => {
                e.stopPropagation();
                onAction('download', item);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              {t('citations.download', 'Download')}
            </button>
          )}
          {canProxy && <div className="border-t border-gray-200 dark:border-gray-700 my-1" />}
          <button
            onClick={e => {
              e.stopPropagation();
              onOpenInApp(item);
              setOpen(false);
            }}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
              />
            </svg>
            {t('citations.openInApp', 'Open in App')}
          </button>
          {canProxy && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
              <button
                onClick={e => {
                  e.stopPropagation();
                  onAction('details', item);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                {t('citations.details', 'Details')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Modal displaying document metadata fetched from iFinder.
 */
const DocumentDetailsModal = ({ item, onClose, t }) => {
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const access = getDocumentAccess(item);
    if (!access) {
      setError('No document access info');
      setLoading(false);
      return;
    }

    const params = new URLSearchParams({
      documentId: access.documentId,
      ...(access.searchProfile ? { searchProfile: access.searchProfile } : {})
    });

    fetch(buildApiUrl(`integrations/ifinder/document/metadata?${params}`), {
      credentials: 'include'
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setMetadata(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [item]);

  const formatDate = dateStr => {
    if (!dateStr) return null;
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const rows = metadata
    ? [
        { label: t('citations.fileType', 'File Type'), value: metadata.application },
        { label: t('citations.fileSize', 'File Size'), value: metadata.sizeFormatted },
        { label: t('citations.author', 'Author'), value: metadata.author },
        { label: t('citations.source', 'Source'), value: metadata.sourceName },
        {
          label: t('citations.modified', 'Modified'),
          value: formatDate(metadata.modificationDate)
        },
        { label: t('citations.indexed', 'Indexed'), value: formatDate(metadata.indexingDate) },
        { label: t('citations.language', 'Language'), value: metadata.language }
      ].filter(r => r.value)
    : [];

  const navTree = metadata?.navigationTree;
  const breadcrumbs = Array.isArray(navTree)
    ? navTree.map(n => (typeof n === 'string' ? n : n?.label || n?.name)).filter(Boolean)
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            {t('citations.documentDetails', 'Document Details')}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500 dark:text-gray-400"
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

        {/* Body */}
        <div className="px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-8 text-gray-500 dark:text-gray-400">
              <svg
                className="animate-spin h-5 w-5 mr-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  strokeWidth="4"
                  stroke="currentColor"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              {t('citations.loading', 'Loading...')}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-500 dark:text-red-400 py-4 text-center">{error}</p>
          )}

          {metadata && (
            <>
              {/* Title + filename */}
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-900 dark:text-white leading-snug">
                  {metadata.title}
                </p>
                {metadata.filename && metadata.filename !== metadata.title && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {metadata.filename}
                  </p>
                )}
              </div>

              {/* Key-value rows */}
              {rows.length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  {rows.map(({ label, value }) => (
                    <div key={label} className="contents">
                      <dt className="text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {label}
                      </dt>
                      <dd className="text-gray-900 dark:text-gray-100">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {/* Breadcrumbs */}
              {breadcrumbs && breadcrumbs.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                    {t('citations.breadcrumbs', 'Path')}
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {breadcrumbs.join(' \u203A ')}
                  </p>
                </div>
              )}

              {/* Deep link */}
              {metadata.deepLink && (
                <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
                  <a
                    href={metadata.deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline break-all"
                  >
                    {metadata.deepLink}
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * CitationPanel renders below the message content when citations are present.
 * Merges references (passages) and resultItems (documents) into a single unified list,
 * grouped by document_id. Documents with passages are marked as "Referenced",
 * documents without passages are marked as "Mentioned".
 *
 * @param {Object} props
 * @param {Object} props.citations - { references: [], resultItems: [] }
 * @param {Function} [props.onDocumentAction] - Handler for document actions (preview, download, openInApp)
 */
function CitationPanel({ citations, onDocumentAction }) {
  const { t } = useTranslation();
  const [expandedDoc, setExpandedDoc] = useState(null);
  const [appPickerDoc, setAppPickerDoc] = useState(null);
  const [detailsDoc, setDetailsDoc] = useState(null);

  const handleDocAction = useCallback(
    (action, item, appId) => {
      // Handle details locally — no need to bubble up
      if (action === 'details') {
        setDetailsDoc(item);
        return;
      }

      if (onDocumentAction) {
        onDocumentAction(action, item, appId);
        return;
      }

      // Fallback: handle actions locally
      const access = getDocumentAccess(item);
      const deepLink = getDeepLink(item);

      if (action === 'openExternal') {
        if (deepLink) {
          window.open(deepLink, '_blank', 'noopener,noreferrer');
        }
      } else if (action === 'preview') {
        if (access) {
          const params = new URLSearchParams({
            documentId: access.documentId,
            ...(access.searchProfile ? { searchProfile: access.searchProfile } : {}),
            convertToPdf: 'true'
          });
          window.open(
            buildApiUrl(`integrations/ifinder/document?${params}`),
            '_blank',
            'noopener,noreferrer'
          );
        }
      } else if (action === 'download') {
        if (access) {
          const params = new URLSearchParams({
            documentId: access.documentId,
            ...(access.searchProfile ? { searchProfile: access.searchProfile } : {})
          });
          window.open(
            buildApiUrl(`integrations/ifinder/document?${params}`),
            '_blank',
            'noopener,noreferrer'
          );
        }
      }
    },
    [onDocumentAction]
  );

  // Merge references and resultItems into unified document list
  // Each entry tracks: doc, passages[], resultIndex (1-based position in original resultItems)
  const mergedDocuments = useMemo(() => {
    const references = citations?.references || [];
    const resultItems = citations?.resultItems || [];
    const map = new Map();

    for (let i = 0; i < resultItems.length; i++) {
      const item = resultItems[i];
      const id = item.document_id || getMeta(item, 'id');
      if (!id) continue;
      if (!map.has(id)) map.set(id, { doc: item, passages: [], resultIndex: i + 1 });
    }

    for (const ref of references) {
      const id = ref.document_id || getMeta(ref, 'id');
      if (!id) continue;
      if (!map.has(id)) map.set(id, { doc: ref, passages: [], resultIndex: null });
      if (ref.content) {
        map.get(id).passages.push({ content: ref.content, index: ref.index });
      }
    }

    // TODO: Remove this filter when iFinder fixes the bug that generates
    // resultItems with null titles and invalid IDs (e.g. publicpush-*)
    return Array.from(map.values()).filter(({ doc, passages }) => {
      const title = doc.title || getMeta(doc, 'title');
      // Keep documents that have a title OR have referenced passages
      return title || passages.length > 0;
    });
  }, [citations]);

  // Build a lookup: passage index -> document_id (for citation-navigate events)
  const passageToDocId = useMemo(() => {
    const lookup = {};
    for (const { doc, passages } of mergedDocuments) {
      const docId = doc.document_id || getMeta(doc, 'id');
      for (const p of passages) {
        if (p.index != null) lookup[p.index] = docId;
      }
    }
    return lookup;
  }, [mergedDocuments]);

  // Listen for citation-navigate events (dispatched by scrollToCitation for type="s")
  useEffect(() => {
    const handler = e => {
      const { num, elementId } = e.detail;
      const targetDocId = passageToDocId[num];
      if (targetDocId) {
        // Expand the document containing this passage
        setExpandedDoc(targetDocId);
        // Scroll after React re-renders the expanded passages
        requestAnimationFrame(() => {
          setTimeout(() => scrollToElement(elementId), 100);
        });
      }
    };
    window.addEventListener('citation-navigate', handler);
    return () => window.removeEventListener('citation-navigate', handler);
  }, [passageToDocId]);

  if (mergedDocuments.length === 0) {
    return null;
  }

  const toggleDoc = id => setExpandedDoc(prev => (prev === id ? null : id));

  return (
    <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
      <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
        {t('citations.documents', 'Documents')}
      </h4>
      <div className="space-y-2">
        {mergedDocuments.map(({ doc, passages, resultIndex }, index) => {
          const docId = doc.document_id || getMeta(doc, 'id') || `doc-${index}`;
          const title =
            doc.title || getMeta(doc, 'title') || t('citations.untitledDocument', 'Document');
          const sourceType = getSourceType(doc);
          const fileName = getFileName(doc);
          const deepLink = getDeepLink(doc);
          const hasPassages = passages.length > 0;
          const isExpanded = expandedDoc === docId;

          // Build subtitle from available metadata
          const subtitleParts = [sourceType, fileName].filter(Boolean);
          const subtitle = subtitleParts.join(' \u00b7 ');

          return (
            <div
              key={docId}
              id={resultIndex ? `citation-r-${resultIndex}` : undefined}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50"
            >
              {/* Document header */}
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <DocIcon item={doc} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 leading-snug">
                    {title}
                  </p>
                  {subtitle && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>
                  )}
                  {/* Badge row: referenced / mentioned + passage count */}
                  <div className="flex items-center gap-2 mt-1.5">
                    {hasPassages ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                        {t('citations.referenced', 'Referenced')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                        {t('citations.mentioned', 'Mentioned')}
                      </span>
                    )}
                    {hasPassages && (
                      <button
                        onClick={() => toggleDoc(docId)}
                        className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                      >
                        <span>
                          {t('citations.passages', {
                            count: passages.length,
                            defaultValue:
                              passages.length === 1 ? '{{count}} passage' : '{{count}} passages'
                          })}
                        </span>
                        <svg
                          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                {/* Action buttons */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {deepLink && (
                    <button
                      onClick={() => handleDocAction('openExternal', doc)}
                      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500 dark:text-gray-400"
                      title={t('citations.openExternal', 'Open in browser')}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </button>
                  )}
                  <OverflowMenu
                    item={doc}
                    onAction={handleDocAction}
                    onOpenInApp={setAppPickerDoc}
                    t={t}
                  />
                </div>
              </div>

              {/* Expandable passages */}
              {hasPassages && isExpanded && (
                <div className="border-t border-gray-100 dark:border-gray-700 px-3 py-2 space-y-1.5">
                  {passages
                    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                    .map((passage, pIdx) => (
                      <div
                        key={pIdx}
                        id={passage.index != null ? `citation-s-${passage.index}` : undefined}
                      >
                        <PassageText content={passage.content} index={passage.index} t={t} />
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <AppSelectionModal
        isOpen={appPickerDoc !== null}
        onClose={() => setAppPickerDoc(null)}
        onSelect={app => {
          handleDocAction('openInApp', appPickerDoc, app.id);
          setAppPickerDoc(null);
        }}
      />

      {detailsDoc && (
        <DocumentDetailsModal item={detailsDoc} onClose={() => setDetailsDoc(null)} t={t} />
      )}
    </div>
  );
}

export default CitationPanel;
