// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import path from 'node:path';
import logger from '../../../utils/logger.js';
import { resolveAndValidatePath } from '../../../utils/pathSecurity.js';
import integrationRegistry from '../definitions/IntegrationRegistry.js';
import installedIntegrationService, { IntegrationError } from '../InstalledIntegrationService.js';
import { getProtocolAdapter } from '../protocols/index.js';
import { currentActionsOf } from '../actionReview.js';
import { actionReviewState } from '../../../utils/actionFingerprint.js';
import { parseOpenApiText } from '../../tools/openApiText.js';
import { sideEffectOfMethod } from '../protocols/http/HttpAdapter.js';
import {
  isCustomDefinitionId,
  validateIntegrationDefinition
} from '../../../validators/integrationDefinitionSchema.js';
import { validateBuilderDraft } from '../../../validators/integrationBuilderSchema.js';
import {
  BuilderError,
  OPENAPI_DOCUMENT_FILE,
  SCRIPT_MODULE_FILE,
  draftToPackage,
  exportPackage,
  packageToDraft
} from './builderPackage.js';

/**
 * The integration builder (**Admin → Integrations → Add manually**): custom
 * integrations from an OpenAPI document, an MCP server, an A2A agent card, an
 * HTTP request template or a JavaScript module (Unified Integrations
 * concept 03 §6.8, 04 §4).
 *
 * A custom integration is an ordinary definition folder under
 * `contents/integration-definitions/custom__<id>/` plus an ordinary
 * installation in `config/integrations.json`: the builder writes both
 * through the existing `IntegrationRegistry` and `InstalledIntegrationService`
 * and keeps no store of its own. Everything else (tools, bindings, group
 * access, approval, the installation page, tests) works as for any other
 * integration.
 *
 * @module services/integrations/builder/IntegrationBuilderService
 */

const COMPONENT = 'IntegrationBuilder';
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function invalidDraft(errors) {
  return new BuilderError('Invalid integration draft', {
    code: 'INVALID_DRAFT',
    details: errors.map(e => ({ path: e.path, message: e.message }))
  });
}

/** Read a companion of a definition folder as text, or null. */
async function readCompanion(dir, relPath) {
  const target = await resolveAndValidatePath(relPath, dir);
  if (!target) return null;
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/** Every file of a definition folder except `integration.json`: relative path → text. */
async function readCompanions(dir) {
  const out = {};
  async function walk(current, prefix) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else if (entry.isFile() && rel !== 'integration.json') {
        out[rel] = await fs.readFile(path.join(current, entry.name), 'utf8');
      }
    }
  }
  await walk(dir, '');
  return out;
}

/**
 * The operations of an OpenAPI document, as the builder lists them: one row
 * per operation with its method, path, summary, parameters and the side
 * effect its method suggests.
 *
 * @param {Object} spec - a dereferenced OpenAPI document
 * @returns {Array<Object>}
 */
export function listOpenApiOperations(spec) {
  const operations = [];
  for (const [opPath, pathItem] of Object.entries(spec?.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of OPENAPI_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      operations.push({
        operationId: op.operationId,
        method,
        path: opPath,
        summary: op.summary || op.description || '',
        parameters: [...shared, ...(op.parameters || [])].map(p => ({
          name: p.name,
          in: p.in,
          required: Boolean(p.required)
        })),
        hasRequestBody: Boolean(op.requestBody),
        sideEffect: sideEffectOfMethod(method)
      });
    }
  }
  return operations;
}

export class IntegrationBuilderService {
  constructor({
    registry = integrationRegistry,
    installations = installedIntegrationService
  } = {}) {
    this.registry = registry;
    this.installations = installations;
  }

  /**
   * The installation and the definition entry of a custom integration.
   * @throws {BuilderError} 404 when it is not installed, 400 when it is not custom
   */
  async _customOf(instanceId) {
    await this.registry.ensureLoaded();
    const instance = this.installations.get(instanceId);
    if (!instance) {
      throw new BuilderError('Integration not found', { status: 404, code: 'NOT_FOUND' });
    }
    if (!isCustomDefinitionId(instance.definition)) {
      throw new BuilderError(
        `"${instanceId}" is an installation of ${instance.definition}, not a custom integration`,
        { code: 'NOT_CUSTOM' }
      );
    }
    const entry = this.registry.get(instance.definition);
    if (!entry || entry.source !== 'installed') {
      throw new BuilderError(`The definition ${instance.definition} is missing`, {
        status: 404,
        code: 'UNKNOWN_DEFINITION'
      });
    }
    return { instance, entry };
  }

