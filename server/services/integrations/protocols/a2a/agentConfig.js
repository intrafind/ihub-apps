// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An installed A2A integration as the `A2aClientManager` reads it: the agent
 * config `a2aAgents.json` used to hold. The definition fixes what it knows;
 * the install values supply the rest under conventional keys, which the
 * shipped "A2A agent" definition declares as fields:
 *
 *   cardUrl, timeoutMs, streaming, pollIntervalMs;
 *   authKind (apiKey | bearer), headerName;
 *   oauthTokenUrl, oauthClientId, oauthScope (client credentials).
 */
import { a2aAgentConfigSchema } from '../../../../validators/a2aAgentConfigSchema.js';
import { fillTemplate } from '../../definitions/valuePaths.js';

function defined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== '')
  );
}

function authFor(definition, instance, values) {
  const mode = instance.auth?.mode || 'none';
  const credentialRef = instance.auth?.credentialRef;
  if (mode === 'service-account') {
    const account = definition.auth.serviceAccount || {};
    const kind = values.authKind || (account.kind === 'header' ? 'apiKey' : 'bearer');
    if (kind === 'apiKey') {
      return defined({
        type: 'apiKey',
        headerName: values.headerName || fillTemplate(account.header, values),
        valueRef: credentialRef
      });
    }
    return { type: 'bearer', tokenRef: credentialRef };
  }
  if (mode === 'oauth-client') {
    return defined({
      type: 'oauth',
      tokenUrl: values.oauthTokenUrl,
      clientId: values.oauthClientId,
      clientSecretRef: credentialRef,
      scope: values.oauthScope
    });
  }
  return { type: 'none' };
}

/**
 * The raw (unvalidated) agent config of an installation.
 * @param {{ definition: object, instance: object, values: Record<string, unknown> }} params
 */
export function rawAgentConfigFor({ definition, instance, values }) {
  const protocol = definition.protocol;
  const policy = instance.actions || {};
  const enabled = policy.enabled || ['*'];
  return defined({
    id: instance.id,
    name: instance.label || definition.name,
    description: instance.description || definition.description,
    enabled: instance.enabled !== false,
    cardUrl: protocol.cardUrl ? fillTemplate(protocol.cardUrl, values) : values.cardUrl,
    auth: authFor(definition, instance, values),
    allowedSkills: enabled.includes('*') ? ['*'] : enabled,
    deniedSkills: policy.disabled || [],
    timeoutMs: instance.timeoutMs ?? protocol.timeoutMs ?? values.timeoutMs,
    streaming: protocol.streaming ?? values.streaming,
    pollIntervalMs: protocol.pollIntervalMs ?? values.pollIntervalMs
  });
}

/**
 * The validated agent config of an installation.
 * @returns {{ ok: true, config: object } | { ok: false, issues: Array }}
 */
export function agentConfigFor(params) {
  const parsed = a2aAgentConfigSchema.safeParse(rawAgentConfigFor(params));
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, config: parsed.data };
}

/**
 * The `A2aClientManager` config (`{ agents, security }`) of every installed
 * A2A integration; an installation that does not validate is reported and
 * left out.
 */
export function a2aAgentsFromInstallations(resolved, security) {
  const agents = [];
  const invalid = [];
  for (const entry of resolved) {
    if (entry.definition?.protocol?.type !== 'a2a') continue;
    const result = agentConfigFor(entry);
    if (result.ok) agents.push(result.config);
    else invalid.push({ id: entry.instance.id, issues: result.issues });
  }
  return {
    agents,
    security: security || { blockPrivateIps: true, allowedHosts: [] },
    invalid
  };
}
