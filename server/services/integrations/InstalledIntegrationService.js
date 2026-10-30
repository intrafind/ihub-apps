// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import configStore from '../config/ConfigStore.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';
import integrationRegistry from './definitions/IntegrationRegistry.js';
import { getProtocolAdapter } from './protocols/index.js';
import {
  validateIntegrationsConfig,
  validateInstalledIntegration
} from '../../validators/integrationsConfigSchema.js';
import {
  checkInstallValues,
  secretFieldForMode
} from '../../validators/integrationDefinitionSchema.js';
import { effectiveValues, instanceLabel, localized } from './definitions/installedValues.js';

/**
 * Installed integrations (04-architecture §1.3): the admin's instances of
 * catalog definitions, stored in `contents/config/integrations.json`.
 *
 * Secrets entered in the install wizard never land in that file. They are
 * written to the credential store as `secret` profiles named
 * `integration-<instanceId>-<field>` and the instance keeps the reference.
 */

export const INTEGRATIONS_FILE = 'config/integrations.json';
const CREDENTIALS_FILE = 'config/credentials.json';
const COMPONENT = 'InstalledIntegrationService';
const RESERVED_INSTANCE_IDS = new Set(['a2a', 'app', 'workflow', 'knowledge']);

export class IntegrationError extends Error {
  constructor(message, { status = 400, code = 'INTEGRATION_ERROR', details } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

function emptyConfig() {
  return { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } };
}

function credentialIdFor(instanceId, fieldKey) {
  return `integration-${instanceId}-${fieldKey}`;
}

function nowIso() {
  return new Date().toISOString();
}

export class InstalledIntegrationService {
  constructor({ registry = integrationRegistry } = {}) {
    this.registry = registry;
    /** Tail of the change queue (see `_serialize`). */
    this._queue = Promise.resolve();
  }

