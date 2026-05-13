import { useCloudStorageBrowser } from './useCloudStorageBrowser';

/**
 * Nextcloud adapter for the shared cloud-storage browser factory.
 *
 * Nextcloud is WebDAV (path-based) rather than Microsoft Graph / Google
 * Drive (id-based), so folders and files are identified by a slash-joined
 * relative path. Root is the empty string.
 */
export const useNextcloudBrowser = () =>
  useCloudStorageBrowser({
    basePath: '/integrations/nextcloud',
    initialFolderTarget: '',
    buildFolderQuery: target => {
      const params = {};
      if (target) params.folderPath = target;
      return params;
    },
    buildDownloadQuery: item => ({ filePath: item.path }),
    buildBreadcrumbFromItem: folderItem => ({
      id: folderItem.id,
      name: folderItem.name,
      type: 'folder',
      path: folderItem.path || folderItem.name
    }),
    buildBreadcrumbTarget: crumb => crumb.path || '',
    buildDriveBreadcrumb: drive => ({
      id: drive.id || '',
      name: drive.name,
      type: 'drive',
      path: ''
    })
  });
