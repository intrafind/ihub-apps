// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Side effect and data flow of every built-in action (#2973): each action of
 * every shipped `com.intrafind__*` definition declares `sideEffect` and
 * `dataFlow` itself (the schema's defaults, `unknown` and `external`, are not
 * a declaration), and the declarations match the committed snapshot
 * `__snapshots__/builtin-action-policies.json`. A change to what an action
 * may do or where its data goes is then a visible, reviewed diff.
 *
 * Update intentionally with:
 *   UPDATE_SNAPSHOTS=1 node --test server/tests/integrations/builtinActionPolicies.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_FLOWS, SIDE_EFFECTS } from '../../validators/integrationDefinitionSchema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.join(here, '..', '..', 'defaults', 'integration-definitions');
const SNAPSHOT = path.join(here, '__snapshots__', 'builtin-action-policies.json');

/** The shipped `com.intrafind__*` definitions, as written in their files. */
function shippedIntraFindDefinitions() {
  return fs
    .readdirSync(DEFINITIONS_DIR)
    .filter(dir => dir.startsWith('com.intrafind__'))
    .sort()
    .map(dir => JSON.parse(fs.readFileSync(path.join(DEFINITIONS_DIR, dir, 'integration.json'))));
}

/** `{ "<definition id>": { "<action>": { sideEffect, dataFlow } } }`, definitions without actions left out. */
function actionPolicies(definitions) {
  const out = {};
  for (const definition of definitions) {
    const actions = definition.actions || [];
    if (actions.length === 0) continue;
    out[definition.id] = Object.fromEntries(
      actions.map(action => [
        action.name,
        { sideEffect: action.sideEffect, dataFlow: action.dataFlow }
      ])
    );
  }
  return out;
}

describe('side effect and data flow of the built-in actions (#2973)', () => {
  const definitions = shippedIntraFindDefinitions();
  const policies = actionPolicies(definitions);

  it('every action declares a known side effect and data flow', () => {
    const undeclared = [];
    for (const [definitionId, actions] of Object.entries(policies)) {
      for (const [name, { sideEffect, dataFlow }] of Object.entries(actions)) {
        if (!SIDE_EFFECTS.includes(sideEffect) || sideEffect === 'unknown') {
          undeclared.push(`${definitionId} ${name}: sideEffect ${sideEffect}`);
        }
        if (!DATA_FLOWS.includes(dataFlow)) {
          undeclared.push(`${definitionId} ${name}: dataFlow ${dataFlow}`);
        }
      }
    }
    assert.deepEqual(undeclared, []);
    assert.ok(Object.keys(policies).length > 0, 'the shipped definitions declare actions');
  });

  it('matches the committed snapshot', () => {
    const current = `${JSON.stringify(policies, null, 2)}\n`;
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
      fs.writeFileSync(SNAPSHOT, current, 'utf8');
      return;
    }
    assert.ok(
      fs.existsSync(SNAPSHOT),
      'No snapshot yet: run with UPDATE_SNAPSHOTS=1 and commit __snapshots__/builtin-action-policies.json'
    );
    // Structural: the snapshot's formatting (Prettier) must not fail the test.
    assert.deepEqual(
      policies,
      JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')),
      'A built-in action changed its side effect or data flow, or one was added or removed. If intentional, re-run with UPDATE_SNAPSHOTS=1 and review the diff.'
    );
  });
});
