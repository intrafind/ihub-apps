// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Feeds the `A2aClientManager` from the installed A2A integrations: at
 * startup and whenever `config/integrations.json` or a definition changes.
 */
import a2aClientManager from '../../../a2a/A2aClientManager.js';
import installedIntegrationService from '../../InstalledIntegrationService.js';
import logger from '../../../../utils/logger.js';
import { a2aAgentsFromInstallations } from './agentConfig.js';

const COMPONENT = 'A2aIntegrations';

/** The manager config of every installed A2A integration. */
export async function a2aManagerConfig() {
  const resolved = [];
  for (const instance of installedIntegrationService.list()) {
    const entry = await installedIntegrationService.resolve(instance);
    if (entry?.definition?.protocol?.type === 'a2a') resolved.push(entry);
  }
  return a2aAgentsFromInstallations(resolved, installedIntegrationService.security());
}

/**
 * (Re)initialize the manager from the installations. Never throws.
 * @param {{ warmUp?: boolean }} [options] - also fetch the cards in the background
 */
export async function initializeA2aFromInstallations({ warmUp = false } = {}) {
  try {
    const { agents, security, invalid } = await a2aManagerConfig();
    for (const { id, issues } of invalid) {
      logger.error('Installed A2A integration has invalid agent settings; skipped', {
        component: COMPONENT,
        instanceId: id,
        issues: issues.map(i => `${i.path.join('.')}: ${i.message}`)
      });
    }
    await a2aClientManager.initialize({ agents, security });
    if (warmUp) {
      a2aClientManager.warmUp().catch(error => {
        logger.warn('Initial A2A Agent Card fetch failed', {
          component: COMPONENT,
          error: error.message
        });
      });
    }
  } catch (error) {
    logger.warn('A2A client manager could not be initialized from the installations', {
      component: COMPONENT,
      error: error.message
    });
  }
}
