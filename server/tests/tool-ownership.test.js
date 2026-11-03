// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every tool iHub ships has exactly one owner (#2973, Unified Integrations
 * concept 07):
 *
 *   - a built-in integration action: an action of a shipped `builtIn`
 *     definition, under its kept `toolId` or `<instanceId>__<action>`;
 *   - a platform tool of workflows and agents (`services/tools/platformTools.js`);
 *   - a feature: the project knowledge tools (`services/knowledge/knowledgeTools.js`),
 *     the chat context tools (`services/chat/chatContextTools.js`),
 *     the skill tools (`toolLoader.js`, `services/systemSkillTools.js`), apps
 *     as tools (`app__<appId>`) and workflows as tools (`workflow_<id>`).
 *
 * Nothing here lists the expected tools: the shipped files come from
 * `server/defaults/tools/`, the owners from the modules and definitions that
 * claim them. A new tool file without an owner, or a tool two owners claim
 * (an action that takes a platform tool's id, a definition that names a tool
 * a feature already generates), fails the build.
 *
 * Run: node --test server/tests/tool-ownership.test.js (part of `npm run test:tool-loading`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandShippedTool, shippedToolsDir } from '../services/tools/shippedToolDefinitions.js';
import { PLATFORM_TOOL_IDS } from '../services/tools/platformTools.js';
import { KNOWLEDGE_TOOL_IDS } from '../services/knowledge/knowledgeTools.js';
import { CHAT_CONTEXT_TOOL_IDS } from '../services/chat/chatContextToolIds.js';
import { SYSTEM_SKILL_TOOL_IDS } from '../services/systemSkillTools.js';
import { SKILL_TOOL_IDS, WORKFLOW_TOOL_ID_PREFIX } from '../toolLoader.js';
import { APP_TOOL_ID_PREFIX } from '../services/chat/appToolsGateway.js';
import { toolIdFor } from '../services/integrations/protocols/common.js';
import '../services/integrations/protocols/native/connectors/register.js';
import { getConnector } from '../services/integrations/protocols/native/connectors/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.join(here, '..', 'defaults', 'integration-definitions');

/** The shipped tool files, each with the tool ids it stands for (a function-style file: several). */
function shippedToolFiles() {
  return fs
    .readdirSync(shippedToolsDir())
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      const tool = JSON.parse(fs.readFileSync(path.join(shippedToolsDir(), file), 'utf8'));
      return { file, ids: expandShippedTool(tool).map(expanded => expanded.id) };
    });
}

