import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatFileSize } from '../utils/cloudFileProcessing';

// Auto-collapse the list by default once it reaches this many files. Below the
// threshold the list stays fully expanded with no collapse chrome — a 1-3 file
// list is comfortable to show and the layout pain (chat input pushed off-screen)
// only starts around 4+ rows. Mirrors the override pattern in OfficeContextStrip
// (issue #1467), one row higher because rows here are ~40px on a taller surface.
const AUTO_COLLAPSE_THRESHOLD = 4;

/**
 * Standalone component that displays a list of attached files
 * with source icon, file type icon, name, size, and remove buttons.
 * Always visible when files are attached, independent of uploader state.
 *
 * To keep the chat input reachable, the list:
 *   - auto-collapses to a one-line summary header at >= AUTO_COLLAPSE_THRESHOLD
 *     files (the user can expand/collapse manually via the chevron), and
 *   - caps the expanded row list with a max-height + scroll so even a manually
 *     expanded list can never push the textarea/send button off-screen.
 */
export default function AttachedFilesList({
  files,
  onRemoveFile,
  onRemoveAll,
  disabled = false,
  defaultCollapseThreshold = AUTO_COLLAPSE_THRESHOLD
}) {
  const { t } = useTranslation();

  const fileCount = files?.length || 0;
  const shouldDefaultCollapse = fileCount >= defaultCollapseThreshold;
  const [overrideExpanded, setOverrideExpanded] = useState(/** @type {boolean|null} */ (null));

  // Reset the user's expand/collapse override when the number of files changes,
  // so the auto-collapse default re-applies when a 4th file lands (collapses) and
  // re-expands once removals bring the count back under the threshold. Tracked via
  // a ref so we don't bounce through a useEffect just to clear state on re-render.
  const prevCountRef = useRef(fileCount);
  if (prevCountRef.current !== fileCount) {
    prevCountRef.current = fileCount;
    if (overrideExpanded !== null) setOverrideExpanded(null);
  }

  if (!files || files.length === 0) {
    return null;
  }

  // The collapse toggle only matters when there's something to hide, so we gate
  // the header on the threshold. Below it the list always renders expanded.
  const showHeader = files.length >= defaultCollapseThreshold;
  const expanded = overrideExpanded === null ? !shouldDefaultCollapse : overrideExpanded;

  /**
   * Get source icon name based on file source
   */
  const getSourceIcon = file => {
    const source = file.source || 'local';
    if (source === 'local') return 'hard-drive';
    if (source === 'office365') return 'cloud';
    return 'cloud'; // fallback for any other cloud provider
  };

  /**
   * Get file type icon name based on file type
   */
  const getFileTypeIcon = file => {
    const type = file.type;
    if (type === 'image') return 'camera';
    if (type === 'audio') return 'microphone';
    if (type === 'document') return 'document-text';
    return 'paper-clip'; // fallback
  };

  /**
   * Get source label for accessibility
   */
  const getSourceLabel = file => {
    const source = file.source || 'local';
    if (source === 'local') return t('attachedFiles.sourceLocal', 'Local file');
    return t('attachedFiles.sourceCloud', 'Cloud file');
  };

  // Build the always-visible summary line for the collapsed header. Total size
  // sums only resolved (non-loading) files; loading files get a separate hint.
  const loadingCount = files.filter(file => file.loading).length;
  const totalSize = files.reduce(
    (sum, file) => (file.loading ? sum : sum + (Number(file.fileSize) || 0)),
    0
  );
  let summaryLine = t('attachedFiles.summary', '{{count}} files · {{size}}', {
    count: files.length,
    size: formatFileSize(totalSize)
  });
  if (loadingCount > 0) {
    summaryLine += ` · ${t('attachedFiles.loadingCount', '{{count}} loading…', {
      count: loadingCount
    })}`;
  }

  return (
    <div className="mt-2 mb-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 shadow-sm">
      {/* Collapsible header — only when the list is long enough to threaten the layout */}
      {showHeader && (
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => setOverrideExpanded(!expanded)}
            className="flex-1 flex items-center gap-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-md px-1 py-0.5 -ml-1"
            aria-expanded={expanded}
            aria-controls="attached-files-region"
            aria-label={
              expanded
                ? t('attachedFiles.hideList', 'Hide file list')
                : t('attachedFiles.showList', 'Show file list')
            }
          >
            <Icon
              name="paper-clip"
              size="sm"
              className="flex-shrink-0 text-gray-500 dark:text-gray-400"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {t('attachedFiles.title', 'Attachments')}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate" aria-live="polite">
                {summaryLine}
              </div>
            </div>
            <Icon
              name={expanded ? 'chevronUp' : 'chevronDown'}
              size="sm"
              className="flex-shrink-0 text-gray-400"
              aria-hidden
            />
          </button>

          {/* Remove All stays reachable in the header while the list is collapsed */}
          {!expanded && (
            <button
              type="button"
              onClick={onRemoveAll}
              disabled={disabled}
              className="flex-shrink-0 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('attachedFiles.removeAll', 'Remove All')}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <>
          {/* Bounded scroll region — caps the height so the list can never push
              the chat input off-screen. Narrow Outlook task pane (< sm) gets
              ~4 rows (max-h-44); desktop chat gets ~6 rows (max-h-60). */}
          <div
            id="attached-files-region"
            role="list"
            tabIndex={0}
            aria-label={t('attachedFiles.regionLabel', 'Attached files')}
            className={`max-h-44 sm:max-h-60 overflow-y-auto overscroll-contain divide-y divide-gray-200 dark:divide-gray-700${
              showHeader ? ' border-t border-gray-200 dark:border-gray-700' : ''
            }`}
          >
            {files.map((file, index) => (
              <div
                key={index}
                role="listitem"
                className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                {/* Source icon */}
                <div
                  className="flex-shrink-0 text-gray-500 dark:text-gray-400"
                  title={getSourceLabel(file)}
                >
                  <Icon name={getSourceIcon(file)} size="sm" />
                </div>

                {/* File type icon or loading spinner */}
                <div className="flex-shrink-0 text-gray-600 dark:text-gray-300">
                  {file.loading ? (
                    <svg
                      className="animate-spin h-5 w-5 text-indigo-500"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                  ) : (
                    <Icon name={getFileTypeIcon(file)} size="md" />
                  )}
                </div>

                {/* File name and size */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {file.fileName}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {file.loading
                      ? t('attachedFiles.loading', 'Loading document...')
                      : formatFileSize(file.fileSize)}
                  </div>
                </div>

                {/* Remove button */}
                <button
                  type="button"
                  onClick={() => onRemoveFile(index)}
                  disabled={disabled || file.loading}
                  className="flex-shrink-0 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed p-1"
                  title={t('attachedFiles.remove', 'Remove file')}
                  aria-label={t('attachedFiles.remove', 'Remove file')}
                >
                  <Icon name="x" size="sm" />
                </button>
              </div>
            ))}
          </div>

          {/* Footer with file count and remove all button — stays outside the
              scroll region so it's always visible. */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30">
            <div className="text-xs text-gray-600 dark:text-gray-400" aria-live="polite">
              {t('attachedFiles.filesCount', '{{count}} file(s) attached', { count: files.length })}
            </div>
            <button
              type="button"
              onClick={onRemoveAll}
              disabled={disabled}
              className="text-xs text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('attachedFiles.removeAll', 'Remove All')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