  /** The raw `integration.json` of a definition folder (not the parsed one, which carries defaults). */
  async _rawDefinition(entry) {
    const text = await readCompanion(entry.dir, 'integration.json');
    return text ? JSON.parse(text) : entry.definition;
  }

  /**
   * The draft of a custom integration, for the builder to edit.
   * @param {string} instanceId
   * @param {{ language?: string }} [options]
   */
  async load(instanceId, { language = 'en' } = {}) {
    const { instance, entry } = await this._customOf(instanceId);
    const definition = await this._rawDefinition(entry);
    let moduleSource;
    let document;
    if (definition.protocol.type === 'script') {
      moduleSource = (await readCompanion(entry.dir, definition.protocol.module)) || '';
    }
    if (definition.protocol.type === 'openapi' && !/^https?:/i.test(definition.protocol.document)) {
      document = entry.document || null;
      const text = await readCompanion(entry.dir, definition.protocol.document);
      if (text) {
        try {
          document = parseOpenApiText(text);
        } catch {
          // The registry parsed it when it loaded; keep that.
        }
      }
    }
    let liveActions = [];
    const adapter = getProtocolAdapter(definition.protocol.type);
    if (adapter?.dynamicActions) {
      try {
        liveActions = await adapter.discoverActions({
          definition: entry.definition,
          instance,
          language
        });
      } catch (error) {
        logger.info('Builder: the remote actions could not be listed', {
          component: COMPONENT,
          instanceId,
          error: error.message
        });
      }
    }
    return packageToDraft({ definition, instance, moduleSource, document, liveActions });
  }

  /**
   * Create a custom integration: its definition folder, then its
   * installation. When the installation is refused, the folder is removed
   * again, so nothing half-made stays behind.
   *
   * @param {unknown} payload - the builder draft
   * @param {{ language?: string }} [options]
   * @returns {Promise<{ instance: Object, definition: Object }>}
   */
  async create(payload, { language = 'en' } = {}) {
    const parsed = validateBuilderDraft(payload);
    if (!parsed.success) throw invalidDraft(parsed.errors);
    const draft = { ...parsed.data, definitionId: undefined };
    await this.registry.ensureLoaded();
    if (this.installations.get(draft.instanceId)) {
      throw new BuilderError(`An integration with id "${draft.instanceId}" exists`, {
        status: 409,
        code: 'DUPLICATE_ID'
      });
    }
    const pkg = draftToPackage(draft);
    if (this.registry.get(pkg.definitionId)) {
      throw new BuilderError(`The definition ${pkg.definitionId} exists already`, {
        status: 409,
        code: 'DUPLICATE_DEFINITION'
      });
    }
    this._checkDefinition(pkg);
    await this.registry.writeInstalled(pkg.definitionId, pkg.files, { local: true });
    try {
      const instance = await this.installations.create(pkg.installation, { language });
      await this._definitionsChanged(pkg.definitionId);
      return { instance, definition: pkg.definition };
    } catch (error) {
      await this.registry.removeInstalled(pkg.definitionId).catch(() => {});
      throw error;
    }
  }

  /**
   * Save a custom integration: the definition folder moves in with a new
   * patch version, then the installation is saved against it. When the
   * installation is refused, the previous folder is put back.
   *
   * @param {string} instanceId
   * @param {unknown} payload - the builder draft
   * @param {{ language?: string }} [options]
   */
  async update(instanceId, payload, { language = 'en' } = {}) {
    const parsed = validateBuilderDraft({ ...(payload || {}), instanceId });
    if (!parsed.success) throw invalidDraft(parsed.errors);
    const { instance: existing, entry } = await this._customOf(instanceId);
    const previous = await this._rawDefinition(entry);
    const pkg = draftToPackage(
      { ...parsed.data, definitionId: existing.definition },
      { previous, existingInstance: existing }
    );
    this._checkDefinition(pkg);
    const staged = await this.registry.stageInstalled(pkg.definitionId, pkg.files, {
      local: true
    });
    const { previous: kept } = await this.registry.commitStaged(staged, { keepPrevious: true });
    await this.registry.reload();
    let instance;
    try {
      instance = await this.installations.update(instanceId, pkg.installation, { language });
    } catch (error) {
      await this.registry.restorePrevious(staged, kept);
      await this.registry.reload();
      throw error;
    }
    await this.registry.dropPrevious(pkg.definitionId, kept);
    this.registry._announce();
    await this._definitionsChanged(pkg.definitionId);
    if (['openapi', 'http', 'script'].includes(parsed.data.source)) {
      instance = await this._acceptEditedActions(instanceId, language, instance);
    }
    return { instance, definition: pkg.definition };
  }