/** The shipped built-in definitions (`builtIn: true`). */
function shippedBuiltInDefinitions() {
  return fs
    .readdirSync(DEFINITIONS_DIR)
    .map(dir => path.join(DEFINITIONS_DIR, dir, 'integration.json'))
    .filter(file => fs.existsSync(file))
    .map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
    .filter(definition => definition.builtIn === true)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The tool id an action of a definition stands for. A definition installed
 * many times has no single id; its actions are `<instance of …>__<action>`,
 * which no shipped tool file can be, so it only shows up when two owners
 * claim it.
 */
function actionToolId(definition, action) {
  const instanceId = definition.singleton?.instanceId || `<instance of ${definition.id}>`;
  return toolIdFor(instanceId, action.name, action);
}

/**
 * Every owner, as the sources declare it: `{ owner, ids }` for owners of
 * fixed ids, `{ owner, prefix }` for features whose tools are generated.
 */
function toolOwners() {
  const owners = [];
  for (const definition of shippedBuiltInDefinitions()) {
    for (const action of definition.actions || []) {
      owners.push({
        owner: `integration ${definition.id} action ${action.name}`,
        ids: [actionToolId(definition, action)]
      });
    }
  }
  owners.push({ owner: 'platform tools (workflows and agents)', ids: [...PLATFORM_TOOL_IDS] });
  owners.push({ owner: 'projects (knowledge tools)', ids: [...KNOWLEDGE_TOOL_IDS] });
  owners.push({ owner: 'chats (chat context tools)', ids: [...CHAT_CONTEXT_TOOL_IDS] });
  owners.push({ owner: 'skills', ids: [...SKILL_TOOL_IDS] });
  owners.push({ owner: 'system skills', ids: [...SYSTEM_SKILL_TOOL_IDS] });
  owners.push({ owner: 'apps as tools', prefix: APP_TOOL_ID_PREFIX });
  owners.push({ owner: 'workflows as tools', prefix: WORKFLOW_TOOL_ID_PREFIX });
  return owners;
}

/** The owners that claim a tool id. */
function ownersOf(toolId, owners) {
  return owners
    .filter(entry => (entry.prefix ? toolId.startsWith(entry.prefix) : entry.ids.includes(toolId)))
    .map(entry => entry.owner);
}

/**
 * The tool ids that do not have exactly one owner.
 * @param {string[]} toolIds
 * @param {Array<{owner: string, ids?: string[], prefix?: string}>} owners
 * @returns {Array<{toolId: string, owners: string[]}>}
 */
function ownershipProblems(toolIds, owners) {
  return [...new Set(toolIds)]
    .map(toolId => ({ toolId, owners: ownersOf(toolId, owners) }))
    .filter(entry => entry.owners.length !== 1);
}

/** A readable list of problems for the assertion message. */
function describeProblems(problems) {
  return problems
    .map(({ toolId, owners }) =>
      owners.length === 0
        ? `${toolId}: no owner (give it a built-in integration action, make it a platform tool, or a feature's tool)`
        : `${toolId}: ${owners.length} owners (${owners.join('; ')})`
    )
    .join('\n');
}

describe('ownership of the shipped tools (#2973)', () => {
  const files = shippedToolFiles();
  const owners = toolOwners();

  it('finds the shipped tool files and the owners in the sources', () => {
    assert.ok(files.length > 0, 'server/defaults/tools/ holds tool files');
    assert.ok(
      owners.some(entry => entry.owner.startsWith('integration ')),
      'the built-in definitions declare actions'
    );
  });

  it('every tool of every file in server/defaults/tools/ has exactly one owner', () => {
    const problems = ownershipProblems(
      files.flatMap(file => file.ids),
      owners
    );
    assert.deepEqual(problems, [], `\n${describeProblems(problems)}`);
  });

  it('every tool id an owner claims is claimed by that owner only', () => {
    const claimed = owners.flatMap(entry => entry.ids || []);
    const problems = ownershipProblems(claimed, owners);
    assert.deepEqual(problems, [], `\n${describeProblems(problems)}`);
    assert.equal(new Set(claimed).size, claimed.length, 'no owner lists a tool id twice');
  });

  it('every action of a native built-in is implemented by its connector', () => {
    const missing = [];
    for (const definition of shippedBuiltInDefinitions()) {
      if (definition.protocol?.type !== 'native') continue;
      const connector = getConnector(definition.protocol.module);
      assert.ok(
        connector,
        `${definition.id}: connector "${definition.protocol.module}" is registered`
      );
      for (const action of definition.actions || []) {
        if (typeof connector.actions?.[action.name]?.run !== 'function') {
          missing.push(`${definition.id} action ${action.name}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  describe('the check itself', () => {
    const sample = [
      { owner: 'integration a', ids: ['a_search'] },
      { owner: 'platform', ids: ['write_thing'] },
      { owner: 'apps as tools', prefix: 'app__' }
    ];

    it('fails a shipped tool nobody owns', () => {
      assert.deepEqual(ownershipProblems(['a_search', 'new_tool'], sample), [
        { toolId: 'new_tool', owners: [] }
      ]);
    });

    it('fails a tool two owners claim, by id or by a feature prefix', () => {
      const twice = [...sample, { owner: 'integration b', ids: ['write_thing', 'app__x'] }];
      assert.deepEqual(ownershipProblems(['write_thing', 'app__x'], twice), [
        { toolId: 'write_thing', owners: ['platform', 'integration b'] },
        { toolId: 'app__x', owners: ['apps as tools', 'integration b'] }
      ]);
    });

    it('passes tools with one owner each', () => {
      assert.deepEqual(ownershipProblems(['a_search', 'write_thing', 'app__y'], sample), []);
    });
  });
});
