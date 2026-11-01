// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Feeds the `McpClientManager` from the installed MCP integrations: at
 * startup (`server.js`), whenever `config/integrations.json` changes (the
 * reload hook) and whenever an MCP definition changes (`McpAdapter.onChanged`,
 * told by the registry reload paths). Disabled installations are handed over
 * as disabled servers, so their per-user tokens and registrations stay while
 * their tools are hidden.
 *
 * The manager's `initialize` walks and rewires its connections with awaits in
 * between, so two runs must not interleave: concurrent callers share one run,
 * and a caller that arrives during a run gets one more run after it, carrying
 * the latest installations (and an eager connect when any of them asked).
 */
import mcpClientManager from '../../../mcp/McpClientManager.js';
import installedIntegrationService from '../../InstalledIntegrationService.js';
import logger from '../../../../utils/logger.js';
import { mcpServersFromInstallations } from './serverConfig.js';

const COMPONENT = 'McpIntegrations';

/**
 * The manager config of every installed MCP integration.
 * @returns {Promise<{ servers: object[], security: object, invalid: Array }>}
 */
export async function mcpManagerConfig() {
  const resolved = [];
  for (const instance of installedIntegrationService.list()) {
    const entry = await installedIntegrationService.resolve(instance);
    // An incompatible definition offers no tools, so its server is not connected.
    if (entry?.definition?.protocol?.type === 'mcp' && !entry.incompatible) resolved.push(entry);
  }
  return mcpServersFromInstallations(resolved, installedIntegrationService.security());
}

/** The run in flight, the run queued behind it, and the options the queued run merges. */
let running = null;
let queued = null;
let queuedConnect = false;

/**
 * (Re)initialize the manager from the installations. Never throws: a broken
 * installation is logged and left out, the others keep working. Runs are
 * serialized (see the module comment).
 * @param {{ connect?: boolean }} [options] - also connect eagerly (the singleton worker)
 */
export async function initializeMcpFromInstallations({ connect = false } = {}) {
  if (running) {
    queuedConnect = queuedConnect || connect;
    queued ??= running.then(() => {
      queued = null;
      const options = { connect: queuedConnect };
      queuedConnect = false;
      return initializeMcpFromInstallations(options);
    });
    return queued;
  }
  running = runInitialization({ connect }).finally(() => {
    running = null;
  });
  return running;
}

async function runInitialization({ connect }) {
  try {
    const { servers, security, invalid } = await mcpManagerConfig();
    for (const { id, issues } of invalid) {
      logger.error('Installed MCP integration has invalid server settings; skipped', {
        component: COMPONENT,
        instanceId: id,
        issues: issues.map(i => `${i.path.join('.')}: ${i.message}`)
      });
    }
    await mcpClientManager.initialize({ servers, security });
    if (connect) {
      mcpClientManager.connectAll().catch(error => {
        logger.warn('Initial MCP connectAll failed', {
          component: COMPONENT,
          error: error.message
        });
      });
    }
  } catch (error) {
    logger.warn('MCP client manager could not be initialized from the installations', {
      component: COMPONENT,
      error: error.message
    });
  }
}
