// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The registry of configurable personal-app keys (`shared/userAppFields.js`,
 * design 07 section 2.1) and the places that have to agree with it.
 *
 * A key that is in the registry but missing from the schema, the content
 * picker or the ceiling saves but does not run, or runs but does not publish.
 * These tests fail at the place that was forgotten:
 *
 *  - the descriptors are well formed (unique keys, known targets, a gate that
 *    exists in the settings);
 *  - the stored content keys are exactly the keys of the content schema;
 *  - every key of the app schema a descriptor produces is a real app key, and
 *    the verdicts in `USER_APP_FIELD_POLICY` are the registry's;
 *  - every stored content key has a sample here, the schema accepts it and the
 *    picker keeps it; a new descriptor without a sample fails this file;
 *  - every key a revision may change is a stored key of a personal app, or
 *    an admin-only key.
 *
 * Run: node --test server/tests/user-app-fields.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  USER_APP_FIELDS,
  USER_APP_FIELD_TARGETS,
  USER_APP_STORED_CONTENT_KEYS,
  appKeyVerdicts,
  fieldKeysToRevise,
  userAppField
} from '../../shared/userAppFields.js';
import {
  USER_APP_CONTENT_KEYS,
  USER_APP_FIELD_POLICY,
  USER_APP_LOCALIZED_KEYS,
  USER_APP_REQUIRED_KEYS,
  pickUserAppContent
} from '../../shared/userAppContent.js';
import { appRevisionKeys } from '../../shared/appRevision.js';
import { knownAppKeys } from '../validators/appConfigSchema.js';
import { userAppContentSchema, userAppPatchSchema } from '../validators/userAppSchema.js';
import { DEFAULT_USER_APP_SETTINGS } from '../services/userApps/userAppSettings.js';

/**
 * One valid value for every stored content key. Adding a descriptor without a
 * sample here fails the test below on purpose: the author of the key then
 * decides what a valid value looks like and the checks run on it.
 */
const SAMPLE_CONTENT = {
  name: { en: 'Job ad writer' },
  description: { en: 'Writes job ads' },
  system: { en: 'You write job ads.' },
  prompt: { en: 'Write an ad for {{role}}.' },
  messagePlaceholder: { en: 'Which role?' },
  variables: [{ name: 'role', label: { en: 'Role' }, type: 'string' }],
  starterPrompts: [{ title: { en: 'Developer' }, message: { en: 'An ad for a developer' } }],
  greeting: { en: { title: 'Job ads', subtitle: 'Tell me the role' } },
  inputMode: { type: 'multiline', rows: 6 },
  // `markdown` is what every app starts with and is not picked as a choice; `text` is.
  preferredOutputFormat: 'text',
  startForm: { enabled: true, submitLabel: { en: 'Write' } },
  variablesPanel: { pinned: true },
  autoStart: true,
  color: '#4F46E5',
  icon: 'document-text',
  preferredModel: 'gpt-4o',
  capabilities: { upload: true, webSearch: false, skills: false, integrations: [] }
};

describe('the descriptors', () => {
  it('have unique keys and known targets', () => {
    const keys = USER_APP_FIELDS.map(field => field.key);
    assert.equal(new Set(keys).size, keys.length, 'a key is described twice');
    for (const field of USER_APP_FIELDS) {
      for (const target of field.revise) {
        assert.ok(
          USER_APP_FIELD_TARGETS.includes(target),
          `${field.key}: unknown target ${target}`
        );
      }
      assert.ok(
        ['content', 'capabilities', 'ceiling', 'admin'].includes(field.store),
        `${field.key}: unknown store ${field.store}`
      );
      assert.ok(
        ['content', 'capability', 'never'].includes(field.verdict),
        `${field.key}: unknown verdict ${field.verdict}`
      );
    }
  });

  it('offer a proposal exactly where the builder may change the key', () => {
    for (const field of USER_APP_FIELDS) {
      const changed = field.revise.length > 0 || field.propose.length > 0;
      if (changed) {
        assert.ok(['direct', 'confirm'].includes(field.proposal), `${field.key}: no proposal kind`);
      } else {
        assert.equal(field.proposal, null, `${field.key}: a proposal without a target`);
      }
    }
  });

  it('put a key in one channel of the builder, and describe what it proposes', () => {
    for (const field of USER_APP_FIELDS) {
      assert.ok(
        field.revise.length === 0 || field.propose.length === 0,
        `${field.key} is in both channels`
      );
      if (field.propose.length > 0) {
        assert.ok(field.hint.trim().length > 0, `${field.key}: the builder has no hint for it`);
        for (const target of field.propose) {
          assert.ok(USER_APP_FIELD_TARGETS.includes(target), `${field.key}: unknown ${target}`);
        }
      }
    }
  });

  it('name a gate that exists in the settings', () => {
    const gates = Object.keys(DEFAULT_USER_APP_SETTINGS.capabilities);
    for (const field of USER_APP_FIELDS.filter(entry => entry.gate)) {
      assert.ok(gates.includes(field.gate), `${field.key}: gate ${field.gate} is not a setting`);
    }
  });

  it('keep the keys of a personal app out of the admin-only store', () => {
    for (const field of USER_APP_FIELDS.filter(entry => entry.store === 'admin')) {
      assert.equal(field.verdict, 'never', `${field.key} is admin-only and cannot be stored`);
      assert.ok(!USER_APP_CONTENT_KEYS.includes(field.key));
    }
  });
});

