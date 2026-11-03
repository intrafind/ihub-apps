// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Per-action approval with fingerprints (#2916): fingerprint stability, the
 * new/changed reset in the resolver and its precedence, the action's
 * `dataFlow` override, the tighten-only app rule against action modes, the
 * baseline / no-write rules of discovery, and the install preset.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionFingerprint,
  actionReviewState,
  canonicalSchema,
  isFingerprint
} from '../../utils/actionFingerprint.js';
import { resolveToolApproval, _resetLoggedLoosening } from '../../utils/toolApproval.js';
import {
  _resetActionReview,
  fingerprintOfTool,
  fingerprintsOfActions,
  observeActionFingerprints,
  reviewStatesOf
} from '../../services/integrations/actionReview.js';
import { McpServerConnection } from '../../services/mcp/McpServerConnection.js';
import { viewCallToolDef } from '../../services/mcp/mcpViewToolApproval.js';
import { buildSkillTools } from '../../services/a2a/a2aTools.js';
import {
  compareCodeUnits,
  installApprovalPreset,
  needsApproval
} from '../../../shared/toolApproval.js';
import { validateIntegrationsConfig } from '../../validators/integrationsConfigSchema.js';
import { planMigration } from '../../services/integrations/definitions/migrationPlanner.js';

const silentLog = () => {
  const entries = [];
  const push = level => (msg, meta) => entries.push({ level, msg, meta });
  return {
    entries,
    log: { warn: push('warn'), info: push('info'), debug() {}, error: push('error') }
  };
};

const SCHEMA = {
  type: 'object',
  title: 'Create issue',
  properties: {
    summary: { type: 'string', description: 'Short summary' },
    // A property named like a documentation keyword is a property, not noise.
    description: { type: 'string', description: 'Long text' },
    priority: { type: 'string', enum: ['high', 'low'] }
  },
  required: ['summary', 'description']
};

test('fingerprint: stable across key order, documentation keywords and required order', () => {
  const base = actionFingerprint({ name: 'create', sideEffect: 'write', parameters: SCHEMA });
  assert.ok(isFingerprint(base), 'sha256:<64 hex>');
  const reordered = {
    required: ['description', 'summary'],
    properties: {
      priority: { enum: ['high', 'low'], type: 'string' },
      description: { type: 'string', description: 'Langer Text' },
      summary: { description: 'Kurze Zusammenfassung', type: 'string', examples: ['Bug'] }
    },
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object'
  };
  assert.equal(
    actionFingerprint({ name: 'create', sideEffect: 'write', parameters: reordered }),
    base,
    'localized descriptions, examples, $schema and key order do not count'
  );
  // An empty `required` is the same as none; no parameters is the empty object schema.
  assert.equal(
    actionFingerprint({
      name: 'ping',
      parameters: { type: 'object', properties: {}, required: [] }
    }),
    actionFingerprint({ name: 'ping' })
  );
  const canonical = canonicalSchema(SCHEMA);
  assert.ok(canonical.properties.description, 'a property called "description" is kept');
  assert.equal(canonical.title, undefined);
});

test('fingerprint: identical whatever the key insertion order (code-unit order, no locale)', () => {
  const keys = ['zeta', 'Alpha', 'émoji', 'beta', 'Zulu', '_x', '10', '9'];
  const build = order => {
    const properties = {};
    for (const key of order) properties[key] = { type: 'string', enum: ['b', 'a'] };
    return { type: 'object', properties, required: [...order].reverse() };
  };
  const forward = actionFingerprint({ name: 'act', sideEffect: 'read', parameters: build(keys) });
  const backward = actionFingerprint({
    name: 'act',
    sideEffect: 'read',
    parameters: build([...keys].reverse())
  });
  const shuffled = actionFingerprint({
    name: 'act',
    sideEffect: 'read',
    parameters: build(['beta', '9', 'Zulu', 'émoji', 'zeta', '_x', 'Alpha', '10'])
  });
  assert.equal(backward, forward);
  assert.equal(shuffled, forward);
  // Code units, not the locale: uppercase before lowercase. (Integer-like keys
  // are always enumerated numerically by JS objects, hence by JSON.stringify.)
  assert.deepEqual(Object.keys(canonicalSchema(build(keys)).properties), [
    '9',
    '10',
    'Alpha',
    'Zulu',
    '_x',
    'beta',
    'zeta',
    'émoji'
  ]);
  assert.deepEqual(['b', 'B', 'a', 'A'].sort(compareCodeUnits), ['A', 'B', 'a', 'b']);
  assert.equal(compareCodeUnits('x', 'x'), 0);
});

