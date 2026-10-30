// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which knowledge provider serves a project: by its tier. An app, a
 * workflow or an agent never names a provider.
 *
 * @module services/knowledge/registry
 */
import { LocalKnowledgeProvider } from './LocalKnowledgeProvider.js';
import { KnowledgeError } from './types.js';

const providers = new Map();

/**
 * Register a provider for a tier.
 *
 * @param {string} tier - `ihub`, `ifinder`, …
 * @param {import('./KnowledgeProvider.js').KnowledgeProvider} provider
 */
export function registerKnowledgeProvider(tier, provider) {
  providers.set(tier, provider);
}

/**
 * The provider for a project.
 *
 * @param {Object} project
 * @returns {import('./KnowledgeProvider.js').KnowledgeProvider}
 * @throws {KnowledgeError} `NOT_SUPPORTED` when no provider serves the tier.
 */
export function providerFor(project) {
  const tier = project?.tier || 'ihub';
  const provider = providers.get(tier);
  if (!provider) {
    throw new KnowledgeError('NOT_SUPPORTED', `No knowledge provider for tier "${tier}"`, {
      projectId: project?.id
    });
  }
  return provider;
}

registerKnowledgeProvider('ihub', new LocalKnowledgeProvider());
// A smart collection of the iFinder tier is a project whose items are iFinder
// documents, read with the reader's own rights by the same link-kind fetch as
// an iFinder document added to a project by hand. The scope is the
// collection's id list, so nothing here needs a retrieval API of iFinder: the
// local provider serves it, read-only and searched, never loaded in full.
registerKnowledgeProvider(
  'ifinder',
  new LocalKnowledgeProvider({ readOnly: true, loadAll: false })
);
