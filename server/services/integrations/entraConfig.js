// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Microsoft Entra ID directory as the built-in installed integration
 * `entra` (`com.intrafind/entra-directory`) holds it: tenant, client id and
 * the client secret as a credential reference, each falling back to the
 * `AZURE_*` environment variables the integration used before it was an
 * installation.
 */
import configCache from '../../configCache.js';
import credentialService from '../CredentialService.js';

export const ENTRA_INSTANCE_ID = 'entra';
export const ENTRA_DEFINITION_ID = 'com.intrafind/entra-directory';

/** The installed `entra` instance, or null. */
export function getEntraInstallation() {
  try {
    const installed = configCache.getIntegrations?.()?.data?.installed || [];
    return installed.find(instance => instance?.id === ENTRA_INSTANCE_ID) || null;
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * The Entra settings as `EntraService` reads them.
 * @param {object|null} [instance]
 * @param {NodeJS.ProcessEnv} [env]
 * `clientSecretSource` says where the secret came from: the credential
 * `clientSecretRef` names, the `AZURE_CLIENT_SECRET` variable, or nowhere
 * (`''`). A reference whose credential is missing or empty still falls back to
 * the variable, so the installation test can tell the admin.
 * @returns {{ enabled: boolean, tenantId: string, clientId: string, clientSecret: string, clientSecretRef: string, clientSecretSource: 'credential'|'env'|'' }}
 */
export function entraConfigFromInstance(instance, env = process.env) {
  const values = instance?.values || {};
  const clientSecretRef = text(values.clientSecretRef);
  const fromCredential = clientSecretRef
    ? text(credentialService.tryResolveSecret(clientSecretRef))
    : '';
  const fromEnv = text(env.AZURE_CLIENT_SECRET);
  return {
    enabled: Boolean(instance) && instance.enabled !== false,
    tenantId: text(values.tenantId) || text(env.AZURE_TENANT_ID),
    clientId: text(values.clientId) || text(env.AZURE_CLIENT_ID),
    clientSecretRef,
    clientSecret: fromCredential || fromEnv,
    clientSecretSource: fromCredential ? 'credential' : fromEnv ? 'env' : ''
  };
}

export function getEntraConfig() {
  return entraConfigFromInstance(getEntraInstallation());
}

/** Enabled with tenant, client id and a client secret. */
export function isEntraConfigured(cfg = getEntraConfig()) {
  return Boolean(cfg.enabled && cfg.tenantId && cfg.clientId && cfg.clientSecret);
}
