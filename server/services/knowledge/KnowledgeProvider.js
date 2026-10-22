// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * KnowledgeProvider — the one contract through which chats, agents and
 * workflows reach a project, whichever tier backs it (#1036, spec 2 §1).
 *
 * A provider answers for a project: what it holds (`list`), the passages
 * that match a question (`search`), one document's text (`read`), every
 * document's text when it fits (`loadAll`), and it stores what a run wrote
 * back (`put`). Access was decided before any call reaches it: the provider
 * trusts the project it is handed and never checks a user's permissions.
 *
 * `local` (BM25 over stored text) is the phase 1 implementation; `ifinder`
 * follows in phase 2 and OpenSearch or Qdrant later, all behind this class.
 * Every method throws {@link KnowledgeError} `NOT_SUPPORTED` unless a
 * provider overrides it; `capabilities()` says which ones it did.
 *
 * @module services/knowledge/KnowledgeProvider
 */
import { KnowledgeError } from './types.js';

/**
 * @typedef {Object} KnowledgeContext
 * @property {Object} user - The reading user (link items are fetched with their rights).
 * @property {string} [chatId]
 * @property {string} [language]
 * @property {{type: 'chat'|'workflow'|'agent', id: string, nodeId?: string}|null} [run]
 * @property {'chat'|'workflow'|'agent'|'ui'} [purpose]
 * @property {string} [query] - The model's query, for items whose reference leaves it open.
 */

/**
 * @typedef {Object} KnowledgeDoc
 * @property {string} id - The item id.
 * @property {string} projectId
 * @property {string} kind
 * @property {string} name
 * @property {string} status
 * @property {boolean} pinned
 * @property {number|null} chars
 * @property {number|null} tokens
 * @property {string|null} url
 * @property {Object} provenance
 * @property {string|null} snapshotAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} KnowledgePassage
 * @property {string} docId
 * @property {string} projectId
 * @property {string} sectionId
 * @property {string} title
 * @property {string[]} path
 * @property {string} part - `n/m`
 * @property {string} text
 * @property {number} score
 * @property {number} chars
 */

export class KnowledgeProvider {
  /** Registry id of the provider. */
  get id() {
    throw new KnowledgeError('NOT_SUPPORTED', 'KnowledgeProvider.id is not implemented');
  }

  /**
   * What this provider can do for a project.
   *
   * @param {Object} _project
   * @returns {{loadAll: boolean, iterate: boolean, search: boolean, passages: boolean,
   *   preview: 'text'|'pdf'|false, write: boolean}}
   */
  capabilities(_project) {
    return {
      loadAll: false,
      iterate: false,
      search: false,
      passages: false,
      preview: false,
      write: false
    };
  }

  /**
   * The documents of a project, usable ones first.
   *
   * @param {Object} _project
   * @param {KnowledgeContext} _ctx
   * @param {{cursor?: string|null, limit?: number}} [_options]
   * @returns {Promise<{items: KnowledgeDoc[], nextCursor: string|null}>}
   */
  async list(_project, _ctx, _options = {}) {
    throw new KnowledgeError('NOT_SUPPORTED', 'This project cannot be listed');
  }

  /**
   * The passages that match a question.
   *
   * @param {Object} _project
   * @param {KnowledgeContext} _ctx
   * @param {{query: string, limit?: number, itemIds?: string[], budgetChars?: number}} _options
   * @returns {Promise<{hits: KnowledgePassage[], unavailable: Array<{document: string, name: string, reason: string}>, retrieval: Object}>}
   */
  async search(_project, _ctx, _options) {
    throw new KnowledgeError('NOT_SUPPORTED', 'This project cannot be searched');
  }

  /**
   * One document's text, or a section of it, within a budget.
   *
   * @param {Object} _project
   * @param {KnowledgeContext} _ctx
   * @param {{itemId: string}} _docRef
   * @param {{section?: string, budgetChars?: number}} [_options]
   * @returns {Promise<{doc: KnowledgeDoc, text: string, retrieval: Object}>}
   */
  async read(_project, _ctx, _docRef, _options = {}) {
    throw new KnowledgeError('NOT_SUPPORTED', 'This project cannot be read');
  }

  /**
   * Every usable document's text.
   *
   * @param {Object} _project
   * @param {KnowledgeContext} _ctx
   * @param {{itemIds?: string[]}} [_options]
   * @returns {Promise<{docs: Array<{doc: KnowledgeDoc, text: string}>, unavailable: Array, tokens: number}>}
   */
  async loadAll(_project, _ctx, _options = {}) {
    throw new KnowledgeError('NOT_SUPPORTED', 'This project cannot be loaded in full');
  }

  /**
   * Store a document a run wrote.
   *
   * @param {Object} _project
   * @param {KnowledgeContext} _ctx
   * @param {{name: string, text: string, contentType?: string, pinned?: boolean,
   *   wait?: boolean}} _input - `wait` holds the call until the document is ready.
   * @returns {Promise<KnowledgeDoc>}
   */
  async put(_project, _ctx, _input) {
    throw new KnowledgeError('NOT_SUPPORTED', 'This project cannot be written to');
  }

  /**
   * Remove a document a run wrote.
   *
   * @param {Object} _project
   * @param {KnowledgeContext} _ctx
   * @param {{itemId: string}} _docRef
   * @returns {Promise<boolean>}
   */
  async remove(_project, _ctx, _docRef) {
    throw new KnowledgeError('NOT_SUPPORTED', 'This project cannot be changed');
  }
}

export default KnowledgeProvider;
