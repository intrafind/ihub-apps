import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatFileSize } from '../utils/cloudFileProcessing';

/**
 * Standalone component that displays a list of attached files
 * with source icon, file type icon, name, size, and remove buttons.
 * Always visible when files are attached, independent of uploader state.
 */
const AttachedFilesList = ({ files, onRemoveFile, onRemoveAll, disabled = false }) => {
  const { t } = useTranslation();

  if (!files || files.length === 0) {
    return null;
  }

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

  return (
    <div className="mt-2 mb-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 shadow-sm">
      {/* File rows */}
      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {files.map((file, index) => (
          <div
            key={index}
            className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
          >
            {/* Source icon */}
            <div
              className="flex-shrink-0 text-gray-500 dark:text-gray-400"
              title={getSourceLabel(file)}
            >
              <Icon name={getSourceIcon(file)} size="sm" />
            </div>

            {/* File type icon */}
            <div className="flex-shrink-0 text-gray-600 dark:text-gray-300">
              <Icon name={getFileTypeIcon(file)} size="md" />
            </div>

            {/* File name and size */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {file.fileName}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {formatFileSize(file.fileSize)}
              </div>
            </div>

            {/* Remove button */}
            <button
              type="button"
              onClick={() => onRemoveFile(index)}
              disabled={disabled}
              className="flex-shrink-0 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed p-1"
              title={t('attachedFiles.remove', 'Remove file')}
              aria-label={t('attachedFiles.remove', 'Remove file')}
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        ))}
      </div>

      {/* Footer with file count and remove all button */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30">
        <div className="text-xs text-gray-600 dark:text-gray-400">
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
    </div>
  );
};

export default AttachedFilesList;
