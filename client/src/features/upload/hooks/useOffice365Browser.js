import { useCloudStorageBrowser } from './useCloudStorageBrowser';

/**
 * Office 365 adapter for the shared cloud-storage browser factory.
 *
 * Office 365 (Microsoft Graph) is id-based: drives, folders, and files
 * are addressed by opaque `driveId` / `folderId` / `fileId`. There are
 * multiple drives per source (OneDrive, SharePoint sites, Teams).
 */
export const useOffice365Browser = () =>
  useCloudStorageBrowser({
    basePath: '/integrations/office365',
    initialFolderTarget: null,
    buildFolderQuery: (target, drive) => {
      const params = { driveId: drive.id };
      if (target) params.folderId = target;
      return params;
    },
    buildDownloadQuery: (item, drive) => ({ fileId: item.id, driveId: drive.id }),
    buildBreadcrumbFromItem: folderItem => ({
      id: folderItem.id,
      name: folderItem.name,
      type: 'folder'
    }),
    buildBreadcrumbTarget: crumb => (crumb.type === 'drive' ? null : crumb.id),
    buildDriveBreadcrumb: drive => ({ id: drive.id, name: drive.name, type: 'drive' })
  });
