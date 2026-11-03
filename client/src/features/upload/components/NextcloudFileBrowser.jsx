// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import CloudFileBrowserShell from './CloudFileBrowserShell';
import { useNextcloudBrowser } from '../hooks/useNextcloudBrowser';

/**
 * Nextcloud File Browser — thin wrapper around the shared
 * `CloudFileBrowserShell`. Supplies the Nextcloud-specific hook; everything
 * else (the Connect card included) is shared.
 */
const NextcloudFileBrowser = props => (
  <CloudFileBrowserShell {...props} useBrowserHook={useNextcloudBrowser} />
);

export default NextcloudFileBrowser;
