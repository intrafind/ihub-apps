import { useCloudStorageBrowser } from './useCloudStorageBrowser';

/**
 * Predicate identifying Google's virtual "Google Docs" entries.
 *
 * Google Docs / Sheets / Slides have `size === 0` upstream because
 * they're not regular files — they export to a standard format at
 * download time. They're still attachable, just bypass the size cap
 * and the MIME filter. The shell consults this predicate when filtering,
 * scoring selectability, and rendering the size column.
 */
const isGoogleDoc = item => item?.isGoogleDoc === true;

/**
 * Google Drive adapter for the shared cloud-storage browser factory.
 */
export const useGoogleDriveBrowser = () =>
  useCloudStorageBrowser({
    basePath: '/integrations/googledrive',
    initialFolderTarget: null,
    buildFolderQuery: (target, drive) => {
      const params = { driveId: drive.id };
      if (target) params.folderId = target;
      // `sharedWithMe` is a synthetic source — the backend needs the
      // hint to query the Drive API's `sharedWithMe=true` filter.
      if (drive.id === 'sharedWithMe') params.source = 'sharedWithMe';
      return params;
    },
    buildDownloadQuery: item => ({ fileId: item.id }),
    buildBreadcrumbFromItem: folderItem => ({
      id: folderItem.id,
      name: folderItem.name,
      type: 'folder'
    }),
    buildBreadcrumbTarget: crumb => (crumb.type === 'drive' ? null : crumb.id),
    buildDriveBreadcrumb: drive => ({ id: drive.id, name: drive.name, type: 'drive' }),
    isVirtualFile: isGoogleDoc
  });