test('fingerprint: name, side effect and the schema itself all count', () => {
  const base = actionFingerprint({ name: 'create', sideEffect: 'write', parameters: SCHEMA });
  const differs = [
    { name: 'create2', sideEffect: 'write', parameters: SCHEMA },
    { name: 'create', sideEffect: 'destructive', parameters: SCHEMA },
    { name: 'create', sideEffect: 'write', parameters: { ...SCHEMA, required: ['summary'] } },
    {
      name: 'create',
      sideEffect: 'write',
      parameters: {
        ...SCHEMA,
        properties: { ...SCHEMA.properties, assignee: { type: 'string' } }
      }
    },
    {
      name: 'create',
      sideEffect: 'write',
      parameters: {
        ...SCHEMA,
        properties: { ...SCHEMA.properties, priority: { type: 'string', enum: ['low', 'high'] } }
      }
    }
  ];
  for (const variant of differs) assert.notEqual(actionFingerprint(variant), base);
  assert.equal(
    actionFingerprint({ name: 'x', sideEffect: 'bogus' }),
    actionFingerprint({ name: 'x', sideEffect: 'unknown' }),
    'an unknown value counts as unknown'
  );
});

test('fingerprint: the declared side effect counts, never the admin override', () => {
  const definition = { actions: [{ name: 'list', sideEffect: 'write' }] };
  // OpenAPI's discoverActions folds the admin override into `sideEffect`.
  const overridden = fingerprintsOfActions(
    [{ name: 'list', sideEffect: 'read', parameters: { type: 'object' } }],
    definition
  );
  const declared = fingerprintsOfActions(
    [{ name: 'list', sideEffect: 'write', parameters: { type: 'object' } }],
    definition
  );
  assert.equal(overridden.list, declared.list);
  // An action that could not be read gets no fingerprint (no placeholder baseline).
  assert.deepEqual(fingerprintsOfActions([{ name: 'broken', error: 'no operation' }], null), {});
});

test('fingerprint: an MCP tool and its admin action listing agree', () => {
  const raw = {
    name: 'search',
    description: 'Search the wiki',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    annotations: { readOnlyHint: true }
  };
  const conn = Object.create(McpServerConnection.prototype);
  conn.config = { id: 'wiki' };
  const [tool] = conn.buildToolSets([raw]).tools;
  // What McpAdapter.discoverActions lists for the same raw tool.
  const action = { name: raw.name, sideEffect: 'read', parameters: raw.inputSchema };
  assert.equal(fingerprintOfTool(tool), fingerprintsOfActions([action], { actions: [] }).search);
});

test('fingerprint: a schema property named __proto__ is part of the hash', () => {
  const schemaWith = type =>
    JSON.parse(`{"type":"object","properties":{"__proto__":{"type":"${type}"}}}`);
  assert.notEqual(
    actionFingerprint({ name: 'x', parameters: schemaWith('string') }),
    actionFingerprint({ name: 'x', parameters: schemaWith('number') })
  );
});

test('fingerprint: an MCP App view call carries the same fingerprint as the model tool', () => {
  const raw = {
    name: 'delete_page',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true }
  };
  const conn = Object.create(McpServerConnection.prototype);
  conn.config = { id: 'wiki', mcpApps: { enabled: true } };
  const { tools, appTools } = conn.buildToolSets([raw]);
  const modelFingerprint = fingerprintOfTool(tools[0]);
  const target = appTools.get('delete_page') || {
    name: raw.name,
    inputSchema: raw.inputSchema,
    annotations: raw.annotations
  };
  const viewDef = viewCallToolDef({ serverId: 'wiki', name: 'delete_page', target });
  assert.ok(modelFingerprint);
  assert.equal(viewDef._integration.fingerprint, modelFingerprint);

  // Accepted as it is: no newOrChanged. Changed schema: newOrChanged asks.
  const installation = {
    id: 'wiki',
    approval: { default: 'never' },
    actions: { fingerprints: { delete_page: modelFingerprint } }
  };
  const known = resolveToolApproval(viewDef, null, {}, { installation });
  assert.notEqual(known.approvalSource, 'newOrChanged');
  const changed = viewCallToolDef({
    serverId: 'wiki',
    name: 'delete_page',
    target: { ...target, inputSchema: { type: 'object', properties: { id: { type: 'number' } } } }
  });
  const policy = resolveToolApproval(changed, null, {}, { installation });
  assert.deepEqual([policy.approval, policy.approvalSource], ['always', 'newOrChanged']);
});

