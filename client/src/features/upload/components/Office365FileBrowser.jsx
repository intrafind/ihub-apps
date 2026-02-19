import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useOffice365Browser } from '../hooks/useOffice365Browser';
import { formatFileSize, isCloudFileSupported } from '../utils/cloudFileProcessing';

/**
 * Office 365 File Browser component
 * Provides drive selection and file browsing for Office 365 (OneDrive, SharePoint, Teams)
 */
const Office365FileBrowser = ({ provider, onFilesProcessed, onClose, uploadConfig }) => {
  const { t } = useTranslation();
  const {
    authStatus,
    sources,
    currentSource,
    drives,
    items,
    currentDrive,
    breadcrumbs,
    selectedFiles,
    loading,
    downloading,
    error,
    searchQuery,
    sortBy,
    sortDirection,
    checkAuthStatus,
    loadSources,
    loadDrivesForSource,
    goBackToSources,
    selectDrive,
    navigateToFolder,
    navigateToBreadcrumb,
    toggleFileSelection,
    deselectAllFiles,
    downloadAndProcessFiles,
    searchItems,
    setSortBy,
    setSortDirection
  } = useOffice365Browser();

  // Local state for UI controls
  const [showUnsupportedFiles, setShowUnsupportedFiles] = useState(false);
  const [searchInput, setSearchInput] = useState('');

  // Check auth status on mount
  useEffect(() => {
    checkAuthStatus().then(connected => {
      if (connected) {
        loadSources();
      }
    });
  }, [checkAuthStatus, loadSources]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== searchQuery) {
        searchItems(searchInput);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchInput, searchQuery, searchItems]);

  // Calculate total size of selected files
  const selectedTotalSize = Array.from(selectedFiles.values()).reduce(
    (sum, item) => sum + (item.size || 0),
    0
  );

  // Sort and filter items
  const processedItems = useMemo(() => {
    let result = [...items];

    // Filter unsupported files if toggle is on
    if (!showUnsupportedFiles) {
      result = result.filter(item => item.isFolder || isCloudFileSupported(item.mimeType));
    }

    // Sort items
    result.sort((a, b) => {
      // Folders always first
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;

      // Then sort by selected column
      let compareValue = 0;
      if (sortBy === 'name') {
        compareValue = a.name.localeCompare(b.name);
      } else if (sortBy === 'size') {
        compareValue = (a.size || 0) - (b.size || 0);
      } else if (sortBy === 'date') {
        const aDate = new Date(a.lastModifiedDateTime || 0);
        const bDate = new Date(b.lastModifiedDateTime || 0);
        compareValue = aDate - bDate;
      }

      return sortDirection === 'asc' ? compareValue : -compareValue;
    });

    return result;
  }, [items, showUnsupportedFiles, sortBy, sortDirection]);

  // Handle sort column click
  const handleSortClick = useCallback(
    column => {
      if (sortBy === column) {
        // Toggle direction
        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        // New column, default to ascending
        setSortBy(column);
        setSortDirection('asc');
      }
    },
    [sortBy, sortDirection, setSortBy, setSortDirection]
  );

  // Handle file attachment
  const handleAttachFiles = async () => {
    const processedData = await downloadAndProcessFiles(uploadConfig);
    if (processedData.length > 0) {
      onFilesProcessed(processedData);
    }
  };

  // Handle connect button
  const handleConnect = () => {
    // Get current page path as return URL
    const returnUrl = window.location.pathname + window.location.search;
    const authUrl = `/api/integrations/${provider.type}/auth?providerId=${encodeURIComponent(provider.id)}&returnUrl=${encodeURIComponent(returnUrl)}`;
    window.location.href = authUrl;
  };

  // Get file icon based on MIME type
  const getFileIcon = item => {
    if (item.isFolder) return 'folder';

    const mimeType = item.mimeType || '';
    if (mimeType.startsWith('image/')) return 'camera';
    if (mimeType.startsWith('audio/')) return 'microphone';
    if (mimeType.includes('pdf')) return 'document-text';
    if (mimeType.includes('word') || mimeType.includes('document')) return 'document-text';
    return 'paper-clip';
  };

  // Check if file can be selected (supported and within size limit)
  const canSelectFile = item => {
    if (item.isFolder) return false;
    const maxSize = (uploadConfig.maxFileSizeMB || 10) * 1024 * 1024;
    const supported = isCloudFileSupported(item.mimeType);
    return supported && item.size <= maxSize;
  };

  // Get tooltip for unsupported/oversized files
  const getFileTooltip = item => {
    if (item.isFolder) return null;
    const maxSize = (uploadConfig.maxFileSizeMB || 10) * 1024 * 1024;
    const supported = isCloudFileSupported(item.mimeType);

    if (!supported) return t('upload.fileTypeNotSupported', 'File type not supported');
    if (item.size > maxSize)
      return t('upload.fileTooLarge', 'File exceeds size limit ({{limit}}MB)', {
        limit: uploadConfig.maxFileSizeMB || 10
      });
    return null;
  };

  // View A: Not Connected
  if (authStatus === 'not_connected') {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
        <div className="w-16 h-16 mb-4 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
          <Icon name="cloud" size="xl" className="text-indigo-600 dark:text-indigo-400" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t('cloudStorage.notConnected', 'Office 365 Not Connected')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 max-w-sm">
          {t(
            'cloudStorage.connectPrompt',
            'Connect your Microsoft account to browse files from OneDrive, SharePoint, and Teams'
          )}
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleConnect}
            className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
          >
            {t('cloudStorage.connect', 'Connect to Office 365')}
          </button>
        </div>
      </div>
    );
  }

  // View B: Source Category Selection
  if (sources.length > 0 && !currentSource) {
    return (
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('cloudStorage.selectStorageLocation', 'Select Storage Location')}
        </h3>
        <div className="space-y-3">
          {sources.map(source => (
            <button
              key={source.id}
              onClick={() => loadDrivesForSource(source.id)}
              className="w-full flex items-center p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors"
            >
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center mr-4">
                <Icon
                  name={source.icon}
                  size="lg"
                  className="text-indigo-600 dark:text-indigo-400"
                />
              </div>
              <div className="flex-1 text-left">
                <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {source.name}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{source.description}</p>
              </div>
              <Icon
                name="chevron-right"
                size="md"
                className="text-gray-400 dark:text-gray-500 ml-2"
              />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // View C: Drive Selection
  if (currentSource && !currentDrive) {
    // Get the source details
    const sourceDetails = sources.find(s => s.id === currentSource);
    const sourceName = sourceDetails?.name || currentSource;

    return (
      <div>
        {/* Back button */}
        <button
          onClick={goBackToSources}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 mb-3 flex items-center"
        >
          <Icon name="arrowLeft" size="sm" className="mr-1" />
          {t('cloudStorage.backToStorageLocations', 'Back to Storage Locations')}
        </button>

        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('cloudStorage.selectDrive', 'Select a Drive')} - {sourceName}
        </h3>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
            <div className="flex">
              <Icon name="warning" size="sm" className="text-red-500 mt-0.5 mr-2" />
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          </div>
        ) : drives.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500 dark:text-gray-400">
            <Icon name="folder-open" size="xl" className="mb-2" />
            <p className="text-sm">{t('cloudStorage.noDrivesFound', 'No drives found')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {drives.map(drive => (
              <button
                key={drive.id}
                onClick={() => selectDrive(drive)}
                className="w-full flex items-center p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Icon
                  name={sourceDetails?.icon || 'folder'}
                  size="lg"
                  className="text-indigo-600 dark:text-indigo-400 mr-3"
                />
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {drive.name}
                  </p>
                  {drive.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">{drive.description}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // View D: File Browser
  if (currentDrive) {
    return (
      <div className="flex flex-col h-[500px]">
        {/* Header with back button and breadcrumbs */}
        <div className="mb-4 pb-3 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => selectDrive(null)}
            className="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 mb-2 flex items-center"
          >
            <Icon name="arrowLeft" size="sm" className="mr-1" />
            {t('cloudStorage.backToDrives', 'Back to Drives')}
          </button>

          {/* Breadcrumbs */}
          <div className="flex items-center text-sm text-gray-600 dark:text-gray-400 flex-wrap">
            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.id} className="flex items-center">
                {index > 0 && <span className="mx-2">/</span>}
                <button
                  onClick={() => navigateToBreadcrumb(index)}
                  className="hover:text-gray-900 dark:hover:text-gray-200 font-medium"
                  disabled={index === breadcrumbs.length - 1}
                >
                  {crumb.name}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Search and filter controls */}
        <div className="mb-4 space-y-3">
          {/* Search input */}
          <div className="relative">
            <Icon
              name="search"
              size="sm"
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder={t('cloudStorage.searchFiles', 'Search files...')}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <Icon name="x" size="sm" />
              </button>
            )}
          </div>

          {/* Filter toggle */}
          <div className="flex items-center justify-between">
            <label className="flex items-center text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={!showUnsupportedFiles}
                onChange={e => setShowUnsupportedFiles(!e.target.checked)}
                className="mr-2 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              {t('cloudStorage.showSupportedOnly', 'Show supported files only')}
            </label>

            {/* Sort indicator */}
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t('cloudStorage.sortedBy', 'Sorted by')}: {sortBy} ({sortDirection})
            </div>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
            <div className="flex">
              <Icon name="warning" size="sm" className="text-red-500 mt-0.5 mr-2" />
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto mb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
            </div>
          ) : processedItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-500 dark:text-gray-400">
              <Icon name="folder-open" size="xl" className="mb-2" />
              <p className="text-sm">
                {searchInput
                  ? t('cloudStorage.noSearchResults', 'No files found')
                  : t('cloudStorage.emptyFolder', 'This folder is empty')}
              </p>
            </div>
          ) : (
            <div>
              {/* Column headers */}
              <div className="flex items-center px-2 py-2 border-b border-gray-200 dark:border-gray-700 mb-1">
                <div className="w-7"></div> {/* Checkbox space */}
                <div className="flex-1 flex items-center space-x-4">
                  <button
                    onClick={() => handleSortClick('name')}
                    className="flex items-center text-xs font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                  >
                    {t('cloudStorage.name', 'Name')}
                    {sortBy === 'name' && (
                      <Icon
                        name={sortDirection === 'asc' ? 'chevron-up' : 'chevron-down'}
                        size="xs"
                        className="ml-1"
                      />
                    )}
                  </button>
                </div>
                <div className="w-32 text-right">
                  <button
                    onClick={() => handleSortClick('size')}
                    className="flex items-center text-xs font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                  >
                    {t('cloudStorage.size', 'Size')}
                    {sortBy === 'size' && (
                      <Icon
                        name={sortDirection === 'asc' ? 'chevron-up' : 'chevron-down'}
                        size="xs"
                        className="ml-1"
                      />
                    )}
                  </button>
                </div>
                <div className="w-32 text-right ml-4">
                  <button
                    onClick={() => handleSortClick('date')}
                    className="flex items-center text-xs font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                  >
                    {t('cloudStorage.modified', 'Modified')}
                    {sortBy === 'date' && (
                      <Icon
                        name={sortDirection === 'asc' ? 'chevron-up' : 'chevron-down'}
                        size="xs"
                        className="ml-1"
                      />
                    )}
                  </button>
                </div>
              </div>

              {/* File list */}
              <div className="space-y-1">
                {processedItems.map(item => {
                  const isFolder = item.isFolder;
                  const isSelected = selectedFiles.has(item.id);
                  const canSelect = canSelectFile(item);
                  const tooltip = getFileTooltip(item);

                  return (
                    <div
                      key={item.id}
                      className={`flex items-center p-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 ${
                        isSelected ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''
                      } ${!canSelect && !isFolder ? 'opacity-50' : ''}`}
                      title={tooltip || undefined}
                    >
                      {/* Checkbox for files */}
                      {!isFolder && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleFileSelection(item)}
                          disabled={!canSelect}
                          className="mr-3 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded disabled:opacity-50"
                        />
                      )}

                      {/* Icon */}
                      <div className={isFolder ? 'ml-7' : ''}>
                        <Icon
                          name={getFileIcon(item)}
                          size="md"
                          className="text-gray-400 dark:text-gray-500"
                        />
                      </div>

                      {/* Name */}
                      <button
                        onClick={() => (isFolder ? navigateToFolder(item) : null)}
                        disabled={!isFolder}
                        className="flex-1 ml-3 text-left"
                      >
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {item.name}
                        </p>
                      </button>

                      {/* Size and date */}
                      <div className="flex items-center ml-4">
                        <div className="w-32 text-right text-xs text-gray-500 dark:text-gray-400">
                          {!isFolder && <span>{formatFileSize(item.size)}</span>}
                        </div>
                        <div className="w-32 text-right text-xs text-gray-500 dark:text-gray-400 ml-4">
                          {item.lastModifiedDateTime && (
                            <span>{new Date(item.lastModifiedDateTime).toLocaleDateString()}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Progress bar during download */}
        {downloading.active && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-blue-700 dark:text-blue-400">
                {t('cloudStorage.downloading', 'Downloading {{current}} of {{total}}...', {
                  current: downloading.current,
                  total: downloading.total
                })}
              </span>
            </div>
            <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2">
              <div
                className="bg-blue-600 dark:bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${(downloading.current / downloading.total) * 100}%` }}
              ></div>
            </div>
          </div>
        )}

        {/* Bottom bar */}
        {!downloading.active && (
          <div className="flex items-center justify-between pt-3 border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {selectedFiles.size > 0 ? (
                <>
                  {t('cloudStorage.filesSelected', '{{count}} file(s) selected', {
                    count: selectedFiles.size
                  })}{' '}
                  ({formatFileSize(selectedTotalSize)})
                  <button
                    onClick={deselectAllFiles}
                    className="ml-2 text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {t('common.clearSelection', 'Clear')}
                  </button>
                </>
              ) : (
                <span>{t('cloudStorage.noFilesSelected', 'No files selected')}</span>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleAttachFiles}
                disabled={selectedFiles.size === 0}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {t('cloudStorage.attachFiles', 'Attach {{count}} File(s)', {
                  count: selectedFiles.size
                })}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Loading state
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
    </div>
  );
};

export default Office365FileBrowser;