  /** The whole file, validated, with defaults. */
  readConfig() {
    const cached = configCache.get(INTEGRATIONS_FILE);
    const data = cached?.data;
    if (!data) return emptyConfig();
    const result = validateIntegrationsConfig(data);
    if (!result.success) {
      logger.error('integrations.json is invalid; using an empty configuration', {
        component: COMPONENT,
        issues: result.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
      return emptyConfig();
    }
    return result.data;
  }

  /**
   * The file for a change. An invalid file is an error here, not an empty
   * configuration: writing the fallback back would erase every installation.
   */
  _readConfigForWrite() {
    const data = configCache.get(INTEGRATIONS_FILE)?.data;
    if (!data) return emptyConfig();
    const result = validateIntegrationsConfig(data);
    if (!result.success) {
      throw new IntegrationError(
        'integrations.json is invalid; fix the file before changing installations',
        { status: 500, code: 'INVALID_CONFIG', details: result.errors }
      );
    }
    return result.data;
  }

  async writeConfig(config) {
    const result = validateIntegrationsConfig(config);
    if (!result.success) {
      throw new IntegrationError('Invalid integrations configuration', {
        status: 500,
        code: 'INVALID_CONFIG',
        details: result.errors
      });
    }
    await configStore.writeJson(INTEGRATIONS_FILE, result.data);
    await configCache.refreshCacheEntry?.(INTEGRATIONS_FILE);
    return result.data;
  }

  list() {
    return this.readConfig().installed;
  }

  get(id) {
    return this.list().find(inst => inst.id === id) || null;
  }

  security() {
    return this.readConfig().security;
  }

  /**
   * An instance with its definition, document, effective values and label.
   * @param {string|object} idOrInstance
   * @param {string} [language]
   */
  async resolve(idOrInstance, language = 'en') {
    await this.registry.ensureLoaded();
    const instance = typeof idOrInstance === 'string' ? this.get(idOrInstance) : idOrInstance;
    if (!instance) return null;
    const entry = this.registry.get(instance.definition);
    if (!entry) {
      return {
        instance,
        definition: null,
        document: null,
        values: {},
        label: instance.id,
        missingDefinition: true
      };
    }
    return {
      instance,
      definition: entry.definition,
      document: entry.document,
      security: this.security(),
      values: effectiveValues(entry.definition, instance),
      label: instanceLabel(entry.definition, instance, language)
    };
  }

  /** Every enabled instance whose definition and adapter exist, resolved. */
  async resolveAllEnabled(language = 'en') {
    await this.registry.ensureLoaded();
    const out = [];
    for (const instance of this.list()) {
      if (instance.enabled === false) continue;
      const resolved = await this.resolve(instance, language);
      if (!resolved?.definition) continue;
      if (!getProtocolAdapter(resolved.definition.protocol.type)) continue;
      out.push(resolved);
    }
    return out;
  }

  /**
   * Validate an admin payload against its definition. Returns the normalized
   * instance (without secrets) and the secrets to store.
   */
  async _prepare(payload, { existing } = {}) {
    await this.registry.ensureLoaded();
    const { secrets, ...rest } = payload || {};
    const parsed = validateInstalledIntegration({
      ...rest,
      installedAt: existing?.installedAt,
      health: existing?.health
    });
    if (!parsed.success) {
      throw new IntegrationError('Invalid installed integration', {
        code: 'INVALID_INSTANCE',
        details: parsed.error ?? parsed.errors
      });
    }
    const instance = parsed.data;
    if (instance.id.includes('__') || RESERVED_INSTANCE_IDS.has(instance.id.toLowerCase())) {
      throw new IntegrationError('Instance id must not contain "__" or be a reserved id', {
        code: 'INVALID_ID'
      });
    }
    const entry = this.registry.get(instance.definition);
    if (!entry) {
      throw new IntegrationError(`Unknown integration definition "${instance.definition}"`, {
        status: 404,
        code: 'UNKNOWN_DEFINITION'
      });
    }
    const definition = entry.definition;
    if (definition.singleton && instance.id !== definition.singleton.instanceId) {
      throw new IntegrationError(
        `"${definition.id}" is installed once, as "${definition.singleton.instanceId}"`,
        { code: 'SINGLETON_ID' }
      );
    }
    if (!getProtocolAdapter(definition.protocol.type)) {
      throw new IntegrationError(
        `Protocol "${definition.protocol.type}" has no adapter in this release`,
        { code: 'UNSUPPORTED_PROTOCOL' }
      );
    }
    if (!definition.auth.modes.includes(instance.auth.mode)) {
      throw new IntegrationError(
        `Auth mode "${instance.auth.mode}" is not offered by the definition`,
        {
          code: 'INVALID_AUTH_MODE'
        }
      );
    }
    const adapter = getProtocolAdapter(definition.protocol.type);
    if (
      Array.isArray(adapter.supportedAuthModes) &&
      !adapter.supportedAuthModes.includes(instance.auth.mode)
    ) {
      throw new IntegrationError(
        `Auth mode "${instance.auth.mode}" is not available for "${definition.protocol.type}" integrations in this release`,
        { code: 'UNSUPPORTED_AUTH_MODE' }
      );
    }

    // The secret a sign-in mode keeps in the credential store: the service
    // account's token, the OAuth client's secret, or (optional) the secret of
    // a pre-registered client for per-user OAuth.
    const secretSpec = secretFieldForMode(definition, instance.auth.mode);
    const secretField = secretSpec?.key || null;
    const providedSecret =
      secrets &&
      secretField &&
      typeof secrets[secretField] === 'string' &&
      secrets[secretField].trim()
        ? secrets[secretField].trim()
        : null;
    const keepsCredential = Boolean(instance.auth.credentialRef || existing?.auth?.credentialRef);
    const hasCredential = Boolean(providedSecret) || keepsCredential;

    const valueErrors = checkInstallValues(definition, instance.values, {
      authMode: instance.auth.mode,
      hasCredential
    });
    if (valueErrors.length) {
      throw new IntegrationError('Invalid install values', {
        code: 'INVALID_VALUES',
        details: valueErrors
      });
    }

    const toStore = [];
    if (secretSpec) {
      if (providedSecret) {
        const credentialRef = credentialIdFor(instance.id, secretField);
        toStore.push({
          id: credentialRef,
          value: providedSecret,
          instance,
          definition,
          secretField
        });
        instance.auth.credentialRef = credentialRef;
      } else if (!instance.auth.credentialRef && existing?.auth?.credentialRef) {
        instance.auth.credentialRef = existing.auth.credentialRef;
      }
    } else {
      delete instance.auth.credentialRef;
    }

    instance.definitionVersion = definition.version;
    instance.installedAt = existing?.installedAt || nowIso();
    instance.updatedAt = nowIso();
    return { instance, definition, document: entry.document, secretsToStore: toStore };
  }

  async _storeSecrets(secretsToStore, language = 'en') {
    for (const { id, value, instance, definition, secretField } of secretsToStore) {
      const store = (await configStore.readJsonStrict(CREDENTIALS_FILE)) || { credentials: {} };
      if (!store.credentials) store.credentials = {};
      const field = definition.install.find(f => f.key === secretField);
      store.credentials[id] = {
        id,
        type: 'secret',
        name: `${instanceLabel(definition, instance, language)}: ${localized(field?.title, language, secretField)}`,
        description: `Managed by the installed integration "${instance.id}"`,
        value: tokenStorageService.encryptString(value)
      };
      await configStore.writeJson(CREDENTIALS_FILE, store);
      await configCache.refreshCredentialsCache?.();
    }
  }

  async _removeManagedCredential(instance) {
    const ref = instance?.auth?.credentialRef;
    if (!ref || !ref.startsWith(`integration-${instance.id}-`)) return;
    try {
      const store = (await configStore.readJsonStrict(CREDENTIALS_FILE)) || { credentials: {} };
      if (store.credentials?.[ref]) {
        delete store.credentials[ref];
        await configStore.writeJson(CREDENTIALS_FILE, store);
        await configCache.refreshCredentialsCache?.();
      }
    } catch (error) {
      logger.warn('Could not remove the managed credential of an integration', {
        component: COMPONENT,
        instanceId: instance.id,
        credentialRef: ref,
        error: error.message
      });
    }
  }

  /**
   * Run one change at a time. Every change is a read-modify-write of the
   * whole file, so two admins saving at once would otherwise lose one save.
   */
  _serialize(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Create an instance. `payload.secrets` holds sensitive field values. */
  create(payload, { language = 'en' } = {}) {
    return this._serialize(async () => {
      if (this.get(payload?.id)) {
        throw new IntegrationError(`An integration with id "${payload.id}" exists`, {
          status: 409,
          code: 'DUPLICATE_ID'
        });
      }
      const { instance, secretsToStore } = await this._prepare(payload);
      await this._storeSecrets(secretsToStore, language);
      const config = this._readConfigForWrite();
      if (config.installed.some(inst => inst.id === instance.id)) {
        throw new IntegrationError(`An integration with id "${instance.id}" exists`, {
          status: 409,
          code: 'DUPLICATE_ID'
        });
      }
      config.installed.push(instance);
      await this.writeConfig(config);
      await this._afterChange(instance.id, { before: null, after: instance });
      return instance;
    });
  }

  /** Replace an instance (the id cannot change). */
  update(id, payload, { language = 'en' } = {}) {
    return this._serialize(async () => {
      const existing = this.get(id);
      if (!existing)
        throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
      if (payload?.id && payload.id !== id) {
        throw new IntegrationError('The instance id cannot change', { code: 'ID_CHANGE' });
      }
      const { instance, secretsToStore } = await this._prepare({ ...payload, id }, { existing });
      await this._storeSecrets(secretsToStore, language);
      const config = this._readConfigForWrite();
      const index = config.installed.findIndex(inst => inst.id === id);
      if (index < 0)
        throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
      config.installed[index] = instance;
      await this.writeConfig(config);
      // Only once the file points elsewhere: a failed write must leave the
      // credential the file still names.
      if (
        existing.auth?.credentialRef &&
        existing.auth.credentialRef !== instance.auth?.credentialRef
      ) {
        await this._removeManagedCredential(existing);
      }
      await this._afterChange(instance.id, { before: existing, after: instance });
      return instance;
    });
  }

  setEnabled(id, enabled) {
    return this._serialize(async () => {
      const config = this._readConfigForWrite();
      const instance = config.installed.find(inst => inst.id === id);
      if (!instance)
        throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
      const before = { ...instance };
      instance.enabled = Boolean(enabled);
      instance.updatedAt = nowIso();
      await this.writeConfig(config);
      await this._afterChange(instance.id, { before, after: instance });
      return instance;
    });
  }

  remove(id) {
    return this._serialize(async () => {
      const config = this._readConfigForWrite();
      const instance = config.installed.find(inst => inst.id === id);
      if (!instance)
        throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
      config.installed = config.installed.filter(inst => inst.id !== id);
      await this.writeConfig(config);
      await this._removeManagedCredential(instance);
      await this._afterChange(instance.id, { before: instance, after: null });
      return instance;
    });
  }

  /** Instances that use a definition (the marketplace refuses to uninstall while any exist). */
  instancesOf(definitionId) {
    return this.list().filter(inst => inst.definition === definitionId);
  }

  /**
   * Test an unsaved or saved instance. `payload` is validated like a create,
   * except that the id may already exist; a secret may be provided inline or
   * the stored credential is used.
   */
  async test(payload, { language = 'en', user } = {}) {
    const existing = payload?.id ? this.get(payload.id) : null;
    const { instance, definition, document, secretsToStore } = await this._prepare(payload, {
      existing
    });
    const adapter = getProtocolAdapter(definition.protocol.type);
    const inlineSecret = secretsToStore[0]?.value;
    // An inline secret is resolved for this one test and written nowhere; the
    // resolver travels with the call, so concurrent tests cannot see it.
    const resolveSecret = inlineSecret ? () => inlineSecret : undefined;
    const probeInstance = inlineSecret
      ? { ...instance, auth: { ...instance.auth, credentialRef: '__inline__' } }
      : instance;
    return adapter.test({
      definition,
      instance: probeInstance,
      document,
      security: this.security(),
      language,
      user,
      resolveSecret
    });
  }

  async _afterChange(instanceId, { before = null, after = null } = {}) {
    try {
      const { invalidate } = await import('./protocols/openapi/OpenApiAdapter.js');
      invalidate(instanceId);
      // A native connector may react to its installation changing (the
      // iFinder connector switches the iAssistant model on after setup).
      const definitionId = (after || before)?.definition;
      const entry = definitionId ? this.registry.get(definitionId) : null;
      const protocolType = entry?.definition.protocol.type;
      if (protocolType === 'native' || protocolType === 'script') {
        const { getConnectorFor } = await import('./protocols/native/NativeAdapter.js');
        const connector = await getConnectorFor(entry.definition).catch(() => null);
        await connector?.onChanged?.({ before, after, definition: entry.definition });
      }
      const { syncIntegrationScopeProviders } = await import('./integrationTools.js');
      await syncIntegrationScopeProviders();
    } catch (error) {
      logger.warn('Integration post-change hook failed', {
        component: COMPONENT,
        error: error.message
      });
    }
  }
}

const installedIntegrationService = new InstalledIntegrationService();
export default installedIntegrationService;
