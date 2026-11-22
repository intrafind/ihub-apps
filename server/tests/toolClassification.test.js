// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every tool iHub ships or builds itself says what it does to the system it
 * talks to (`sideEffect`), and the declaration is the one in the tables below
 * (#2485, #3785).
 *
 * The declaration decides two things: whether a call is asked for under the
 * approval mode `writes`, and whether it may run side by side with other calls
 * (`isTrustedReadOnly`). A `read` on a tool that writes is the worst mistake
 * here, so every row gives the reason for its class, taken from the code that
 * runs the tool. The test fails when
 *
 * - a shipped tool file, or one of its functions, declares nothing;
 * - a tool is added or removed and the table does not follow;
 * - a declaration is changed without the table (and so without a reason);
 * - a tool the server builds in code (`isInternalTool`, a system-skill tool)
 *   declares nothing.
 *
 * Run: node --test server/tests/toolClassification.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import configCache from '../configCache.js';
import '../services/integrations/protocols/native/connectors/register.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { loadTools } from '../services/tools/catalog.js';
import { expandShippedTool, shippedToolsDir } from '../services/tools/shippedToolDefinitions.js';
import { SYSTEM_SKILL_TOOL_IDS, systemSkillToolsFor } from '../services/systemSkillTools.js';
import { recallToolDefinition } from '../services/loop/findingsDigest.js';
import { toolSearchToolDefinition } from '../services/tools/toolSearch.js';
import { chatContextToolsFor } from '../services/chat/chatContextTools.js';
import { byCodeUnit } from './golden/byCodeUnit.js';
import { builtInTool } from './helpers/builtInTools.js';
import {
  isTrustedReadOnly,
  resolveSideEffect,
  resolveUntrustedInput,
  stampToolApproval
} from '../utils/toolApproval.js';
import { needsApproval } from '../../shared/toolApproval.js';
import {
  actionOverrideSchema,
  integrationsConfigSchema
} from '../validators/integrationsConfigSchema.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECLARABLE = ['read', 'write', 'destructive'];

/**
 * The shipped tools (`server/defaults/tools/*.json`, one row per function of a
 * function-style file): the class, and why.
 */
const SHIPPED = {
  ask_user: ['read', 'asks the person a question; the question seam takes the call, nothing runs'],
  chat_artifacts_list: ['read', 'lists the files earlier answers of this chat created'],
  chat_artifacts_read: ['read', 'returns the text of one of them'],
  chat_files_list: ['read', 'lists the files uploaded to this chat'],
  chat_files_read: ['read', 'returns the text of one uploaded file'],
  chat_sources_list: ['read', 'lists the sources earlier answers of this chat found'],
  chat_sources_read: ['read', 'returns the stored text of one source'],
  create_task: ['write', "adds a task to the run's task queue (workflow state)"],
  delete_scheduled_task: ['destructive', 'deletes a scheduled task'],
  evidence_collect: [
    'read',
    'builds a record from its arguments and returns it; stores nothing (tools/evidence.js collect)'
  ],
  evidence_validateQuotesFastPath: [
    'read',
    'compares quotes with a text passed in; stores nothing'
  ],
  evidence_composeReport: ['write', 'renders the report and stores it as an artifact of the run'],
  get_task_run: ['read', 'returns one earlier run of a scheduled task'],
  iFinder_search: ['read', 'searches the iFinder index'],
  iFinder_getContent: ['read', 'returns the text of a document'],
  iFinder_discover: ['read', 'lists what a search profile can find'],
  iFinder_getMetadata: ['read', 'returns the metadata of a document'],
  iFinder_getFields: ['read', 'lists the fields of a search profile'],
  iFinder_getFacetValues: ['read', 'lists the values of a facet'],
  iFinder_listProfiles: ['read', 'lists the search profiles'],
  knowledge_search: ['read', 'searches the documents of the projects of the request'],
  knowledge_read: ['read', 'returns the text of a project document'],
  knowledge_list: ['read', 'lists the documents of a project'],
  list_scheduled_tasks: ['read', "lists the user's scheduled tasks"],
  list_task_runs: ['read', 'lists the earlier runs of a scheduled task'],
  list_tasks: ['read', "returns the run's task queue"],
  mark_task_done: ['write', 'changes the state of a task in the task queue'],
  read_inbox: ['read', 'returns the inbox file of an agent profile'],
  read_memory: ['read', 'returns the notes of an agent or a scheduled task'],
  read_url: ['read', 'fetches a page with GET and returns its text'],
  run_scheduled_task_now: ['write', 'starts a run of a scheduled task'],
  schedule_task: ['write', 'creates a scheduled task'],
  update_scheduled_task: ['write', 'changes a scheduled task'],
  write_artifact: ['write', 'stores a file as an artifact of the run'],
  write_inbox: ['write', 'changes the inbox file of an agent profile'],
  write_memory: ['write', 'changes the notes of an agent or a scheduled task']
};

/** The tools of the system skills (`services/systemSkillTools.js`). */
const SYSTEM_SKILL = {
  create_pdf: ['write', 'creates a file of the chat'],
  preview_pdf: ['read', 'renders a page of a file the chat already holds as an image'],
  create_docx: ['write', 'creates a file of the chat'],
  edit_docx: ['write', 'creates a changed version of a file of the chat'],
  create_pptx: ['write', 'creates a file of the chat'],
  restyle_pptx: ['write', 'creates a changed version of a file of the chat'],
  edit_pptx: ['write', 'creates a changed version of a file of the chat'],
  create_xlsx: ['write', 'creates a file of the chat'],
  edit_xlsx: ['write', 'creates a changed version of a file of the chat'],
  create_web_artifact: ['write', 'creates a web page of the chat'],
  edit_web_artifact: ['write', 'creates a changed version of a web page of the chat'],
  create_dashboard: ['write', 'creates a dashboard of the chat'],
  edit_dashboard: ['write', 'creates a changed version of a dashboard of the chat'],
  create_file: ['write', 'creates a file of the chat'],
  create_zip: ['write', 'creates an archive of files of the chat']
};

/**
 * The tools the server builds in code and marks `isInternalTool`: the file that
 * builds each, the class, and why.
 */
const INTERNAL = {
  activate_skill: [
    'services/tools/appTools.js',
    'read',
    "loads a skill's instructions into the turn"
  ],
  read_skill_resource: ['services/tools/appTools.js', 'read', 'returns a file of a skill'],
  find_skill: ['services/tools/appTools.js', 'read', 'searches the skills by keywords'],
  search_tools: [
    'services/tools/toolSearch.js',
    'read',
    'searches the tools this request left out; what it finds joins the tools of this run only'
  ],
  recall_tool_result: [
    'services/loop/findingsDigest.js',
    'read',
    'returns a result this run already holds'
  ]
};

/** Every tool the shipped files stand for, by id. */
function shippedTools() {
  const tools = new Map();
  const files = readdirSync(shippedToolsDir()).filter(name => name.endsWith('.json'));
  for (const name of files.sort(byCodeUnit)) {
    const file = JSON.parse(readFileSync(path.join(shippedToolsDir(), name), 'utf8'));
    for (const tool of expandShippedTool(file)) tools.set(tool.id, tool);
  }
  return { tools, files };
}

/** The JavaScript files of the server that are not tests. */
function serverSources(dir = SERVER_DIR, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === 'defaults') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) serverSources(full, found);
    else if (name.endsWith('.js')) found.push(full);
  }
  return found;
}