describe('the app schema', () => {
  it('knows every app key a descriptor produces', () => {
    for (const field of USER_APP_FIELDS) {
      for (const appKey of field.appKeys) {
        assert.ok(knownAppKeys.includes(appKey), `${field.key}: ${appKey} is not an app key`);
      }
    }
  });

  it('has the verdicts of the registry for every key the registry decides', () => {
    for (const [appKey, verdict] of Object.entries(appKeyVerdicts())) {
      assert.equal(USER_APP_FIELD_POLICY[appKey], verdict, `${appKey} differs from the registry`);
    }
  });

  it('gives every app key a verdict', () => {
    for (const appKey of knownAppKeys) {
      assert.ok(Object.hasOwn(USER_APP_FIELD_POLICY, appKey), `${appKey} has no verdict`);
    }
  });
});

describe('the stored content', () => {
  it('has exactly the keys of the content schema', () => {
    assert.deepEqual(
      Object.keys(userAppPatchSchema.shape).sort(),
      [...USER_APP_STORED_CONTENT_KEYS].sort()
    );
    assert.deepEqual([...USER_APP_CONTENT_KEYS], [...USER_APP_STORED_CONTENT_KEYS]);
  });

  it('has a sample for every key, and no sample for a key that is gone', () => {
    assert.deepEqual(Object.keys(SAMPLE_CONTENT).sort(), [...USER_APP_STORED_CONTENT_KEYS].sort());
  });

  it('is accepted by the schema and kept by the content picker with every key set', () => {
    const parsed = userAppContentSchema.parse(SAMPLE_CONTENT);
    for (const key of USER_APP_STORED_CONTENT_KEYS) {
      assert.ok(Object.hasOwn(parsed, key), `the schema dropped ${key}`);
    }
    const picked = pickUserAppContent(SAMPLE_CONTENT);
    for (const key of USER_APP_STORED_CONTENT_KEYS) {
      assert.ok(Object.hasOwn(picked, key), `the content picker dropped ${key}`);
    }
  });

  it('lists its localized and required keys from the registry', () => {
    assert.deepEqual(
      [...USER_APP_LOCALIZED_KEYS],
      USER_APP_FIELDS.filter(field => field.store === 'content' && field.localized).map(
        field => field.key
      )
    );
    assert.deepEqual(
      [...USER_APP_REQUIRED_KEYS],
      USER_APP_FIELDS.filter(field => field.store === 'content' && field.required).map(
        field => field.key
      )
    );
  });
});

describe('a revision', () => {
  it('reads the keys the registry lists for its target', () => {
    for (const target of USER_APP_FIELD_TARGETS) {
      assert.deepEqual([...appRevisionKeys(target)], [...fieldKeysToRevise(target)]);
    }
  });

  it('changes a stored key of a personal app, or an admin-only key', () => {
    for (const key of fieldKeysToRevise('personal')) {
      assert.ok(USER_APP_STORED_CONTENT_KEYS.includes(key), `${key} is not a stored key`);
    }
    for (const key of fieldKeysToRevise('admin')) {
      assert.equal(
        userAppField(key).store === 'admin' || USER_APP_CONTENT_KEYS.includes(key),
        true
      );
    }
  });
});
