import CloudFileBrowserShell from './CloudFileBrowserShell';
import { useGoogleDriveBrowser } from '../hooks/useGoogleDriveBrowser';

/**
 * Spreadsheet/presentation MIME types use the document-text icon to
 * match the Drive UI. Other MIME types fall through to the shell's
 * default rules.
 */
const extraIcon = item => {
  const mimeType = item?.mimeType || '';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'document-text';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'document-text';
  return null;
};

const isGoogleDoc = item => item?.isGoogleDoc === true;

/**
 * Google Drive File Browser — thin wrapper around the shared
 * `CloudFileBrowserShell`. Provides the Google Drive-specific hook,
 * i18n keys, and predicates for the platform's virtual files
 * (`isGoogleDoc`).
 */
const GoogleDriveFileBrowser = props => (
  <CloudFileBrowserShell
    {...props}
    useBrowserHook={useGoogleDriveBrowser}
    isVirtualFile={isGoogleDoc}
    extraFileIconRule={extraIcon}
    i18nKeys={{
      notConnected: ['cloudStorage.googleDrive.notConnected', 'Google Drive Not Connected'],
      connectPrompt: [
        'cloudStorage.googleDrive.connectPrompt',
        'Connect your Google account to browse files from Google Drive, Shared Drives, and files shared with you'
      ],
      connect: ['cloudStorage.googleDrive.connect', 'Connect to Google Drive']
    }}
  />
);

export default GoogleDriveFileBrowser;
