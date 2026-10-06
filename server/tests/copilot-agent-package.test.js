/**
 * The Microsoft 365 Copilot agent package (`utils/copilotAgentPackage.js`).
 *
 * Pinned here: the three documents carry Microsoft's current schemas, stay
 * inside Microsoft's field limits whatever an admin typed, use iHub's default
 * instructions when there are none, discover the gateway's tools at runtime,
 * and get a higher version on every download.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COPILOT_OAUTH_SCOPES,
  DEFAULT_INSTRUCTIONS,
  LIMITS,
  TEAMS_OAUTH_REDIRECT_URI,
  buildCopilotAgentManifests,
  copilotPackageVersion,
  describeCopilotOAuthRegistration,
  isGuid,
  validateCopilotAgentConfig
} from '../utils/copilotAgentPackage.js';

const APP_ID = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const build = (config = {}) =>
  buildCopilotAgentManifests({
    config: { appId: APP_ID, oauthReferenceId: 'ref-1', ...config },
    baseUrl: 'https://ihub.example.com/ihub',
    mcpUrl: 'https://ihub.example.com/ihub/mcp',
    version: '2026.10.61530'
  });

describe('copilotPackageVersion', () => {
  it('is year.month.DDHHmm in UTC', () => {
    assert.equal(copilotPackageVersion(new Date('2026-10-06T15:30:00Z')), '2026.10.61530');
    assert.equal(copilotPackageVersion(new Date('2026-01-31T00:05:00Z')), '2026.1.310005');
  });

  it('grows with every minute, across days and months', () => {
    const versions = [
      '2026-10-09T23:59:00Z',
      '2026-10-10T00:00:00Z',
      '2026-10-31T23:59:00Z',
      '2026-11-01T00:00:00Z',
      '2027-01-01T00:00:00Z'
    ].map(t => copilotPackageVersion(new Date(t)).split('.').map(Number));
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [versions[i - 1], versions[i]];
      const greater =
        b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] > a[2])));
      assert.ok(greater, `${b.join('.')} > ${a.join('.')}`);
    }
  });
});

describe('buildCopilotAgentManifests', () => {
  it('uses the current schemas and the lower-cased app id', () => {
    const { manifest, declarativeAgent, plugin } = build();
    assert.equal(manifest.manifestVersion, '1.30');
    assert.match(manifest.$schema, /teams\/v1\.30\//);
    assert.equal(manifest.id, APP_ID.toLowerCase());
    assert.equal(manifest.version, '2026.10.61530');
    assert.equal(declarativeAgent.version, 'v1.8');
    assert.equal(plugin.schema_version, 'v2.4');
  });

  it('discovers the gateway tools at runtime, signed in through the registration', () => {
    const { plugin } = build();
    assert.deepEqual(plugin.functions, []);
    assert.deepEqual(plugin.runtimes, [
      {
        type: 'RemoteMCPServer',
        auth: { type: 'OAuthPluginVault', reference_id: 'ref-1' },
        spec: { url: 'https://ihub.example.com/ihub/mcp' },
        run_for_functions: ['*']
      }
    ]);
    assert.match(plugin.namespace, /^[A-Za-z0-9]+$/);
  });

  it("uses iHub's instructions when the admin wrote none, theirs otherwise", () => {
    assert.equal(build().declarativeAgent.instructions, DEFAULT_INSTRUCTIONS);
    assert.equal(build({ instructions: 'Be brief.' }).declarativeAgent.instructions, 'Be brief.');
    assert.ok(DEFAULT_INSTRUCTIONS.length <= LIMITS.instructions);
  });

  it('stays within the field limits whatever the settings say', () => {
    const { manifest, declarativeAgent, plugin } = build({
      name: 'A very long agent name that goes on and on',
      description: 'd'.repeat(2000),
      conversationStarters: Array.from({ length: 20 }, (_, i) => ({ text: `Starter ${i}` }))
    });
    assert.ok(manifest.name.short.length <= 30);
    assert.ok(manifest.name.full.length <= 100);
    assert.ok(manifest.description.short.length <= 80);
    assert.ok(manifest.description.full.length <= 4000);
    assert.ok(declarativeAgent.name.length <= 100);
    assert.ok(declarativeAgent.description.length <= 1000);
    assert.equal(declarativeAgent.conversation_starters.length, 12);
    assert.ok(plugin.name_for_human.length <= 20);
    assert.ok(plugin.description_for_human.length <= 100);
    assert.ok(plugin.description_for_model.length <= 2048);
  });

  it('leaves conversation starters out when there are none', () => {
    assert.equal('conversation_starters' in build().declarativeAgent, false);
  });

  it('cannot be built without an app id or a registration ID', () => {
    assert.throws(() => build({ appId: 'not-a-guid' }), /app id/);
    assert.throws(() => build({ oauthReferenceId: '' }), /registration ID/);
  });
});

describe('validateCopilotAgentConfig', () => {
  it('keeps only the fields that were sent, trimmed', () => {
    assert.deepEqual(validateCopilotAgentConfig({ name: '  Contoso  ' }), {
      value: { name: 'Contoso' }
    });
    assert.deepEqual(validateCopilotAgentConfig({ instructions: '' }), {
      value: { instructions: '' }
    });
  });

  it('drops empty starters and refuses a title without a text', () => {
    assert.deepEqual(
      validateCopilotAgentConfig({
        conversationStarters: [{ title: '', text: '' }, { text: 'Hi' }]
      }),
      { value: { conversationStarters: [{ text: 'Hi' }] } }
    );
    assert.match(
      validateCopilotAgentConfig({ conversationStarters: [{ title: 'Only a title' }] }).error,
      /text/
    );
  });

  it('refuses a body that is not an object', () => {
    assert.ok(validateCopilotAgentConfig(null).error);
    assert.ok(validateCopilotAgentConfig([]).error);
  });
});

describe('describeCopilotOAuthRegistration', () => {
  it("matches the plugin's URL and iHub's OAuth endpoints", () => {
    const registration = describeCopilotOAuthRegistration({
      baseUrl: 'https://ihub.example.com/ihub',
      mcpUrl: 'https://ihub.example.com/ihub/mcp',
      clientId: 'client_copilot'
    });
    assert.equal(registration.baseUrl, 'https://ihub.example.com/ihub/mcp');
    assert.equal(
      registration.authorizationEndpoint,
      'https://ihub.example.com/ihub/api/oauth/authorize'
    );
    assert.equal(registration.tokenEndpoint, 'https://ihub.example.com/ihub/api/oauth/token');
    assert.equal(registration.redirectUri, TEAMS_OAUTH_REDIRECT_URI);
    assert.equal(registration.scope, COPILOT_OAUTH_SCOPES.join(' '));
  });
});

describe('isGuid', () => {
  it('accepts GUIDs only', () => {
    assert.equal(isGuid(APP_ID), true);
    assert.equal(isGuid('3f2504e0-4f89-41d3-9a0c-0305e82c330'), false);
    assert.equal(isGuid(undefined), false);
  });
});