test('fingerprint: an A2A skill tool and its admin action listing agree', () => {
  const card = { name: 'Agent', skills: [{ id: 'triage', name: 'Triage', description: 'Sorts' }] };
  const { tools } = buildSkillTools({ id: 'helper', allowedSkills: ['*'] }, card);
  // A2aAdapter's action for a skill: the same schema with other descriptions, side effect unknown.
  const action = {
    name: 'triage',
    sideEffect: 'unknown',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to ask the agent' },
        data: {
          type: 'object',
          description: 'Optional structured input',
          additionalProperties: true
        },
        fileIds: {
          type: 'array',
          description: 'Optional ids of files of this chat to send to the agent',
          items: { type: 'string' }
        }
      },
      required: ['message']
    }
  };
  assert.equal(fingerprintOfTool(tools[0]), fingerprintsOfActions([action], null).triage);
});

// ---------------------------------------------------------------------------
// Resolver

const FP_V1 = actionFingerprint({ name: 'comment', sideEffect: 'write', parameters: SCHEMA });
const FP_V2 = actionFingerprint({
  name: 'comment',
  sideEffect: 'destructive',
  parameters: SCHEMA
});
const jiraTool = (fingerprint = FP_V1, action = 'comment') => ({
  id: `jira__${action}`,
  type: 'integration',
  _integration: { instanceId: 'jira', action, fingerprint },
  sideEffect: 'read',
  dataFlow: 'external'
});
const reviewed = (approval, fingerprints = { comment: FP_V1 }, extra = {}) => ({
  id: 'jira',
  approval,
  actions: { fingerprints, ...extra }
});

test('review state: new, changed, reviewed, and no baseline', () => {
  const inst = reviewed({ default: 'never' });
  assert.equal(actionReviewState(inst, 'comment', FP_V1), null);
  assert.equal(actionReviewState(inst, 'comment', FP_V2), 'changed');
  assert.equal(actionReviewState(inst, 'delete', FP_V1), 'new');
  assert.equal(actionReviewState({ id: 'jira', approval: {} }, 'delete', FP_V1), null);
  assert.equal(actionReviewState(inst, 'comment', null), null, 'no current fingerprint');
  assert.deepEqual(reviewStatesOf(inst, { comment: FP_V2, delete: FP_V1 }), {
    comment: 'changed',
    delete: 'new'
  });
});

test('resolver: a new action resolves to newOrChanged (default always) until reviewed', () => {
  const installation = reviewed({ default: 'never' });
  const fresh = resolveToolApproval(jiraTool(FP_V1, 'delete'), null, {}, { installation });
  assert.deepEqual([fresh.approval, fresh.approvalSource], ['always', 'newOrChanged']);
  assert.equal(needsApproval(fresh), true, 'even a declared read asks');
  const known = resolveToolApproval(jiraTool(FP_V1), null, {}, { installation });
  assert.deepEqual([known.approval, known.approvalSource], ['never', 'default']);
});

test('resolver: a changed schema or side effect resolves to newOrChanged', () => {
  const installation = reviewed({ default: 'never' });
  const changed = resolveToolApproval(jiraTool(FP_V2), null, {}, { installation });
  assert.deepEqual([changed.approval, changed.approvalSource], ['always', 'newOrChanged']);
  // Reviewing accepts the current fingerprint: the action is back to its own mode.
  const afterReview = resolveToolApproval(
    jiraTool(FP_V2),
    null,
    {},
    { installation: reviewed({ default: 'never' }, { comment: FP_V2 }) }
  );
  assert.equal(afterReview.approval, 'never');
});

