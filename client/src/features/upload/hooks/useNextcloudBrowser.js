import { useState, useCallback } from 'react';
import { apiClient } from '../../../api/client';
import { processCloudFile } from '../utils/cloudFileProcessing';

/**
 * Custom hook for Nextcloud file browsing and selection.
 *
 * Mirrors the Office 365 / Google Drive hook surface so the picker UI
 * can stay symmetric, but Nextcloud is path-based (no opaque drive or
 * folder IDs), so we track the current folder path rather than IDs.
 */
export const useNextcloudBrowser = () => {
  const [authStatus, setAuthStatus] = useState('checking');
  const [sources, setSources] = useState([]);
  const [currentSource, setCurrentSource] = useState(null);
  const [drives, setDrives] = useState([]);
  const [items, setItems] = useState([]);
  const [currentDrive, setCurrentDrive] = useState(null);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState(() => new Map());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState({ active: false, current: 0, total: 0 });
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  const checkAuthStatus = useCallback(async () => {
    try {
      setAuthStatus('checking');
      const response = await apiClient.get('/integrations/nextcloud/status');
      setAuthStatus(response.data.connected ? 'connected' : 'not_connected');
      return response.data.connected;
    } catch (err) {
      console.error('Nextcloud auth status check failed:', err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
      } else {
        setAuthStatus('error');
        setError(err.message || 'Failed to check authentication status');
      }
      return false;
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.get('/integrations/nextcloud/sources');
      setSources(response.data.sources || []);
      return response.data.sources || [];
    } catch (err) {
      console.error('Failed to load Nextcloud sources:', err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
        setError('Authentication required. Please connect to Nextcloud.');
      } else {
        setError(err.message || 'Failed to load sources');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDrivesForSource = useCallback(async sourceId => {
    try {
      setLoading(true);
      setError(null);
      setCurrentSource(sourceId);
      const response = await apiClient.get(`/integrations/nextcloud/drives/${sourceId}`);
      setDrives(response.data.drives || []);
      return response.data.drives || [];
    } catch (err) {
      console.error(`Failed to load Nextcloud drives for source ${sourceId}:`, err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
        setError('Authentication required. Please connect to Nextcloud.');
      } else {
        setError(err.message || 'Failed to load drives');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

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
   * Load items at a given folder path (empty string == root).
   */
  const loadItems = useCallback(async (folderPath = '', search = null) => {
    try {
      setLoading(true);
      setError(null);
      const params = {};
      if (folderPath) params.folderPath = folderPath;
      if (search && search.trim().length > 0) params.search = search.trim();
      const response = await apiClient.get('/integrations/nextcloud/items', { params });
      setItems(response.data.items || []);
      return response.data.items || [];
    } catch (err) {
      console.error('Failed to load Nextcloud items:', err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
        setError('Authentication required. Please connect to Nextcloud.');
      } else {
        setError(err.message || 'Failed to load items');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

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
      // Root is represented by an empty path; the breadcrumb uses the
      // drive's friendly label.
      setBreadcrumbs([{ id: '', name: drive.name, type: 'drive', path: '' }]);
      setSelectedFiles(new Map());
      await loadItems('');
    },
    [loadItems]
  );

  const navigateToFolder = useCallback(
    async folderItem => {
      if (!currentDrive) return;
      const newPath = folderItem.path || folderItem.name;
      setBreadcrumbs(prev => [
        ...prev,
        { id: folderItem.id, name: folderItem.name, type: 'folder', path: newPath }
      ]);
      setSelectedFiles(new Map());
      await loadItems(newPath);
    },
    [currentDrive, loadItems]
  );

  const navigateToBreadcrumb = useCallback(
    async index => {
      if (!currentDrive) return;
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      setBreadcrumbs(newBreadcrumbs);
      setSelectedFiles(new Map());
      const targetItem = newBreadcrumbs[newBreadcrumbs.length - 1];
      await loadItems(targetItem.path || '');
    },
    [currentDrive, breadcrumbs, loadItems]
  );

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

  const selectAllFiles = useCallback(() => {
    const fileItems = items.filter(item => !item.isFolder);
    const newMap = new Map();
    fileItems.forEach(item => {
      newMap.set(item.id, item);
    });
    setSelectedFiles(newMap);
  }, [items]);

  const deselectAllFiles = useCallback(() => {
    setSelectedFiles(new Map());
  }, []);

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

          if (item.size > maxFileSizeBytes) {
            console.warn(`File ${item.name} exceeds size limit, skipping`);
            continue;
          }

          try {
            const response = await apiClient.get('/integrations/nextcloud/download', {
              params: { filePath: item.path },
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
        console.error('Error during Nextcloud download:', err);
        setError(err.message || 'Failed to download files');
        return processedFiles;
      } finally {
        setDownloading({ active: false, current: 0, total: 0 });
      }
    },
    [currentDrive, selectedFiles]
  );

  const searchItems = useCallback(
    async query => {
      if (!currentDrive) return;
      setSearchQuery(query);
      const currentPath =
        breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 1].path || '' : '';
      if (query && query.trim().length > 0) {
        await loadItems(currentPath, query);
      } else {
        await loadItems(currentPath);
      }
    },
    [currentDrive, breadcrumbs, loadItems]
  );

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
