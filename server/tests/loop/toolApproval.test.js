// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool approval resolver (#2945): precedence (platform → tool / installation
 * → action → app, strictest wins), tighten-only app overrides, untrusted MCP
 * annotations, keys by the action's original name, and the segment planner giving gated calls
 * their own batch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveToolApproval,
  stampToolApproval,
  toolNeedsApproval,
  platformApprovalDefaults,
  toolApprovalConfigProblem,
  sideEffectFromAnnotations,
  _resetLoggedLoosening
} from '../../utils/toolApproval.js';
import { needsApproval, stricterMode } from '../../../shared/toolApproval.js';
import { planToolBatches } from '../../services/loop/segmentPlanner.js';

const silent = () => {
  const warnings = [];
  return {
    warnings,
    log: { warn: (msg, meta) => warnings.push({ msg, meta }), info() {}, debug() {}, error() {} }
  };
};

const local = (fields = {}) => ({ id: 'lookup', name: 'lookup', ...fields });
const jiraComment = {
  id: 'jira__comment',
  type: 'integration',
  _integration: { instanceId: 'jira', instanceLabel: 'Jira', action: 'comment' },
  sideEffect: 'write',
  dataFlow: 'external'
};
const mcpTool = (annotations, prefix = 'srv__') => ({
  id: `${prefix}search`,
  _mcp: { serverId: 'srv', originalName: 'search', ...(annotations ? { annotations } : {}) },
  _integration: { instanceId: 'srv', action: 'search' }
});

test('opt-in: nothing configured resolves to never and nothing is gated', () => {
  const policy = resolveToolApproval(local(), { id: 'app' }, {});
  assert.equal(policy.approval, 'never');
  assert.equal(policy.approvalSource, 'default');
  assert.equal(needsApproval(policy), false);
  assert.equal(toolNeedsApproval(jiraComment, null, null), false);
});

test('precedence table: each layer can tighten, the strictest one wins and is named', () => {
  const platform = { toolApproval: { defaults: { default: 'never', external: 'writes' } } };
  // 1. platform by data flow
  let p = resolveToolApproval(jiraComment, null, platform);
  assert.deepEqual([p.approval, p.approvalSource], ['writes', 'platform:external']);
  // `default` covers a data flow without its own entry
  p = resolveToolApproval(local(), null, { toolApproval: { defaults: { default: 'writes' } } });
  assert.deepEqual([p.approval, p.approvalSource], ['writes', 'platform']);
  // 2. installation default tightens the platform
  p = resolveToolApproval(jiraComment, null, platform, {
    installation: { id: 'jira', approval: { default: 'always' } }
  });
  assert.deepEqual([p.approval, p.approvalSource], ['always', 'installation']);
  // 3. the action tightens the installation default
  p = resolveToolApproval(
    jiraComment,
    null,
    {},
    {
      installation: { id: 'jira', approval: { default: 'writes', actions: { comment: 'always' } } }
    }
  );
  assert.deepEqual([p.approval, p.approvalSource], ['always', 'action']);
  // 4. the app tightens everything below
  p = resolveToolApproval(jiraComment, { id: 'a', toolApproval: { default: 'always' } }, platform);
  assert.deepEqual([p.approval, p.approvalSource], ['always', 'app']);
  // tool file config (local tools)
  p = resolveToolApproval(local({ approval: 'always' }), null, platform);
  assert.deepEqual([p.approval, p.approvalSource], ['always', 'tool']);
  // `requiresApproval: true` (the scheduled-run flag) is `always`
  p = resolveToolApproval(local({ requiresApproval: true }), null, {});
  assert.deepEqual([p.approval, p.approvalSource], ['always', 'tool']);
});

test('strictest wins: a later layer cannot loosen an earlier one', () => {
  const p = resolveToolApproval(
    jiraComment,
    null,
    {},
    {
      installation: { id: 'jira', approval: { default: 'always', actions: { comment: 'never' } } }
    }
  );
  assert.equal(p.approval, 'always');
  assert.equal(p.approvalSource, 'installation');
  assert.equal(stricterMode('writes', 'never'), 'writes');
  assert.equal(stricterMode('bogus', 'never'), 'never');
});

test('an app override that tries to loosen is ignored and logged once', () => {
  _resetLoggedLoosening();
  const { log, warnings } = silent();
  const app = { id: 'loose', toolApproval: { tools: { jira__comment: 'never' } } };
  const installation = { id: 'jira', approval: { default: 'always' } };
  const first = resolveToolApproval(jiraComment, app, {}, { installation, log });
  const second = resolveToolApproval(jiraComment, app, {}, { installation, log });
  assert.equal(first.approval, 'always');
  assert.equal(second.approval, 'always');
  assert.equal(first.approvalSource, 'installation');
  assert.equal(warnings.length, 1, 'logged once per app, tool and value');
  assert.equal(warnings[0].meta.appMode, 'never');
});