  /**
   * The actions an admin just edited in the builder are reviewed by that edit.
   *
   * For an openapi, http or script integration the definition is the builder's
   * own: an action whose name, side effect or input schema changed in this save
   * (or that this save added) shows as new or changed against the accepted
   * fingerprints (#2916), and would then wait for approval until someone clicked
   * "Mark reviewed" on what the same admin had just written. Their current
   * fingerprints are accepted here. Nothing happens on an installation without
   * a baseline (the first run takes it from the current actions), and an
   * MCP tool or A2A skill is never accepted this way: its fingerprint is what
   * the remote server declares, which the builder does not edit.
   *
   * A failure here does not fail the save, which is stored: the actions then
   * stay new or changed, as before.
   *
   * @returns {Promise<Object>} the stored installation
   */
  async _acceptEditedActions(instanceId, language, stored) {
    try {
      const current = this.installations.get(instanceId) || stored;
      if (!current?.approval || !current.actions?.fingerprints) return stored;
      const resolved = await this.installations.resolve(instanceId, language);
      const { fingerprints } = await currentActionsOf(resolved, language);
      const pending = Object.entries(fingerprints)
        .filter(([name, fingerprint]) => actionReviewState(current, name, fingerprint))
        .map(([name]) => name);
      if (pending.length === 0) return stored;
      const { instance } = await this.installations.markActionsReviewed(
        instanceId,
        fingerprints,
        pending
      );
      return instance;
    } catch (error) {
      logger.warn('Builder: could not mark the edited actions as reviewed', {
        component: COMPONENT,
        instanceId,
        error: error.message
      });
      return stored;
    }
  }

  /** Validate the definition before it is written, with the builder's paths in the message. */
  _checkDefinition(pkg) {
    const result = validateIntegrationDefinition(pkg.definition);
    if (!result.success) {
      throw new BuilderError('The integration is not valid', {
        code: 'INVALID_DEFINITION',
        details: result.errors.map(e => ({ path: e.path, message: e.message }))
      });
    }
  }

  /** Tell the adapters (the script module cache, the MCP and A2A managers). */
  async _definitionsChanged(definitionId) {
    try {
      const { notifyDefinitionsChanged } = await import('../protocols/index.js');
      await notifyDefinitionsChanged({ definitionIds: [definitionId] });
    } catch (error) {
      logger.warn('Builder: adapters could not follow the change', {
        component: COMPONENT,
        definitionId,
        error: error.message
      });
    }
  }

  /**
   * Import the actions of a source before anything is saved:
   *
   * - `openapi`: fetch (SSRF-guarded) or parse the document and list its
   *   operations; the parsed document comes back so the builder stores it
   *   with the integration;
   * - `mcp`: connect to the server and list its tools (`tools/list`);
   * - `a2a`: read the agent card and list its skills.
   *
   * @param {{ kind: string, source: Object, auth?: Object }} request
   * @param {{ user?: Object, language?: string }} [context]
   */
  async importActions({ kind, source, auth }, { user, language = 'en' } = {}) {
    if (kind === 'openapi') return this._importOpenApi(source);
    const draft = {
      instanceId: 'builder-probe',
      name: { en: 'Probe' },
      source: kind,
      auth: { mode: 'none', ...(auth || {}) },
      actions: [],
      [kind]: source
    };
    const parsed = validateBuilderDraft(draft);
    if (!parsed.success) throw invalidDraft(parsed.errors);
    const pkg = draftToPackage(parsed.data);
    const validation = validateIntegrationDefinition(pkg.definition);
    if (!validation.success) {
      throw new BuilderError('The source settings are not valid', {
        code: 'INVALID_DEFINITION',
        details: validation.errors.map(e => ({ path: e.path, message: e.message }))
      });
    }
    const adapter = getProtocolAdapter(kind);
    const result = await adapter.test({
      definition: validation.data,
      instance: { ...pkg.installation, values: pkg.installation.values || {} },
      security: this.installations.security(),
      user,
      language
    });
    return {
      kind,
      success: result.success,
      message: result.message,
      steps: result.steps,
      connectUrl: result.connectUrl,
      actions: (result.actions || []).map(action => ({
        name: action.name,
        title: action.title,
        description: action.description || '',
        parameters: action.parameters,
        sideEffect: action.sideEffect || 'unknown'
      }))
    };
  }

