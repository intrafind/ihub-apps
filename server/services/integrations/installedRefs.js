// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';

/**
 * The references the installed integrations occupy in the tool namespace:
 * each instance id (apps and groups select an installation's tools by it) and,
 * for an MCP installation with its own `toolPrefix`, the prefix's base. Read
 * from the cache, so it is cheap enough for every id-clash check.
 *
 * @returns {Array<{ id: string, toolPrefix?: string }>}
 */
export function installedIntegrationRefs() {
  const installed = configCache.getIntegrations?.()?.data?.installed || [];
  return installed
    .filter(instance => typeof instance?.id === 'string' && instance.id)
    .map(instance => ({
      id: instance.id,
      ...(typeof instance.values?.toolPrefix === 'string'
        ? { toolPrefix: instance.values.toolPrefix }
        : {})
    }));
}
