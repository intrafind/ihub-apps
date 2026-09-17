import CloudFileBrowserShell from './CloudFileBrowserShell';
import { useOffice365Browser } from '../hooks/useOffice365Browser';

/**
 * Office 365 File Browser — thin wrapper around the shared
 * `CloudFileBrowserShell`. Supplies the Office 365-specific hook and
 * i18n keys; navigation, sort, search, selection and download are all
 * handled by the shell.
 */
const Office365FileBrowser = props => (
  <CloudFileBrowserShell
    {...props}
    useBrowserHook={useOffice365Browser}
    i18nKeys={{
      notConnected: ['cloudStorage.notConnected', 'Office 365 Not Connected'],
      connectPrompt: [
        'cloudStorage.connectPrompt',
        'Connect your Microsoft account to browse files from OneDrive, SharePoint, and Teams'
      ],
      connect: ['cloudStorage.connect', 'Connect to Office 365']
    }}
  />
);

export default Office365FileBrowser;
