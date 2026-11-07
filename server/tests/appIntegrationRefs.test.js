// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which bindings of an app give the model tools, so that a model it uses must
 * support function calling. A storage provider only offers files in the
 * chat's file picker (`file-analysis` binds `type:storage`), and iAssistant is
 * reached through the model: neither counts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appCandidateRefs,
  appHasToolBindings
} from '../services/integrations/appIntegrationRefs.js';

describe('appHasToolBindings', () => {
  it('is false for an app that binds only storage, iAssistant or scope settings', () => {
    assert.equal(
      appHasToolBindings({ integrations: { 'type:storage': { required: false } } }),
      false
    );
    assert.equal(
      appHasToolBindings({
        integrations: { 'com.intrafind/nextcloud': {}, iassistant: {}, ifinder: { actions: [] } }
      }),
      false
    );
    assert.equal(appHasToolBindings({}), false);
  });

  it('is true once an integration with tools is bound next to storage', () => {
    const app = { integrations: { 'type:storage': {}, jira: { actions: ['getTicket'] } } };
    assert.equal(appHasToolBindings(app), true);
    // storage stays a candidate of the chat's integration picker
    assert.deepEqual(appCandidateRefs(app), ['type:storage', 'jira']);
  });
});