test('resolver precedence: newOrChanged only tightens, and only with an approval setting', () => {
  // A configured newOrChanged mode is used instead of always.
  const writes = resolveToolApproval(
    jiraTool(FP_V2),
    null,
    {},
    { installation: reviewed({ newOrChanged: 'writes' }) }
  );
  assert.deepEqual([writes.approval, writes.approvalSource], ['writes', 'newOrChanged']);
  // It cannot loosen a stricter action mode.
  const action = resolveToolApproval(
    jiraTool(FP_V2),
    null,
    {},
    { installation: reviewed({ newOrChanged: 'never', actions: { comment: 'always' } }) }
  );
  assert.deepEqual([action.approval, action.approvalSource], ['always', 'action']);
  // `never` switches the reset off.
  const off = resolveToolApproval(
    jiraTool(FP_V2),
    null,
    {},
    { installation: reviewed({ newOrChanged: 'never' }) }
  );
  assert.equal(off.approval, 'never');
  // Opt-in: an installation without an approval setting is not gated, baseline or not.
  const unconfigured = resolveToolApproval(
    jiraTool(FP_V2),
    null,
    {},
    { installation: reviewed(undefined) }
  );
  assert.equal(unconfigured.approval, 'never');
  // An app can tighten beyond it but not loosen it.
  _resetLoggedLoosening();
  const { log } = silentLog();
  const app = resolveToolApproval(
    jiraTool(FP_V2),
    { id: 'a', toolApproval: { default: 'never' } },
    {},
    { installation: reviewed({}), log }
  );
  assert.deepEqual([app.approval, app.approvalSource], ['always', 'newOrChanged']);
});

test('an app override that tries to loosen an action mode is ignored and logged', () => {
  _resetLoggedLoosening();
  const { log, entries } = silentLog();
  const installation = { id: 'jira', approval: { actions: { comment: 'always' } } };
  const app = { id: 'support', toolApproval: { tools: { jira: 'writes' } } };
  const policy = resolveToolApproval(jiraTool(null), app, {}, { installation, log });
  assert.deepEqual([policy.approval, policy.approvalSource], ['always', 'action']);
  const warnings = entries.filter(e => e.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.appMode, 'writes');
  assert.equal(warnings[0].meta.effectiveSource, 'action');
});

test('resolver: the action dataFlow override wins and picks the platform default', () => {
  const platform = { toolApproval: { defaults: { internal: 'never', external: 'always' } } };
  const tool = jiraTool(null);
  assert.equal(resolveToolApproval(tool, null, platform).approval, 'always');
  const installation = {
    id: 'jira',
    actions: { overrides: { comment: { dataFlow: 'internal' } } }
  };
  const policy = resolveToolApproval(tool, null, platform, { installation });
  assert.equal(policy.dataFlow, 'internal');
  assert.equal(policy.approval, 'never');
  // An MCP tool is external unless the admin says otherwise.
  const mcp = {
    id: 'srv__q',
    _mcp: { originalName: 'q' },
    _integration: { instanceId: 'srv', action: 'q' }
  };
  assert.equal(resolveToolApproval(mcp, null, platform).dataFlow, 'external');
  assert.equal(
    resolveToolApproval(mcp, null, platform, {
      installation: { id: 'srv', actions: { overrides: { q: { dataFlow: 'internal' } } } }
    }).dataFlow,
    'internal'
  );
});