/**
 * Every place that marks a tool `isInternalTool: true`, with the side effect
 * declared in the four lines after the mark (null for none).
 */
function internalToolMarks() {
  const marks = [];
  for (const file of serverSources()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/^\s*isInternalTool: true,?\s*$/.test(line)) return;
      const after = lines.slice(index + 1, index + 5).join('\n');
      const declared = /^\s*sideEffect: '([a-z]+)',?\s*$/m.exec(after);
      marks.push({
        file: path.relative(SERVER_DIR, file).split(path.sep).join('/'),
        line: index + 1,
        sideEffect: declared ? declared[1] : null
      });
    });
  }
  return marks;
}

describe('the shipped tool files declare their side effect', () => {
  const { tools, files } = shippedTools();

  it('covers the 23 shipped files', () => {
    assert.equal(files.length, 23, 'a tool file was added or removed: update the table');
  });

  it('every tool, and every function of a tool, declares one', () => {
    const silent = [...tools.values()].filter(tool => !DECLARABLE.includes(tool.sideEffect));
    assert.deepEqual(
      silent.map(tool => tool.id),
      [],
      'Declare "sideEffect" (read, write or destructive) in server/defaults/tools/<id>.json, ' +
        'for the file or per function, and add a row with the reason to the table of this test.'
    );
  });

  it('the declarations are the ones of the table', () => {
    assert.deepEqual(
      Object.fromEntries([...tools].map(([id, tool]) => [id, tool.sideEffect])),
      Object.fromEntries(Object.entries(SHIPPED).map(([id, [effect]]) => [id, effect]))
    );
    for (const [id, [, why]] of Object.entries(SHIPPED)) {
      assert.ok(why.length > 10, `${id} needs a reason`);
    }
  });

  it('no file keeps the old readOnly flag beside the declaration', () => {
    for (const tool of tools.values()) assert.equal(tool.readOnly, undefined, tool.id);
  });

  it('is a declared value for the approval gate and for parallel calls', () => {
    for (const tool of tools.values()) {
      const { sideEffect, sideEffectSource } = resolveSideEffect(tool);
      assert.equal(sideEffect, SHIPPED[tool.id][0], tool.id);
      assert.equal(sideEffectSource, 'tool', tool.id);
      assert.equal(isTrustedReadOnly(tool), SHIPPED[tool.id][0] === 'read', tool.id);
    }
  });
});