test('an app override can name an installation id for all its actions', () => {
  const app = { id: 'a', toolApproval: { tools: { jira: 'always' } } };
  assert.equal(resolveToolApproval(jiraComment, app, {}).approval, 'always');
});

test('MCP annotations never relax a gate: a claimed read still asks under writes', () => {
  const installation = { id: 'srv', approval: { default: 'writes' } };
  const readClaim = resolveToolApproval(
    mcpTool({ readOnlyHint: true }),
    null,
    {},
    {
      installation
    }
  );
  assert.equal(readClaim.sideEffect, 'read');
  assert.equal(readClaim.sideEffectSource, 'annotation');
  assert.equal(readClaim.dataFlow, 'external');
  assert.equal(needsApproval(readClaim), true, 'untrusted read is gated under writes');
  // The admin confirms it as a read (action override): now trusted.
  const confirmed = resolveToolApproval(
    mcpTool({ readOnlyHint: true }),
    null,
    {},
    {
      installation: { ...installation, actions: { overrides: { search: { sideEffect: 'read' } } } }
    }
  );
  assert.equal(confirmed.sideEffectSource, 'admin');
  assert.equal(needsApproval(confirmed), false);
  // `always` asks whatever the server claims.
  const always = resolveToolApproval(
    mcpTool({ readOnlyHint: true }),
    null,
    {},
    {
      installation: { id: 'srv', approval: { default: 'always' } }
    }
  );
  assert.equal(needsApproval(always), true);
  // A missing annotation is unknown, which `writes` treats as a write.
  const none = resolveToolApproval(mcpTool(null), null, {}, { installation });
  assert.equal(none.sideEffect, 'unknown');
  assert.equal(needsApproval(none), true);
  assert.equal(sideEffectFromAnnotations({ destructiveHint: true }), 'destructive');
});

test('writes mode: destructive and unknown count as writes, a declared read does not', () => {
  const base = { approval: 'writes', sideEffectSource: 'definition' };
  assert.equal(needsApproval({ ...base, sideEffect: 'read' }), false);
  assert.equal(needsApproval({ ...base, sideEffect: 'write' }), true);
  assert.equal(needsApproval({ ...base, sideEffect: 'destructive' }), true);
  assert.equal(needsApproval({ ...base, sideEffect: 'unknown' }), true);
  assert.equal(needsApproval({ approval: 'never', sideEffect: 'destructive' }), false);
});

test('per-action approval is keyed by the original action name, not the prefixed tool id', () => {
  const installation = { id: 'srv', approval: { actions: { search: 'always' } } };
  const before = resolveToolApproval(mcpTool(null, 'srv__'), null, {}, { installation });
  const renamed = resolveToolApproval(mcpTool(null, 'custom_'), null, {}, { installation });
  assert.equal(before.approval, 'always');
  assert.equal(renamed.approval, 'always', 'a changed toolPrefix keeps the setting');
  const byToolId = resolveToolApproval(
    mcpTool(null, 'srv__'),
    null,
    {},
    {
      installation: { id: 'srv', approval: { actions: { srv__search: 'always' } } }
    }
  );
  assert.equal(byToolId.approval, 'never', 'the prefixed id is not a key');
});

test('stamping returns copies with the policy and is idempotent', () => {
  const tools = [local({ approval: 'writes' }), jiraComment];
  const stamped = stampToolApproval(
    tools,
    null,
    {},
    {
      getInstallation: id => (id === 'jira' ? { id, approval: { default: 'always' } } : null)
    }
  );
  assert.notEqual(stamped[0], tools[0]);
  assert.equal(tools[0].approvalSource, undefined, 'the loaded tool is not mutated');
  assert.equal(stamped[0].approval, 'writes');
  assert.equal(stamped[1].approval, 'always');
  assert.equal(stamped[1].approvalSource, 'installation');
  // Re-resolving a stamped tool (no installation at hand) keeps the stamp.
  assert.equal(resolveToolApproval(stamped[1], null, {}).approval, 'always');
  // Interactive tools never need approval.
  assert.equal(toolNeedsApproval({ id: 'ask_user', interactive: true, approval: 'always' }), false);
});

