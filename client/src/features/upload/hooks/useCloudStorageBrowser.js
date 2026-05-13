import { useState, useCallback, useMemo } from 'react';
import { apiClient } from '../../../api/client';
import { processCloudFile } from '../utils/cloudFileProcessing';

/**
 * Shared state-management factory for the three cloud-storage file
 * browsers (Office 365, Google Drive, Nextcloud).
 *
 * Each provider passes an `adapter` object that captures the differences
 * between the three implementations — the navigation model (id-based
 * Graph/Drive vs path-based WebDAV), the shape of API query parameters,
 * the breadcrumb data model, and any provider-specific item predicates
 * (e.g. Google's virtual `isGoogleDoc` items that have no size).
 *
 * The factory owns the state bag, the selection map, the debounced
 * search effect inputs (the debounce itself lives in the shell), the
 * download orchestration, and the breadcrumb stack. Callers only have
 * to define how a folder/file query is built and how breadcrumbs map
 * back to their navigation target.
 */
export function useCloudStorageBrowser(adapter, options = {}) {
  const {
    basePath,
    buildFolderQuery,
    buildDownloadQuery,
    buildBreadcrumbFromItem,
    buildBreadcrumbTarget,
    buildDriveBreadcrumb,
    initialFolderTarget,
    isVirtualFile
  } = adapter;
  // `providerId` is the cloud-storage provider's stable id from
  // platform.json. The server uses it to scope token files so a user
  // can connect to e.g. two Office 365 tenants concurrently.
  const providerId = options.providerId || null;
  // Memoised so it can be listed in callback deps without retriggering
  // every render of the consuming component.
  const baseQuery = useMemo(() => (providerId ? { providerId } : {}), [providerId]);

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
  // Tracks whether the current drive view came from auto-skipping the
  // drive selection step (sources with exactly one drive). Affects the
  // "back" affordance: skip the empty drive list and go straight to
  // sources.
  const [autoSkippedDrives, setAutoSkippedDrives] = useState(false);

  const checkAuthStatus = useCallback(async () => {
    try {
      setAuthStatus('checking');
      const response = await apiClient.get(`${basePath}/status`, { params: baseQuery });
      setAuthStatus(response.data.connected ? 'connected' : 'not_connected');
      return response.data.connected;
    } catch (err) {
      console.error(`${basePath} auth status check failed:`, err);
      if (err.response?.status === 401) {
        setAuthStatus('not_connected');
      } else {
        setAuthStatus('error');
        setError(err.message || 'Failed to check authentication status');
      }
      return false;
    }
  }, [basePath, baseQuery]);

  const handleAuthError = useCallback(message => {
    setAuthStatus('not_connected');
    setError(message);
  }, []);

  const loadSources = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.get(`${basePath}/sources`, { params: baseQuery });
      setSources(response.data.sources || []);
      return response.data.sources || [];
    } catch (err) {
      console.error(`Failed to load sources for ${basePath}:`, err);
      if (err.response?.status === 401) {
        handleAuthError('Authentication required.');
      } else {
        setError(err.message || 'Failed to load sources');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, [basePath, baseQuery, handleAuthError]);

  const loadDrivesForSource = useCallback(
    async sourceId => {
      try {
        setLoading(true);
        setError(null);
        setCurrentSource(sourceId);
        const response = await apiClient.get(`${basePath}/drives/${sourceId}`, {
          params: baseQuery
        });
        const result = response.data.drives || [];
        setDrives(result);
        return result;
      } catch (err) {
        console.error(`Failed to load drives for source ${sourceId}:`, err);
        if (err.response?.status === 401) {
          handleAuthError('Authentication required.');
        } else {
          setError(err.message || 'Failed to load drives');
        }
        return [];
      } finally {
        setLoading(false);
      }
    },
    [basePath, baseQuery, handleAuthError]
  );

  const goBackToSources = useCallback(() => {
    setCurrentSource(null);
    setDrives([]);
    setCurrentDrive(null);
    setBreadcrumbs([]);
    setItems([]);
    setSelectedFiles(new Map());
    setSearchQuery('');
    setAutoSkippedDrives(false);
  }, []);

  const loadItems = useCallback(
    async (drive, target, search = null) => {
      if (!drive) return [];
      try {
        setLoading(true);
        setError(null);
        const params = { ...baseQuery, ...buildFolderQuery(target, drive) };
        if (search && search.trim().length > 0) {
          params.search = search.trim();
        }
        const response = await apiClient.get(`${basePath}/items`, { params });
        setItems(response.data.items || []);
        return response.data.items || [];
      } catch (err) {
        console.error('Failed to load items:', err);
        if (err.response?.status === 401) {
          handleAuthError('Authentication required.');
        } else {
          setError(err.message || 'Failed to load items');
        }
        return [];
      } finally {
        setLoading(false);
      }
    },
    [basePath, baseQuery, buildFolderQuery, handleAuthError]
  );

  const selectDrive = useCallback(
    async drive => {
      if (!drive) {
        setCurrentDrive(null);
        setBreadcrumbs([]);
        setItems([]);
        setSelectedFiles(new Map());
        setSearchQuery('');
        setAutoSkippedDrives(false);
        return;
      }
      setCurrentDrive(drive);
      setBreadcrumbs([buildDriveBreadcrumb(drive)]);
      setSelectedFiles(new Map());
      await loadItems(drive, initialFolderTarget);
    },
    [buildDriveBreadcrumb, initialFolderTarget, loadItems]
  );

  /**
   * Pick a source category. If the source resolves to exactly one
   * drive (e.g. Nextcloud's single user drive, Google's `myDrive`),
   * we auto-select it so the user isn't asked to choose between one
   * option. `autoSkippedDrives` is recorded so the file view's "Back"
   * button can jump straight back to the source list.
   */
  const selectSource = useCallback(
    async sourceId => {
      const result = await loadDrivesForSource(sourceId);
      if (result.length === 1) {
        setAutoSkippedDrives(true);
        await selectDrive(result[0]);
      } else {
        setAutoSkippedDrives(false);
      }
    },
    [loadDrivesForSource, selectDrive]
  );

  const navigateToFolder = useCallback(
    async folderItem => {
      if (!currentDrive) return;
      const next = buildBreadcrumbFromItem(folderItem);
      setBreadcrumbs(prev => [...prev, next]);
      setSelectedFiles(new Map());
      await loadItems(currentDrive, buildBreadcrumbTarget(next));
    },
    [currentDrive, buildBreadcrumbFromItem, buildBreadcrumbTarget, loadItems]
  );

  const navigateToBreadcrumb = useCallback(
    async index => {
      if (!currentDrive) return;
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      setBreadcrumbs(newBreadcrumbs);
      setSelectedFiles(new Map());
      const target = newBreadcrumbs[newBreadcrumbs.length - 1];
      await loadItems(currentDrive, buildBreadcrumbTarget(target));
    },
    [currentDrive, breadcrumbs, buildBreadcrumbTarget, loadItems]
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
    const newMap = new Map();
    items
      .filter(item => !item.isFolder)
      .forEach(item => {
        newMap.set(item.id, item);
      });
    setSelectedFiles(newMap);
  }, [items]);

  const deselectAllFiles = useCallback(() => {
    setSelectedFiles(new Map());
  }, []);

  const downloadAndProcessFiles = useCallback(
    async uploadConfig => {
      if (!currentDrive || selectedFiles.size === 0) return [];

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

          // Provider-specific virtual files (e.g. Google Docs) export
          // to a standard MIME at download time and have no
          // upstream-reported size. The cap check skips them; the
          // server enforces a hard cap regardless.
          const virtual = isVirtualFile?.(item) === true;
          if (!virtual && item.size > maxFileSizeBytes) {
            console.warn(`File ${item.name} exceeds size limit, skipping`);
            continue;
          }

          try {
            const response = await apiClient.get(`${basePath}/download`, {
              params: { ...baseQuery, ...buildDownloadQuery(item, currentDrive) },
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
    [basePath, baseQuery, buildDownloadQuery, currentDrive, isVirtualFile, selectedFiles]
  );

  const searchItems = useCallback(
    async query => {
      if (!currentDrive) return;
      setSearchQuery(query);
      const target =
        breadcrumbs.length > 1
          ? buildBreadcrumbTarget(breadcrumbs[breadcrumbs.length - 1])
          : initialFolderTarget;
      const effectiveQuery = query && query.trim().length > 0 ? query : null;
      await loadItems(currentDrive, target, effectiveQuery);
    },
    [breadcrumbs, buildBreadcrumbTarget, currentDrive, initialFolderTarget, loadItems]
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
    setAutoSkippedDrives(false);
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
    autoSkippedDrives,
    checkAuthStatus,
    loadSources,
    loadDrivesForSource,
    selectSource,
    goBackToSources,
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
}
