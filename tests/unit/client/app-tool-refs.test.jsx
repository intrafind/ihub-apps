// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool references a chat starts with. A binding under `app.integrations`
 * gives the model its integration's actions, and a chat whose `enabledTools`
 * leaves the binding out switches those tools off. The iFinder Search app of a
 * 5.6.4 install upgraded to 5.6.5-RC1 binds `ifinder` and lists no tools, and
 * the chat sent `enabledTools: []`: the model got none of the iFinder tools.
 */
import {
  appDefaultToolRefs,
  appHasToolBindings,
  appToolRefs,
  boundIntegrationRefs
} from '../../../client/src/shared/utils/boundIntegrationRefs';

describe('boundIntegrationRefs', () => {
  it('includes the iFinder binding, whose actions are the iFinder tools', () => {
    expect(boundIntegrationRefs({ integrations: { ifinder: { scopePicker: 'menu' } } })).toEqual([
      'ifinder'
    ]);
    expect(
      boundIntegrationRefs({ integrations: { ifinder: { actions: ['search', 'getContent'] } } })
    ).toEqual(['ifinder']);
  });

  it('leaves out bindings that give no tools', () => {
    expect(
      boundIntegrationRefs({
        integrations: {
          // scope settings only
          ifinder: { actions: [], defaultScope: 'contracts' },
          // the iAssistant integration has no actions
          iassistant: { scopePicker: 'menu' },
          jira: {}
        }
      })
    ).toEqual(['jira']);
  });

  it('is empty without bindings', () => {
    expect(boundIntegrationRefs({})).toEqual([]);
    expect(boundIntegrationRefs(null)).toEqual([]);
    expect(boundIntegrationRefs({ integrations: null })).toEqual([]);
  });
});

describe('appHasToolBindings', () => {
  it('does not count storage providers: they offer files, not tools', () => {
    const app = {
      integrations: {
        'type:storage': { required: false },
        'com.intrafind/nextcloud': {},
        'com.intrafind/office365': {},
        'com.intrafind/google-drive': {}
      }
    };
    // still picker references, but an app that only attaches cloud files
    // needs no tool-capable model
    expect(boundIntegrationRefs(app)).toContain('type:storage');
    expect(appHasToolBindings(app)).toBe(false);
    expect(appHasToolBindings({ integrations: { ...app.integrations, jira: {} } })).toBe(true);
  });
});

describe('appToolRefs', () => {
  it('lists the integrations the app binds, once each, and no leftover `tools`', () => {
    expect(
      appToolRefs({
        tools: ['ask_user', 'jira'],
        integrations: { ihub: { actions: ['ask_user'] }, ifinder: {}, jira: {}, iassistant: {} }
      })
    ).toEqual(['ihub', 'ifinder', 'jira']);
  });

  it('gives the upgraded iFinder Search app its iFinder tools', () => {
    expect(
      appToolRefs({ id: 'ifinder-search', integrations: { ifinder: { scopePicker: 'menu' } } })
    ).toEqual(['ifinder']);
  });

  it('is empty for an app without tools or bindings', () => {
    expect(appToolRefs({ id: 'chat' })).toEqual([]);
    expect(appToolRefs(undefined)).toEqual([]);
  });
});

describe('appHasToolBindings', () => {
  it('is true when the app binds an integration for its tools', () => {
    expect(appHasToolBindings({ integrations: { ifinder: {} } })).toBe(true);
  });

  it('is false for scope-only bindings, iAssistant and an app without bindings', () => {
    expect(appHasToolBindings({ integrations: { jira: { actions: [] }, iassistant: {} } })).toBe(
      false
    );
    expect(appHasToolBindings({ id: 'chat', tools: ['ask_user'] })).toBe(false);
    expect(appHasToolBindings(null)).toBe(false);
  });
});

describe('appDefaultToolRefs', () => {
  it('starts with everything the app offers when no binding is available only', () => {
    const app = {
      integrations: {
        ihub: { actions: ['ask_user'] },
        ifinder: {},
        jira: { enabledByDefault: true }
      }
    };
    expect(appDefaultToolRefs(app)).toEqual(appToolRefs(app));
  });

  it('leaves out the integrations a binding makes available only', () => {
    const app = {
      integrations: {
        ihub: { actions: ['ask_user'] },
        ifinder: {},
        jira: { enabledByDefault: false }
      }
    };
    expect(appToolRefs(app)).toEqual(['ihub', 'ifinder', 'jira']);
    expect(appDefaultToolRefs(app)).toEqual(['ihub', 'ifinder']);
  });

  it('is empty for an app without bindings', () => {
    expect(appDefaultToolRefs({})).toEqual([]);
    expect(appDefaultToolRefs(null)).toEqual([]);
  });
});