  async _importOpenApi(source) {
    if (!source || !source.type) {
      throw new BuilderError('Missing OpenAPI source ({ type, url|spec })');
    }
    let raw;
    if (source.type === 'url') {
      if (!/^https?:\/\//i.test(source.url || '')) {
        throw new BuilderError('Only http(s) OpenAPI URLs are supported');
      }
      const { safeFetch } = await import('../../mcp/safeFetch.js');
      const security = this.installations.security();
      // SSRF is mitigated by safeFetch: it resolves DNS once, rejects
      // private addresses (unless the integrations' allowed hosts list the
      // host) and pins the socket to the checked address. This admin-only
      // endpoint fetches an operator-supplied URL, so the host cannot be
      // allow-listed beforehand.
      const response = await safeFetch(
        source.url,
        { method: 'GET', redirect: 'manual' },
        {
          blockPrivateIps: security?.blockPrivateIps !== false,
          allowHosts: security?.allowedHosts || []
        }
      ); // codeql[js/request-forgery]
      if (!response.ok) {
        throw new BuilderError(`Failed to fetch the OpenAPI document: ${response.status}`);
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
        throw new BuilderError('The OpenAPI document exceeds the 2 MB limit');
      }
      raw = parseOpenApiText(text);
    } else if (source.type === 'inline') {
      const spec = source.spec;
      if (typeof spec === 'string' && Buffer.byteLength(spec) > MAX_DOCUMENT_BYTES) {
        throw new BuilderError('The OpenAPI document exceeds the 2 MB limit');
      }
      raw = typeof spec === 'string' ? parseOpenApiText(spec) : spec;
    } else {
      throw new BuilderError('Unsupported OpenAPI source (use url or inline)');
    }
    if (!raw || typeof raw !== 'object' || !raw.paths) {
      throw new BuilderError('Not an OpenAPI document (no paths)');
    }
    const SwaggerParser = (await import('@apidevtools/swagger-parser')).default;
    let spec;
    try {
      // external:false keeps dereferencing from following external $refs
      // (remote URLs, local files), which would bypass the SSRF guard above.
      spec = await SwaggerParser.dereference(structuredClone(raw), {
        resolve: { external: false }
      });
    } catch (error) {
      throw new BuilderError(`The OpenAPI document cannot be read: ${error.message}`);
    }
    return {
      kind: 'openapi',
      info: { title: spec.info?.title, version: spec.info?.version },
      servers: (spec.servers || []).map(s => ({ url: s.url })),
      operations: listOpenApiOperations(spec),
      // The document as written (not dereferenced), stored with the integration.
      document: raw
    };
  }

  /**
   * The package a registry serves for a custom integration (see
   * `builderPackage.exportPackage`). A local process (an MCP server started
   * with `stdio`) cannot be published: a registry may only deliver remote
   * servers.
   *
   * @param {string} instanceId
   */
  async exportPackage(instanceId) {
    const { entry } = await this._customOf(instanceId);
    const definition = await this._rawDefinition(entry);
    if (definition.protocol?.type === 'mcp' && definition.protocol.transport?.type === 'stdio') {
      throw new BuilderError(
        'An MCP server started as a local process (stdio) cannot be published to a registry',
        { status: 409, code: 'NOT_PUBLISHABLE' }
      );
    }
    const companions = await readCompanions(entry.dir);
    return exportPackage({ definition, companions });
  }
}

const integrationBuilderService = new IntegrationBuilderService();
export default integrationBuilderService;

export { BuilderError, IntegrationError, SCRIPT_MODULE_FILE, OPENAPI_DOCUMENT_FILE };
