// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import CloudFileBrowserShell from './CloudFileBrowserShell';
import { useOffice365Browser } from '../hooks/useOffice365Browser';

/**
 * Office 365 File Browser — thin wrapper around the shared
 * `CloudFileBrowserShell`. Supplies the Office 365-specific hook;
 * navigation, sort, search, selection, download and the Connect card are
 * handled by the shell.
 */
const Office365FileBrowser = props => (
  <CloudFileBrowserShell {...props} useBrowserHook={useOffice365Browser} />
);

export default Office365FileBrowser;
