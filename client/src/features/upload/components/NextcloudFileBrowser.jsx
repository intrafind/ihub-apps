import CloudFileBrowserShell from './CloudFileBrowserShell';
import { useNextcloudBrowser } from '../hooks/useNextcloudBrowser';

/**
 * Nextcloud File Browser — thin wrapper around the shared
 * `CloudFileBrowserShell`. Supplies the Nextcloud-specific hook and
 * i18n keys for the connect-prompt view; everything else is shared.
 */
const NextcloudFileBrowser = props => (
  <CloudFileBrowserShell
    {...props}
    useBrowserHook={useNextcloudBrowser}
    i18nKeys={{
      notConnected: ['cloudStorage.nextcloud.notConnected', 'Nextcloud Not Connected'],
      connectPrompt: [
        'cloudStorage.nextcloud.connectPrompt',
        'Connect your Nextcloud account to browse and attach files from your Nextcloud instance.'
      ],
      connect: ['cloudStorage.nextcloud.connect', 'Connect to Nextcloud']
    }}
  />
);

export default NextcloudFileBrowser;