test('config schema keeps fingerprints, reviewedAt, newOrChanged and the dataFlow override', () => {
  const result = validateIntegrationsConfig({
    installed: [
      {
        id: 'jira',
        definition: 'com.example/jira',
        actions: {
          overrides: { comment: { dataFlow: 'internal', sideEffect: 'write' } },
          fingerprints: { comment: FP_V1 },
          reviewedAt: '2026-11-02T10:00:00.000Z'
        },
        approval: { default: 'writes', newOrChanged: 'writes' }
      }
    ]
  });
  assert.equal(result.success, true, JSON.stringify(result.errors));
  const [inst] = result.data.installed;
  assert.equal(inst.actions.fingerprints.comment, FP_V1);
  assert.equal(inst.actions.reviewedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(inst.actions.overrides.comment.dataFlow, 'internal');
  assert.equal(inst.approval.newOrChanged, 'writes');
  const bad = validateIntegrationsConfig({
    installed: [{ id: 'x', definition: 'com.example/x', actions: { fingerprints: { a: 'md5:1' } } }]
  });
  assert.equal(bad.success, false, 'a malformed fingerprint is refused');
});

test('a definition migration keeps the accepted fingerprints and newOrChanged', () => {
  const instance = {
    id: 'crm',
    definition: 'com.example/crm',
    definitionVersion: '1.0.0',
    values: {},
    actions: {
      enabled: ['*'],
      disabled: [],
      overrides: {},
      fingerprints: { create_lead: FP_V1 },
      reviewedAt: '2026-11-01T00:00:00.000Z'
    },
    approval: { default: 'writes', newOrChanged: 'writes' }
  };
  const planned = planMigration({
    instance,
    apps: [],
    definition: { id: 'com.example/crm', version: '2.0.0' },
    from: '1.0.0',
    migrations: [
      { id: '2.0.0', steps: [{ renameAction: { from: 'create_lead', to: 'create_contact' } }] }
    ]
  });
  assert.ok(planned.ok);
  assert.deepEqual(planned.instance.actions.fingerprints, { create_lead: FP_V1 });
  assert.equal(planned.instance.actions.reviewedAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(planned.instance.approval, { default: 'writes', newOrChanged: 'writes' });
  // The renamed action was never accepted under its new name: it is new until reviewed.
  assert.equal(actionReviewState(planned.instance, 'create_contact', FP_V1), 'new');
});

// ---------------------------------------------------------------------------
// Discovery: baseline once, never a write on an unchanged (or changed) discovery

function fakeService(instance) {
  const state = { instance: structuredClone(instance), writes: 0 };
  return {
    state,
    get: id => (state.instance?.id === id ? structuredClone(state.instance) : null),
    recordActionBaseline: async (id, fingerprints) => {
      if (state.instance.actions?.fingerprints) return null;
      state.writes += 1;
      state.instance.actions = { ...state.instance.actions, fingerprints: { ...fingerprints } };
      return state.instance;
    }
  };
}

test('discovery takes the baseline once, from a complete list, on an installation with approval', async () => {
  _resetActionReview();
  const { log } = silentLog();
  const service = fakeService({ id: 'jira', approval: { default: 'writes' }, actions: {} });
  const current = { comment: FP_V1 };
  // A partial list (MCP tools of a chat request) never becomes a baseline.
  let result = await observeActionFingerprints('jira', current, { complete: false, service, log });
  assert.equal(service.state.writes, 0);
  assert.equal(result.baseline, false);
  // Nothing listed: no baseline (a per-user server's catalog may still be empty).
  await observeActionFingerprints('jira', {}, { service, log });
  assert.equal(service.state.writes, 0);
  result = await observeActionFingerprints('jira', current, { service, log });
  assert.equal(result.baseline, true);
  assert.equal(service.state.writes, 1);
  assert.deepEqual(service.state.instance.actions.fingerprints, current);
});

test('discovery without an approval setting writes nothing (opt-in)', async () => {
  _resetActionReview();
  const { log } = silentLog();
  const service = fakeService({ id: 'jira', actions: {} });
  await observeActionFingerprints('jira', { comment: FP_V1 }, { service, log });
  assert.equal(service.state.writes, 0);
});

test('unchanged discovery writes nothing; a change is reported once and not stored', async () => {
  _resetActionReview();
  const { log, entries } = silentLog();
  const service = fakeService(reviewed({ default: 'writes' }));
  for (let i = 0; i < 3; i += 1) {
    const result = await observeActionFingerprints('jira', { comment: FP_V1 }, { service, log });
    assert.deepEqual(result.pending, {});
  }
  assert.equal(service.state.writes, 0, 'no write on unchanged discovery');
  assert.equal(entries.filter(e => e.level === 'warn').length, 0);
  for (let i = 0; i < 3; i += 1) {
    const result = await observeActionFingerprints(
      'jira',
      { comment: FP_V2, delete: FP_V1 },
      { service, log }
    );
    assert.deepEqual(result.pending, { comment: 'changed', delete: 'new' });
  }
  assert.equal(service.state.writes, 0, 'a change is derived, never written by discovery');
  const warnings = entries.filter(e => e.level === 'warn');
  assert.equal(warnings.length, 2, 'reported once per action and fingerprint');
  assert.deepEqual(warnings.map(w => w.meta.state).sort(), ['changed', 'new']);
  assert.equal(warnings[0].meta.gated, true);
});

// ---------------------------------------------------------------------------
// Install preset

test('install preset: writes, and always for external integrations without trusted side effects', () => {
  assert.equal(installApprovalPreset({ dynamicActions: true, actions: [] }), 'always', 'MCP / A2A');
  assert.equal(
    installApprovalPreset({
      actions: [
        { name: 'search', sideEffect: 'read', dataFlow: 'external' },
        { name: 'comment', sideEffect: 'write', dataFlow: 'external' }
      ]
    }),
    'writes'
  );
  assert.equal(
    installApprovalPreset({
      actions: [{ name: 'run', sideEffect: 'unknown', dataFlow: 'external' }]
    }),
    'always'
  );
  assert.equal(
    installApprovalPreset({
      actions: [{ name: 'run', sideEffect: 'unknown', dataFlow: 'internal' }]
    }),
    'writes',
    'an internal action with an unknown effect is still asked for under writes'
  );
  assert.equal(installApprovalPreset(null), 'writes');
});