describe('the shipped definitions as the tool list carries them', () => {
  const originalGetFeatures = configCache.getFeatures;
  let loaded;

  before(async () => {
    await integrationRegistry.ensureLoaded();
    configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
    configCache.setCacheEntry('config/groups.json', { groups: { users: {} } });
    configCache.setCacheEntry('config/apps.json', []);
    configCache.setCacheEntry('config/integrations.json', {
      installed: [],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    configCache.getFeatures = () => ({ skills: false, appAsTool: false, projects: true });
    loaded = await loadTools('de');
  });

  after(() => {
    configCache.getFeatures = originalGetFeatures;
    for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
  });

  /** The tool as an app's tool list holds it: loaded, localized, stamped. */
  const stamped = tool => stampToolApproval([tool], null, null)[0];

  it('the value survives loading and localisation, and is stamped as trusted', () => {
    const { tools } = shippedTools();
    const carried = [
      ...loaded.filter(tool => tools.has(tool.id)),
      ...chatContextToolsFor({
        inventory: { sources: true, files: true, artifacts: true },
        language: 'de'
      })
    ];
    // The platform tools, iHub's own tools and the chat context tools: all loaded here.
    assert.ok(carried.length >= 24, `only ${carried.length} shipped tools were loaded`);
    for (const tool of carried) {
      const [effect] = SHIPPED[tool.id];
      const out = stamped(tool);
      assert.equal(out.sideEffect, effect, tool.id);
      assert.ok(['tool', 'definition'].includes(out.sideEffectSource), tool.id);
      assert.equal(out.readOnly === true, effect === 'read', `${tool.id} readOnly`);
      assert.equal(isTrustedReadOnly(out), effect === 'read', `${tool.id} as stamped`);
    }
  });

  it("iHub's own integration declares the same value as the tool file", () => {
    const { tools } = shippedTools();
    const owned = loaded.filter(tool => tool._integration && tools.has(tool.id));
    assert.ok(
      owned.some(tool => tool.id === 'list_scheduled_tasks'),
      'the ihub tools are loaded'
    );
    for (const tool of owned) {
      assert.equal(tool.sideEffect, tools.get(tool.id).sideEffect, tool.id);
    }
  });

  it('under the approval mode "writes" a declared read runs, everything else is asked for', () => {
    const { tools } = shippedTools();
    const platform = { toolApproval: { defaults: { default: 'writes' } } };
    for (const tool of loaded.filter(candidate => tools.has(candidate.id))) {
      if (tool.requiresUserInput) continue;
      const out = stampToolApproval([tool], null, platform)[0];
      assert.equal(needsApproval(out), SHIPPED[tool.id][0] !== 'read', tool.id);
    }
  });
});

describe('the tools the server builds in code declare their side effect', () => {
  it('every system-skill tool declares the value of the table', () => {
    const tools = systemSkillToolsFor(
      [{ name: 'all', isSystem: true, providedTools: [...SYSTEM_SKILL_TOOL_IDS] }],
      { language: 'en', model: { supportsImages: true } }
    );
    assert.deepEqual(
      Object.fromEntries(tools.map(tool => [tool.id, tool.sideEffect])),
      Object.fromEntries(Object.entries(SYSTEM_SKILL).map(([id, [effect]]) => [id, effect])),
      'Declare "sideEffect" on the tool definition and add a row with the reason to the table.'
    );
    for (const tool of tools) {
      assert.equal(isTrustedReadOnly(tool), SYSTEM_SKILL[tool.id][0] === 'read', tool.id);
    }
  });

  it('every tool marked isInternalTool declares one, right after the mark', () => {
    const marks = internalToolMarks();
    assert.deepEqual(
      marks.filter(mark => !DECLARABLE.includes(mark.sideEffect)),
      [],
      "An internal tool says what it does: add sideEffect: '<read|write|destructive>' in the " +
        'lines after isInternalTool: true, and a row with the reason to the table of this test.'
    );
    const expected = Object.values(INTERNAL)
      .map(([file, effect]) => `${file} ${effect}`)
      .sort(byCodeUnit);
    assert.deepEqual(
      marks.map(mark => `${mark.file} ${mark.sideEffect}`).sort(byCodeUnit),
      expected
    );
  });

  it('the tools of the loop itself are trusted reads without a stamp', () => {
    for (const tool of [recallToolDefinition('en'), toolSearchToolDefinition('en')]) {
      assert.equal(tool.sideEffect, INTERNAL[tool.id][1], tool.id);
      assert.equal(isTrustedReadOnly(tool), true, tool.id);
    }
  });

  it('a tool that runs a workflow or another app declares nothing and is never a trusted read', () => {
    const delegating = [
      { id: 'workflow_review', isWorkflowTool: true, passthrough: true },
      { id: 'app__specialist', isAppAsTool: true, _appId: 'specialist' }
    ];
    for (const tool of delegating) {
      const out = stampToolApproval([tool], null, null)[0];
      assert.equal(out.sideEffect, 'unknown', tool.id);
      assert.equal(out.readOnly, undefined, tool.id);
      assert.equal(isTrustedReadOnly(out), false, tool.id);
    }
    // Neither builder may start to declare a read: what they run can write.
    for (const [file, mark] of [
      ['services/tools/appTools.js', 'isWorkflowTool: true'],
      ['services/chat/appToolsGateway.js', 'isAppAsTool: true']
    ]) {
      const lines = readFileSync(path.join(SERVER_DIR, file), 'utf8').split('\n');
      const at = lines.findIndex(line => line.includes(mark));
      assert.ok(at >= 0, `${file} builds the tool`);
      assert.doesNotMatch(lines.slice(at - 6, at + 6).join('\n'), /^\s*sideEffect:/m, file);
    }
  });
});

describe('isTrustedReadOnly', () => {
  const mcp = annotations => ({
    id: 'remote__list',
    _integration: { instanceId: 'remote', action: 'list' },
    _mcp: { serverId: 'remote', originalName: 'list', annotations }
  });
  const adminSays = sideEffect => ({
    id: 'remote',
    actions: { overrides: { list: { sideEffect } } }
  });

  it('is true for a read the tool, the definition or an admin declared', () => {
    assert.equal(isTrustedReadOnly({ id: 'read_url', sideEffect: 'read' }), true);
    assert.equal(
      isTrustedReadOnly({
        id: 'jira__search',
        sideEffect: 'read',
        _integration: { instanceId: 'jira', action: 'search' }
      }),
      true
    );
    assert.equal(isTrustedReadOnly(mcp({}), adminSays('read')), true);
    assert.equal(isTrustedReadOnly(mcp({ destructiveHint: true }), adminSays('read')), true);
  });

  it('is false for a read that only an MCP annotation claims', () => {
    assert.equal(isTrustedReadOnly(mcp({ readOnlyHint: true })), false);
    assert.equal(isTrustedReadOnly(mcp({ readOnlyHint: true }), { id: 'remote' }), false);
    // An MCP tool cannot declare itself, whatever field it carries.
    assert.equal(isTrustedReadOnly({ ...mcp({ readOnlyHint: true }), sideEffect: 'read' }), false);
  });

  it('is false for a read that only the tool of an A2A agent claims, until an admin declares it', () => {
    // As the A2A adapter builds it (`_a2a` and `_integration`), and as the client manager does.
    const viaAdapter = {
      id: 'a2a__agent__summarise',
      sideEffect: 'read',
      _integration: { instanceId: 'agent', action: 'summarise' },
      _a2a: { agentId: 'agent', skillId: 'summarise' }
    };
    const bare = { id: 'a2a__agent__summarise', sideEffect: 'read', _a2a: { agentId: 'agent' } };
    const admin = sideEffect => ({
      id: 'agent',
      actions: { overrides: { summarise: { sideEffect } } }
    });
    for (const tool of [viaAdapter, bare]) {
      assert.equal(isTrustedReadOnly(tool), false);
      // Nothing iHub trusts said `read`: the gate of the mode `writes` asks.
      const resolved = resolveSideEffect(tool);
      assert.deepEqual(resolved, { sideEffect: 'unknown', sideEffectSource: 'default' });
      assert.equal(needsApproval({ approval: 'writes', ...resolved }), true);
    }
    assert.equal(isTrustedReadOnly(viaAdapter, admin('read')), true);
    assert.deepEqual(resolveSideEffect(viaAdapter, admin('read')), {
      sideEffect: 'read',
      sideEffectSource: 'admin'
    });
    assert.equal(isTrustedReadOnly(viaAdapter, admin('write')), false);

    // The stamp follows: no `readOnly` without the admin, `readOnly` with it.
    const stamp = installation =>
      stampToolApproval([viaAdapter], null, null, { getInstallation: () => installation })[0];
    assert.equal(stamp(null).sideEffect, 'unknown');
    assert.notEqual(stamp(null).readOnly, true);
    assert.equal(isTrustedReadOnly(stamp(null)), false);
    assert.equal(stamp(admin('read')).readOnly, true);
    assert.equal(isTrustedReadOnly(stamp(admin('read'))), true);
  });

  it('is false for a tool that declares nothing', () => {
    assert.equal(isTrustedReadOnly({ id: 'custom__lookup', _integration: {} }), false);
    assert.equal(isTrustedReadOnly({ id: 'internal', isInternalTool: true }), false);
    assert.equal(isTrustedReadOnly({ id: 'claims', readOnly: true }), false);
    assert.equal(isTrustedReadOnly({ id: 'unknown', sideEffect: 'unknown' }), false);
    assert.equal(isTrustedReadOnly({ id: 'agent', _a2a: { agentId: 'a' } }), false);
    assert.equal(isTrustedReadOnly(null), false);
    assert.equal(isTrustedReadOnly(undefined), false);
  });

  it('is false for a write, also one an admin set on a declared read', () => {
    assert.equal(isTrustedReadOnly({ id: 'w', sideEffect: 'write' }), false);
    assert.equal(isTrustedReadOnly({ id: 'd', sideEffect: 'destructive' }), false);
    const declaredRead = {
      id: 'remote__list',
      sideEffect: 'read',
      _integration: { instanceId: 'remote', action: 'list' }
    };
    assert.equal(isTrustedReadOnly(declaredRead, adminSays('write')), false);
    assert.equal(isTrustedReadOnly(declaredRead, adminSays('unknown')), false);
  });

  it('answers a stamped tool from its stamp, and the stamp is idempotent', () => {
    const stamp = (tool, installation = null) =>
      stampToolApproval([tool], null, null, { getInstallation: () => installation })[0];
    const annotated = stamp(mcp({ readOnlyHint: true }));
    assert.equal(annotated.sideEffect, 'read');
    assert.equal(annotated.sideEffectSource, 'annotation');
    assert.equal(annotated.readOnly, undefined);
    assert.equal(isTrustedReadOnly(annotated), false);

    const overridden = stamp(mcp({ readOnlyHint: true }), adminSays('read'));
    assert.equal(overridden.readOnly, true);
    assert.equal(isTrustedReadOnly(overridden), true);
    assert.deepEqual(stamp(overridden), overridden);

    // The internal-tool fallback is a read for the gate and no trusted read.
    const internal = stamp({ id: 'internal', isInternalTool: true });
    assert.equal(internal.sideEffect, 'read');
    assert.equal(isTrustedReadOnly(internal), false);

    // A tool's own claim is taken away.
    const claims = stamp({ id: 'claims', readOnly: true });
    assert.equal(claims.readOnly, false);
    assert.equal(isTrustedReadOnly(claims), false);
  });
});

describe('resolveUntrustedInput', () => {
  it('is true for content from outside iHub', () => {
    const outside = [
      { id: 'declared', untrustedInput: true },
      { id: 'read_url', dataFlow: 'external', sideEffect: 'read' },
      { id: 'remote__x', _mcp: { serverId: 'remote', originalName: 'x' } },
      { id: 'agent__x', _a2a: { agentId: 'agent' } },
      { id: 'knowledge_search', activity: { kind: 'search', origin: 'project' } },
      { id: 'chat_files_read', activity: { kind: 'fetch', origin: 'documents' } }
    ];
    for (const tool of outside) assert.equal(resolveUntrustedInput(tool), true, tool.id);
  });

  it('is false for a tool that reads or writes iHub state only', () => {
    for (const tool of [
      { id: 'write_memory', sideEffect: 'write' },
      { id: 'list_tasks', sideEffect: 'read' },
      { id: 'recall_tool_result', isInternalTool: true, activity: { kind: 'search' } }
    ]) {
      assert.equal(resolveUntrustedInput(tool), false, tool.id);
    }
    assert.equal(resolveUntrustedInput(null), false);
  });

  it('an admin can add the flag, and nobody can take it away', () => {
    const tool = {
      id: 'crm__notes',
      dataFlow: 'internal',
      _integration: { instanceId: 'crm', action: 'notes' }
    };
    const adminSays = untrustedInput => ({
      id: 'crm',
      actions: { overrides: { notes: { untrustedInput } } }
    });
    assert.equal(resolveUntrustedInput(tool), false);
    assert.equal(resolveUntrustedInput(tool, adminSays(true)), true);
    // `false` clears nothing: not on the action, not on the tool.
    const external = { ...tool, dataFlow: 'external' };
    assert.equal(resolveUntrustedInput(external, adminSays(false)), true);
    assert.equal(resolveUntrustedInput({ ...external, untrustedInput: false }), true);
    // An admin's internal data flow does not clear a declared flag either.
    const declared = { ...tool, untrustedInput: true };
    assert.equal(
      resolveUntrustedInput(declared, {
        id: 'crm',
        actions: { overrides: { notes: { dataFlow: 'internal' } } }
      }),
      true
    );
  });

  it('the flag an admin adds can be stored on the action, and only as `true`', async () => {
    assert.deepEqual(actionOverrideSchema.parse({ sideEffect: 'read', untrustedInput: true }), {
      sideEffect: 'read',
      untrustedInput: true
    });
    assert.deepEqual(actionOverrideSchema.parse({ sideEffect: 'read' }), { sideEffect: 'read' });
    assert.equal(actionOverrideSchema.safeParse({ untrustedInput: false }).success, false);
    assert.equal(actionOverrideSchema.safeParse({ untrustedInput: 'yes' }).success, false);

    // Through the service behind `PUT …/installed/{id}/actions/{action}`, and back out.
    const { InstalledIntegrationService } =
      await import('../services/integrations/InstalledIntegrationService.js');
    const config = { installed: [{ id: 'crm', definition: 'custom/crm', actions: {} }] };
    const service = new InstalledIntegrationService({
      registry: { list: () => [], get: () => null }
    });
    service._updateConfig = async mutate => mutate(config);
    service._afterChange = async () => {};
    const tool = {
      id: 'crm__notes',
      dataFlow: 'internal',
      _integration: { instanceId: 'crm', action: 'notes' }
    };

    const set = await service.setActionOverride('crm', 'notes', { untrustedInput: true });
    assert.deepEqual(set.override, { untrustedInput: true });
    assert.equal(resolveUntrustedInput(tool, config.installed[0]), true);
    // What is stored passes the schema of the config file unchanged.
    assert.deepEqual(integrationsConfigSchema.parse(config).installed[0].actions.overrides.notes, {
      untrustedInput: true
    });

    await assert.rejects(
      service.setActionOverride('crm', 'notes', { untrustedInput: false }),
      error => error.code === 'INVALID_OVERRIDE'
    );
    assert.equal(
      resolveUntrustedInput(tool, config.installed[0]),
      true,
      'a refused change changes nothing'
    );

    // The admin takes the own mark back; what the tool says itself is not theirs to take.
    const cleared = await service.setActionOverride('crm', 'notes', { untrustedInput: null });
    assert.equal(cleared.override, null);
    assert.equal(resolveUntrustedInput(tool, config.installed[0]), false);
    assert.equal(
      resolveUntrustedInput({ ...tool, dataFlow: 'external' }, config.installed[0]),
      true
    );
  });

  it('the shipped tools that return outside content are flagged', () => {
    const { tools } = shippedTools();
    const flagged = [...tools.values()].filter(tool => resolveUntrustedInput(tool));
    // The files, sources and created files of a chat hold what people uploaded
    // and what earlier answers read; the project documents and a web page likewise.
    assert.deepEqual(flagged.map(tool => tool.id).sort(byCodeUnit), [
      'chat_artifacts_list',
      'chat_artifacts_read',
      'chat_files_list',
      'chat_files_read',
      'chat_sources_list',
      'chat_sources_read',
      'knowledge_list',
      'knowledge_read',
      'knowledge_search',
      'read_url'
    ]);
    // The iFinder tools get their activity from the connector that builds them.
    assert.equal(resolveUntrustedInput(builtInTool('iFinder_search')), true);
    assert.equal(resolveUntrustedInput(builtInTool('iFinder_getContent')), true);
    assert.equal(resolveUntrustedInput(builtInTool('braveSearch')), true);
  });
});