test('platform defaults: unknown keys and modes are dropped and refused on save', () => {
  assert.deepEqual(
    platformApprovalDefaults({ toolApproval: { defaults: { default: 'x', external: 'always' } } }),
    { external: 'always' }
  );
  assert.equal(toolApprovalConfigProblem({ defaults: { external: 'writes' } }), null);
  assert.match(
    toolApprovalConfigProblem({ defaults: { external: 'sometimes' } }),
    /must be one of/
  );
  assert.match(toolApprovalConfigProblem({ defaults: { other: 'never' } }), /not a known key/);
  assert.match(toolApprovalConfigProblem([]), /must be an object/);
});

test('segment planner: a gated call gets its own batch', () => {
  const item = (id, extra = {}) => ({
    call: { id, function: { name: id } },
    toolDef: { id, readOnly: true, ...extra },
    args: { q: id }
  });
  const batches = planToolBatches(
    [
      item('a'),
      item('b', { approval: 'always', approvalSource: 'tool', sideEffect: 'read' }),
      item('c')
    ],
    { parallel: true }
  );
  assert.deepEqual(
    batches.map(b => b.map(i => i.call.id)),
    [['a'], ['b'], ['c']]
  );
});

// ---------------------------------------------------------------------------
// The exemption of personal apps: internal reads that iHub ships
// ---------------------------------------------------------------------------

/** A tool as `readShippedToolDefinitions` returns it for the knowledge tools. */
const knowledgeSearch = {
  id: 'knowledge_search',
  name: 'Project knowledge_search',
  sideEffect: 'read',
  dataFlow: 'internal',
  _shipped: true
};
const sharedApp = (toolApproval = {}) => ({
  id: 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8',
  toolApproval: { default: 'always', exemptInternalReads: true, ...toolApproval }
});

test('exemptInternalReads: a shipped tool that only reads and stays inside iHub does not ask', () => {
  const policy = resolveToolApproval(knowledgeSearch, sharedApp(), {});
  assert.equal(policy.approval, 'never');
  assert.equal(needsApproval(policy), false);
  assert.deepEqual(
    [policy.sideEffect, policy.sideEffectSource, policy.dataFlow],
    ['read', 'tool', 'internal']
  );
});

test('exemptInternalReads: without the flag the app default asks for the same tool', () => {
  const app = { id: 'app', toolApproval: { default: 'always' } };
  const policy = resolveToolApproval(knowledgeSearch, app, {});
  assert.deepEqual([policy.approval, policy.approvalSource], ['always', 'app']);
});

test('exemptInternalReads: every other tool keeps the app default', () => {
  const cases = {
    'a tool that writes': { ...knowledgeSearch, sideEffect: 'write' },
    'a tool that leaves iHub': { ...knowledgeSearch, dataFlow: 'external' },
    'a tool that is not shipped, but claims to read': { ...knowledgeSearch, _shipped: undefined },
    'a tool an author could name, without the mark': { id: 'read_url', sideEffect: 'read' },
    'an integration action': {
      ...knowledgeSearch,
      _integration: { instanceId: 'wiki', action: 'search' }
    },
    'an MCP tool that calls itself read-only': mcpTool({ readOnlyHint: true }),
    'a tool with no declaration': local()
  };
  for (const [name, tool] of Object.entries(cases)) {
    const policy = resolveToolApproval(tool, sharedApp(), {});
    assert.equal(policy.approval, 'always', name);
  }
});

test('exemptInternalReads: what is configured for the tool, the platform or the tool file still applies', () => {
  // A mode for this very tool in the app.
  let policy = resolveToolApproval(
    knowledgeSearch,
    sharedApp({ tools: { knowledge_search: 'always' } }),
    {}
  );
  assert.deepEqual([policy.approval, policy.approvalSource], ['always', 'app']);
  // The platform default by data flow: the exemption leaves the app's own default out, not this.
  policy = resolveToolApproval(knowledgeSearch, sharedApp(), {
    toolApproval: { defaults: { internal: 'always' } }
  });
  assert.deepEqual([policy.approval, policy.approvalSource], ['always', 'platform:internal']);
  // The tool file asks for approval itself.
  policy = resolveToolApproval({ ...knowledgeSearch, requiresApproval: true }, sharedApp(), {});
  assert.deepEqual([policy.approval, policy.approvalSource], ['always', 'tool']);
});

test('exemptInternalReads: stamping gives the knowledge tools never and the web tools always', () => {
  const read = { id: 'read_url', name: 'read_url', sideEffect: 'read', dataFlow: 'external' };
  const stamped = stampToolApproval([knowledgeSearch, read, jiraComment], sharedApp(), {});
  assert.deepEqual(
    stamped.map(tool => [tool.id, tool.approval]),
    [
      ['knowledge_search', 'never'],
      ['read_url', 'always'],
      ['jira__comment', 'always']
    ]
  );
});
