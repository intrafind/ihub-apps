// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import test from 'node:test';
import assert from 'node:assert/strict';
import { rawServerConfigFor } from '../../services/integrations/protocols/mcp/serverConfig.js';
import { mcpServerConfigSchema } from '../../validators/mcpServerConfigSchema.js';
import { validateInstalledIntegration } from '../../validators/integrationsConfigSchema.js';
import { InstalledIntegrationService } from '../../services/integrations/InstalledIntegrationService.js';
import { buildClientCapabilities } from '../../services/mcp/mcpApps.js';

/**
 * Whether an MCP server may ask the chat user questions mid-call (MCP
 * elicitation): the admin's switch on the installation, else the definition,
 * else on — and the switch survives every step to the connection.
 */

const definition = (protocol = {}) => ({
  id: 'mcp/billing',
  name: 'Billing',
  protocol: {
    type: 'mcp',
    transport: { type: 'streamableHttp', url: 'https://billing.example.com/mcp' },
    ...protocol
  },
  auth: { modes: ['none'] }
});
const instance = (extra = {}) => ({
  id: 'billing',
  definition: 'mcp/billing',
  auth: { mode: 'none' },
  ...extra
});

test('the installation switch wins over the definition, which wins over the default', () => {
  const enabled = ({ protocol, inst, values = {} }) =>
    rawServerConfigFor({ definition: definition(protocol), instance: instance(inst), values })
      .elicitation.enabled;
  assert.equal(enabled({}), true);
  assert.equal(enabled({ protocol: { elicitation: { enabled: false } } }), false);
  assert.equal(enabled({ values: { elicitationEnabled: false } }), false);
  assert.equal(
    enabled({
      protocol: { elicitation: { enabled: false } },
      inst: { elicitation: { enabled: true } }
    }),
    true
  );
  assert.equal(enabled({ inst: { elicitation: { enabled: false } } }), false);
});

test('a switched-off server config keeps the switch through validation and declares nothing', () => {
  const raw = rawServerConfigFor({
    definition: definition(),
    instance: instance({ elicitation: { enabled: false } }),
    values: {}
  });
  const parsed = mcpServerConfigSchema.parse(raw);
  assert.deepEqual(parsed.elicitation, { enabled: false });
  assert.equal(
    buildClientCapabilities(true, { elicitation: parsed.elicitation.enabled }).elicitation,
    undefined
  );
  // Absent, it defaults to on.
  assert.deepEqual(mcpServerConfigSchema.parse({ ...raw, elicitation: undefined }).elicitation, {
    enabled: true
  });
});

test('the installation accepts the switch and nothing else under it', () => {
  const base = { id: 'billing', definition: 'mcp/billing' };
  assert.equal(
    validateInstalledIntegration({ ...base, elicitation: { enabled: false } }).success,
    true
  );
  assert.equal(
    validateInstalledIntegration({ ...base, elicitation: { enabled: false, url: true } }).success,
    false
  );
});

test('a save that does not name the switch keeps it; null returns to the default', async () => {
  const entry = { definition: { ...definition(), install: [], actions: [] } };
  const service = new InstalledIntegrationService({
    registry: { list: () => [entry], get: () => entry, ensureLoaded: async () => {} }
  });
  const existing = { ...instance(), elicitation: { enabled: false } };
  const base = { id: 'billing', definition: 'mcp/billing', enabled: true, values: {} };
  const kept = await service._prepare(base, { existing });
  assert.deepEqual(kept.instance.elicitation, { enabled: false });
  const changed = await service._prepare({ ...base, elicitation: { enabled: true } }, { existing });
  assert.deepEqual(changed.instance.elicitation, { enabled: true });
  const cleared = await service._prepare({ ...base, elicitation: null }, { existing });
  assert.equal(cleared.instance.elicitation, undefined);
});
