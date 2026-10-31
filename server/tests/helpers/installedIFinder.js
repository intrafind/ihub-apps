// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helper: the iFinder and iAssistant installations (`integrations.json`)
 * that a platform-shaped `{ iFinder, iAssistant }` fixture describes. Tests
 * written against `platform.iFinder` keep their fixtures and stub the
 * installations with one call.
 */
import {
  iFinderInstanceFrom,
  iAssistantInstanceFrom
} from '../../migrations/V192__ifinder_iassistant_installed_integrations.js';

/** The `integrations.json` content for a `{ iFinder, iAssistant }` fixture. */
export function installationsFor(platformLike = {}) {
  const installed = [];
  if (platformLike.iFinder) {
    // Test fixtures mostly leave `enabled` out and mean "on"; the migration
    // itself reads the explicit flag platform.json always carried.
    installed.push({
      ...iFinderInstanceFrom(platformLike.iFinder),
      enabled: platformLike.iFinder.enabled !== false
    });
  }
  if (platformLike.iFinder || platformLike.iAssistant) {
    installed.push({
      ...iAssistantInstanceFrom(platformLike.iAssistant || {}, platformLike.iFinder || {}),
      enabled: platformLike.iFinder?.enabled !== false
    });
  }
  return { installed, security: { blockPrivateIps: true, allowedHosts: [] } };
}

/**
 * Make `configCache.getIntegrations()` answer with the installations of the
 * fixture `getPlatform()` returns (a getter, so a test may swap the fixture).
 * Returns a function that restores the original.
 */
export function stubInstallations(configCache, getPlatform) {
  const original = configCache.getIntegrations;
  configCache.getIntegrations = () => ({
    data: installationsFor(getPlatform() || {}),
    etag: 'test'
  });
  return () => {
    configCache.getIntegrations = original;
  };
}
