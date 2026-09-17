export const version = '061';
export const description = 'centralize_credentials';
// Numbered V060 (not V057): main already ships V057–V059.

/**
 * Centralizes ALL inline secrets into the new credential store
 * (`contents/config/credentials.json`) and replaces each inline secret field
 * with a `*Ref` pointer to a named profile.
 *
 * No backward compatibility: the old inline secret fields are removed. Runtime
 * consumers resolve secrets via CredentialService instead of reading them
 * inline. Secret values already on disk are usually ENC[...] ciphertext (or
 * `${ENV}` placeholders) — they are moved verbatim, so no re-encryption is
 * needed and the encryption key is untouched.
 *
 * Migrated secrets:
 *   platform.json:
 *     jira.clientSecret                          → credentialRef "jira"
 *     cloudStorage.providers[].clientSecret      → "cloudstorage_<id>"
 *     cloudStorage.providers[].tenantId (o365)   → "cloudstorage_<id>_tenant"
 *     oidcAuth.providers[].clientSecret          → "oidc_<id>"
 *     ldapAuth.providers[].adminPassword         → "ldap_<id>"
 *     ntlmAuth.domainControllerPassword          → "ntlm"
 *     iFinder.privateKey                         → "ifinder"
 *   mcpServers.json:
 *     servers[].auth.token                       → "mcp_<id>_token"
 *     servers[].auth.password                    → "mcp_<id>_password"
 *     servers[].auth.clientSecret                → "mcp_<id>_clientSecret"
 */

const sanitizeId = raw =>
  String(raw || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'default';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  // --- Load (or seed) the credential store -----------------------------------
  let store;
  if (await ctx.fileExists('config/credentials.json')) {
    store = await ctx.readJson('config/credentials.json');
  } else {
    store = { credentials: {} };
  }
  if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};

  let moved = 0;
  const usedIds = new Set(Object.keys(store.credentials));

  // Create a `secret`-type profile and return its (unique) id.
  const addSecret = (preferredId, value, name) => {
    let id = sanitizeId(preferredId);
    let n = 2;
    while (usedIds.has(id)) id = `${sanitizeId(preferredId)}_${n++}`;
    usedIds.add(id);
    store.credentials[id] = { id, name: name || id, type: 'secret', value };
    moved++;
    return id;
  };

  // --- platform.json ---------------------------------------------------------
  const platform = await ctx.readJson('config/platform.json');

  if (platform.jira?.clientSecret) {
    platform.jira.clientSecretRef = addSecret(
      'jira',
      platform.jira.clientSecret,
      'Jira Client Secret'
    );
    delete platform.jira.clientSecret;
  }

  if (Array.isArray(platform.cloudStorage?.providers)) {
    platform.cloudStorage.providers.forEach((p, i) => {
      const base = `cloudstorage_${sanitizeId(p.id || p.name || i)}`;
      if (p.clientSecret) {
        p.clientSecretRef = addSecret(
          base,
          p.clientSecret,
          `Cloud Storage Client Secret (${p.id || i})`
        );
        delete p.clientSecret;
      }
      if (p.type === 'office365' && p.tenantId) {
        p.tenantIdRef = addSecret(`${base}_tenant`, p.tenantId, `Office365 Tenant (${p.id || i})`);
        delete p.tenantId;
      }
    });
  }

  if (Array.isArray(platform.oidcAuth?.providers)) {
    platform.oidcAuth.providers.forEach((p, i) => {
      if (p.clientSecret) {
        p.clientSecretRef = addSecret(
          `oidc_${sanitizeId(p.name || p.id || i)}`,
          p.clientSecret,
          `OIDC Client Secret (${p.name || i})`
        );
        delete p.clientSecret;
      }
    });
  }

  if (Array.isArray(platform.ldapAuth?.providers)) {
    platform.ldapAuth.providers.forEach((p, i) => {
      if (p.adminPassword) {
        p.adminPasswordRef = addSecret(
          `ldap_${sanitizeId(p.name || p.id || i)}`,
          p.adminPassword,
          `LDAP Admin Password (${p.name || i})`
        );
        delete p.adminPassword;
      }
    });
  }

  if (platform.ntlmAuth?.domainControllerPassword) {
    platform.ntlmAuth.domainControllerPasswordRef = addSecret(
      'ntlm',
      platform.ntlmAuth.domainControllerPassword,
      'NTLM Domain Controller Password'
    );
    delete platform.ntlmAuth.domainControllerPassword;
  }

  if (platform.iFinder?.privateKey) {
    platform.iFinder.privateKeyRef = addSecret(
      'ifinder',
      platform.iFinder.privateKey,
      'iFinder Private Key'
    );
    delete platform.iFinder.privateKey;
  }

  // --- mcpServers.json -------------------------------------------------------
  if (await ctx.fileExists('config/mcpServers.json')) {
    const mcp = await ctx.readJson('config/mcpServers.json');
    if (Array.isArray(mcp.servers)) {
      for (const server of mcp.servers) {
        const auth = server.auth;
        if (!auth || typeof auth !== 'object') continue;
        const base = `mcp_${sanitizeId(server.id)}`;
        for (const field of ['token', 'password', 'clientSecret']) {
          if (auth[field]) {
            auth[`${field}Ref`] = addSecret(
              `${base}_${field}`,
              auth[field],
              `MCP ${server.id} ${field}`
            );
            delete auth[field];
          }
        }
      }
    }
    await ctx.writeJson('config/mcpServers.json', mcp);
  }

  await ctx.writeJson('config/credentials.json', store);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Centralized ${moved} inline secret(s) into credentials.json`);
}
