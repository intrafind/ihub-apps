// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * The A2A adapter's connection test lists every skill of the card, the ones
 * the admin switched off included, and reports each one's state from the
 * installation's action policy. The install dialog replaces its action list
 * with this result, so a skill left out of it would be saved switched on.
 */

const calls = [];
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({
  default: {
    async testConfig(config) {
      calls.push(config);
      return {
        status: { connected: true },
        card: { name: 'Helper', version: '1.2', url: config.cardUrl },
        skills: [
          { id: 'ask', name: 'Ask', toolId: 'a2a__helper__ask', allowed: true },
          { id: 'delete_all', name: 'Delete all', toolId: 'a2a__helper__delete_all', allowed: true }
        ]
      };
    },
    allSkillsOfAgent: async () => [],
    toolsOfAgent: async () => [],
    status: () => []
  }
}));

const adapter = await import('../../services/integrations/protocols/a2a/A2aAdapter.js');
const definition = JSON.parse(
  readFileSync(
    new URL(
      '../../defaults/integration-definitions/com.intrafind__a2a-agent/integration.json',
      import.meta.url
    ),
    'utf8'
  )
);

const instance = {
  id: 'helper',
  definition: definition.id,
  enabled: true,
  auth: { mode: 'none' },
  values: { cardUrl: 'https://agents.example/.well-known/agent-card.json' },
  actions: { enabled: ['*'], disabled: ['delete_all'] }
};

describe('A2A adapter connection test', () => {
  beforeEach(() => calls.splice(0));

  it('probes every skill of the card, the switched-off ones included', async () => {
    await adapter.test({ definition, instance });
    expect(calls).toHaveLength(1);
    expect(calls[0].deniedSkills).toEqual([]);
    expect(calls[0].allowedSkills).toEqual(['*']);
  });

  it('reports each skill with the state of the installation, not of the probe', async () => {
    const result = await adapter.test({ definition, instance });
    const byName = Object.fromEntries(result.actions.map(action => [action.name, action]));
    expect(Object.keys(byName).sort()).toEqual(['ask', 'delete_all']);
    expect(byName.ask).toMatchObject({
      enabled: true,
      available: true,
      toolId: 'a2a__helper__ask'
    });
    expect(byName.delete_all).toMatchObject({ enabled: false, available: false });
    expect(result.actionCount).toBe(2);
    expect(result.success).toBe(true);
  });
});
