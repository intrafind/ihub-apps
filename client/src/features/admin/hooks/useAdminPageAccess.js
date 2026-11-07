// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

/**
 * Which pages of the models area the admin may open. The routes are registered
 * per page (`admin.pages.<key>` in platform.json, `false` hides one), so a link to
 * a hidden page ends on "not found" and must not be offered.
 *
 * @returns {{ models: boolean, providers: boolean }}
 */
export default function useAdminPageAccess() {
  const pages = usePlatformConfig()?.platformConfig?.admin?.pages || {};
  return { models: pages.models !== false, providers: pages.providers !== false };
}
