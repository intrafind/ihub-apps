import { useState, useCallback } from 'react';
import { apiClient } from '../../../api/client';
import { processCloudFile } from '../utils/cloudFileProcessing';

// Sources that have exactly one virtual drive and should skip the drives list view
export const SINGLE_DRIVE_SOURCES = ['myDrive', 'sharedWithMe'];

/**
 * Custom hook for Google Drive file browsing and selection
 */
export const useGoogleDriveBrowser = () => {
  const [authStatus, setAuthStatus] = useState('checking');
  const [sources, setSources] = useState([]);
  const [currentSource, setCurrentSource] = useState(null);
  const [drives, setDrives] = useState([]);
  const [items, setItems] = useState([]);
  const [currentDrive, setCurrentDrive] = useState(null);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState({ active: false, current: 0, total: 0 });
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  /**
   * Check if user is authenticated with Google Drive
   */
  const checkAuthStatus = useCallback(async () => {
    try {
      setAuthStatus('checking');
      const response = await apiClient.get('/integrations/googledrive/status');
      setAuthStatus(response.data.connected ? 'connected' : 'not_connected');
      return response.data.connected;
    } catch (err) {
      console.error('Auth status check failed:', err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
      } else {
        setAuthStatus('error');
        setError(err.message || 'Failed to check authentication status');
      }
      return false;
    }
  }, []);

  /**
   * Load available source categories
   */
  const loadSources = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.get('/integrations/googledrive/sources');
      setSources(response.data.sources || []);
      return response.data.sources || [];
    } catch (err) {
      console.error('Failed to load sources:', err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
        setError('Authentication required. Please connect to Google Drive.');
      } else {
        setError(err.message || 'Failed to load sources');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Load drives for a specific source
   */
  const loadDrivesForSource = useCallback(async sourceId => {
    try {
      setLoading(true);
      setError(null);
      setCurrentSource(sourceId);
      const response = await apiClient.get(`/integrations/googledrive/drives/${sourceId}`);
      setDrives(response.data.drives || []);
      return response.data.drives || [];
    } catch (err) {
      console.error(`Failed to load drives for source ${sourceId}:`, err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
        setError('Authentication required. Please connect to Google Drive.');
      } else {
        setError(err.message || 'Failed to load drives');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Go back to source selection
   */
  const goBackToSources = useCallback(() => {
    setCurrentSource(null);
    setDrives([]);
    setCurrentDrive(null);
    setBreadcrumbs([]);
    setItems([]);
    setSelectedFiles(new Map());
    setSearchQuery('');
  }, []);

  /**
   * Load items (files and folders) from a drive/folder
   */
  const loadItems = useCallback(async (driveId, folderId = null, search = null) => {
    try {
      setLoading(true);
      setError(null);
      const params = { driveId };
      if (folderId) {
        params.folderId = folderId;
      }
      if (search && search.trim().length > 0) {
        params.search = search.trim();
      }
      // Pass source info for sharedWithMe handling
      if (driveId === 'sharedWithMe') {
        params.source = 'sharedWithMe';
      }
      const response = await apiClient.get('/integrations/googledrive/items', { params });
      setItems(response.data.items || []);
      return response.data.items || [];
    } catch (err) {
      console.error('Failed to load items:', err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
        setError('Authentication required. Please connect to Google Drive.');
      } else {
        setError(err.message || 'Failed to load items');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Select a drive and load its root items
   */
  const selectDrive = useCallback(
    async drive => {
      if (!drive) {
        setCurrentDrive(null);
        setBreadcrumbs([]);
        setItems([]);
        setSelectedFiles(new Map());
        setSearchQuery('');
        return;
      }

      setCurrentDrive(drive);
      setBreadcrumbs([{ id: drive.id, name: drive.name, type: 'drive' }]);
      setSelectedFiles(new Map());
      await loadItems(drive.id, null);
    },
    [loadItems]
  );

  /**
   * Select a source category, automatically skipping the drives list for single-drive sources
   * (myDrive and sharedWithMe always have exactly one virtual drive)
   */
  const selectSource = useCallback(
    async sourceId => {
      const drivesResult = await loadDrivesForSource(sourceId);
      if (SINGLE_DRIVE_SOURCES.includes(sourceId) && drivesResult.length > 0) {
        await selectDrive(drivesResult[0]);
      }
    },
    [loadDrivesForSource, selectDrive]
  );

  /**
   * Navigate into a folder
   */
  const navigateToFolder = useCallback(
    async folderItem => {
      if (!currentDrive) return;
      setBreadcrumbs(prev => [
        ...prev,
        { id: folderItem.id, name: folderItem.name, type: 'folder' }
      ]);
      setSelectedFiles(new Map());
      await loadItems(currentDrive.id, folderItem.id);
    },
    [currentDrive, loadItems]
  );

  /**
   * Navigate to a breadcrumb (go back)
   */
  const navigateToBreadcrumb = useCallback(
    async index => {
      if (!currentDrive) return;
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      setBreadcrumbs(newBreadcrumbs);
      setSelectedFiles(new Map());

      const targetItem = newBreadcrumbs[newBreadcrumbs.length - 1];
      const folderId = targetItem.type === 'drive' ? null : targetItem.id;
      await loadItems(currentDrive.id, folderId);
    },
    [currentDrive, breadcrumbs, loadItems]
  );

  /**
   * Toggle file selection
   */
  const toggleFileSelection = useCallback(item => {
    setSelectedFiles(prev => {
      const newMap = new Map(prev);
      if (newMap.has(item.id)) {
        newMap.delete(item.id);
      } else {
        newMap.set(item.id, item);
      }
      return newMap;
    });
  }, []);

  /**
   * Select all files in current view
   */
  const selectAllFiles = useCallback(() => {
    const fileItems = items.filter(item => !item.isFolder);
    const newMap = new Map();
    fileItems.forEach(item => {
      newMap.set(item.id, item);
    });
    setSelectedFiles(newMap);
  }, [items]);

  /**
   * Deselect all files
   */
  const deselectAllFiles = useCallback(() => {
    setSelectedFiles(new Map());
  }, []);

  /**
   * Download and process selected files
   */
  const downloadAndProcessFiles = useCallback(
    async uploadConfig => {
      if (!currentDrive || selectedFiles.size === 0) {
        return [];
      }

      const maxFileSizeMB = uploadConfig.maxFileSizeMB || 10;
      const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
      const filesArray = Array.from(selectedFiles.values());
      const processedFiles = [];

      setDownloading({ active: true, current: 0, total: filesArray.length });
      setError(null);

      try {
        for (let i = 0; i < filesArray.length; i++) {
          const item = filesArray[i];

          setDownloading({ active: true, current: i + 1, total: filesArray.length });

          // Check file size (skip for Google Docs which have size 0)
          if (item.size > maxFileSizeBytes && !item.isGoogleDoc) {
            console.warn(`File ${item.name} exceeds size limit, skipping`);
            continue;
          }

          try {
            const response = await apiClient.get('/integrations/googledrive/download', {
              params: { fileId: item.id },
              responseType: 'blob'
            });

            const blob = response.data;
            const file = new File([blob], item.name, {
              type: item.mimeType || 'application/octet-stream'
            });

            const processedData = await processCloudFile(file, uploadConfig);
            processedFiles.push(processedData);
          } catch (err) {
            console.error(`Failed to download/process ${item.name}:`, err);
          }
        }

        return processedFiles;
      } catch (err) {
        console.error('Error during download:', err);
        setError(err.message || 'Failed to download files');
        return processedFiles;
      } finally {
        setDownloading({ active: false, current: 0, total: 0 });
      }
    },
    [currentDrive, selectedFiles]
  );

  /**
   * Search for items in the current drive
   */
  const searchItems = useCallback(
    async query => {
      if (!currentDrive) return;
      setSearchQuery(query);
      if (query && query.trim().length > 0) {
        await loadItems(currentDrive.id, null, query);
      } else {
        const currentFolderId =
          breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 1].id : null;
        await loadItems(currentDrive.id, currentFolderId);
      }
    },
    [currentDrive, breadcrumbs, loadItems]
  );

  /**
   * Reset all state
   */
  const reset = useCallback(() => {
    setAuthStatus('checking');
    setSources([]);
    setCurrentSource(null);
    setDrives([]);
    setItems([]);
    setCurrentDrive(null);
    setBreadcrumbs([]);
    setSelectedFiles(new Map());
    setLoading(false);
    setDownloading({ active: false, current: 0, total: 0 });
    setError(null);
    setSearchQuery('');
    setSortBy('name');
    setSortDirection('asc');
  }, []);

  return {
    // State
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
    // Functions
    checkAuthStatus,
    loadSources,
    loadDrivesForSource,
    selectSource,
    goBackToSources,
    loadItems,
    selectDrive,
    navigateToFolder,
    navigateToBreadcrumb,
    toggleFileSelection,
    selectAllFiles,
    deselectAllFiles,
    downloadAndProcessFiles,
    searchItems,
    setSearchQuery,
    setSortBy,
    setSortDirection,
    reset
  };
};
