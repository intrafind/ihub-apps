// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who may fetch a document from an integration, and from which one.
 *
 * An installed integration whose definition declares the `files` capability and
 * whose native connector implements it (`connector.files.content`, optionally
 * `.metadata` and `.configured`) hands over documents by reference. This
 * module resolves an installation id to that implementation and checks, before
 * anything runs, that the installation
 *
 * - exists and its definition has the capability (`INTEGRATION_NOT_FOUND`, 404),
 * - is switched on and configured (`INTEGRATION_NOT_CONFIGURED`, 404),
 * - is granted to the user's groups (`INTEGRATION_NOT_GRANTED`, 403;
 *   `permissions.integrations`, see `integrationAccess.js`).
 *
 * It serves `GET /api/integrations/:integration/files/*` and, so that a source whose
 * provider is an installation gets the same gate, `GET /api/sources/:provider/*`
 * (`resolveDocumentProvider`).
 *
 * @module services/integrations/documentAccess
 */
import configCache from '../../configCache.js';
import integrationRegistry from './definitions/IntegrationRegistry.js';
import { getConnector } from './protocols/native/connectors/index.js';
import { mayUseIntegration, typeOfInstallation } from './integrationAccess.js';
import { getSourceProvider, hasSourceProvider } from '../sources/providers.js';

/** The capability a definition declares to hand over documents by reference. */
export const FILES_CAPABILITY = 'files';

export class DocumentAccessError extends Error {
  /**
   * @param {number} status
   * @param {string} code - `INTEGRATION_NOT_FOUND` | `INTEGRATION_NOT_CONFIGURED` | `INTEGRATION_NOT_GRANTED`
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'DocumentAccessError';
    this.status = status;
    this.code = code;
  }
}

function installedList() {
  try {
    return configCache.getIntegrations?.()?.data?.installed || [];
  } catch {
    return [];
  }
}

/** The `files` implementation of an installation's native connector, or null. */
function filesOf(definition) {
  if (!definition?.capabilities?.includes(FILES_CAPABILITY)) return null;
  if (definition.protocol?.type !== 'native') return null;
  const files = getConnector(definition.protocol.module)?.files;
  return files && typeof files.content === 'function' ? files : null;
}

/**
 * The installation that hands over documents, after the gate.
 *
 * @param {string} id - installation id
 * @param {Object} user - the signed-in user (with `permissions`)
 * @returns {{instance: Object, definition: Object, files: Object}}
 * @throws {DocumentAccessError}
 */
export function resolveFilesIntegration(id, user) {
  const instance = installedList().find(entry => entry?.id === id);
  const definition = instance ? integrationRegistry.get(instance.definition)?.definition : null;
  const files = filesOf(definition);
  if (!instance || !files) {
    throw new DocumentAccessError(404, 'INTEGRATION_NOT_FOUND', 'No such integration');
  }
  if (instance.enabled === false || (files.configured && !files.configured(instance))) {
    throw new DocumentAccessError(
      404,
      'INTEGRATION_NOT_CONFIGURED',
      'This integration is not configured'
    );
  }
  if (!mayUseIntegration(instance, user)) {
    throw new DocumentAccessError(
      403,
      'INTEGRATION_NOT_GRANTED',
      'Your groups may not use this integration'
    );
  }
  return { instance, definition, files };
}

/**
 * What the probe answers: enough for the client to match an app's bindings
 * (`app.integrations` key: the id, the definition id or `type:<type>`).
 *
 * @param {{instance: Object, definition: Object}} resolved
 * @returns {{id: string, definition: string, type: string|null, name: Object|string}}
 */
export function describeFilesIntegration({ instance, definition }) {
  return {
    id: instance.id,
    definition: definition.id,
    type: typeOfInstallation(instance),
    name: instance.label || definition.name || instance.id
  };
}

/**
 * The provider (`{ content, metadata? }`) a document route acts through, for an
 * id that is either an installation or a source provider.
 *
 * A provider that is an installation (the `files` capability) or that names
 * one (`provider.integration`, the `ifinder` adapter) passes the gate of
 * {@link resolveFilesIntegration} and is served by the installation's
 * connector; any other provider (`project`, one a test or a third party
 * registered) is returned as it is and keeps its own access rules (the
 * project provider checks membership).
 *
 * @param {string} id
 * @param {Object} user
 * @returns {Promise<Object|null>} null when nothing has this id
 * @throws {DocumentAccessError}
 */
export async function resolveDocumentProvider(id, user) {
  const provider = hasSourceProvider(id) ? await getSourceProvider(id) : null;
  const installed = installedList().some(entry => entry?.id === id);
  const gateId = provider?.integration || (installed && !provider ? id : null);
  if (!gateId) return provider;
  const { files } = resolveFilesIntegration(gateId, user);
  return { id, content: files.content, metadata: files.metadata };
}

/**
 * What the probe answers for an id after {@link resolveDocumentProvider}: the
 * installation's description, or just the id for a provider that is not one.
 *
 * @param {string} id
 * @returns {{id: string, definition: string|null, type: string|null, name: Object|string}}
 */
export function describeDocumentProvider(id) {
  const instance = installedList().find(entry => entry?.id === id);
  const definition = instance ? integrationRegistry.get(instance.definition)?.definition : null;
  if (instance && filesOf(definition)) return describeFilesIntegration({ instance, definition });
  return { id, definition: null, type: null, name: id };
}
