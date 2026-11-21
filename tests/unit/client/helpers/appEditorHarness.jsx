// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the tests of the app editor page (`AdminAppEditPage`) share: a stand-in
 * for the server behind the admin API, and stand-ins for the form's parts that
 * follow the contract between the page and the form (plan section 3.5).
 *
 * The page, its parts in `components/app-editor/`, the save bar, the test
 * panel, the access section, the admin API module and the group state
 * (`useEditorGroups`) are the real ones in those tests. Use the stand-ins from
 * `jest.mock` factories:
 *
 * @example
 * jest.mock('../../../client/src/shared/components/DualModeEditor', () =>
 *   require('./helpers/appEditorHarness').MockDualModeEditor
 * );
 */
const {
  groupDomIds
} = require('../../../../client/src/features/admin/components/app-form/editorGroups');

/** An axios-like error with a status and a problem+json body. */
function httpError(status, detail = 'Request failed', code = undefined) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { status, detail, code }, headers: {} };
  return error;
}

/**
 * The server behind `apiClient`, for one app. It keeps the stored app and the
 * access view, applies PUT, `_toggle` and access changes to them, and records
 * every request. Set `failures[<METHOD> <url>]` to an error to make that
 * request fail.
 *
 * @param {object} options
 * @param {object} options.app - The stored app.
 * @param {object} [options.access] - The content-access view.
 * @returns {{request: Function, calls: object[], writes: () => object[], state: object, failures: object}}
 */
function createAppServer({ app, access }) {
  const state = {
    app,
    access: access || {
      type: 'apps',
      id: app.id,
      scope: 'all',
      groups: [],
      audience: { allSignedIn: true, anonymous: false }
    }
  };
  const calls = [];
  const failures = {};
  const appUrl = `/admin/apps/${app.id}`;
  const accessUrl = `/admin/content-access/apps/${app.id}`;

  const request = async config => {
    const method = String(config.method || 'GET').toUpperCase();
    const { url, data } = config;
    calls.push({ method, url, data });
    const failure = failures[`${method} ${url}`];
    if (failure) throw failure;

    if (url === appUrl && method === 'GET') return { data: state.app, headers: {} };
    if (url === appUrl && method === 'PUT') {
      state.app = data;
      return { data: { id: app.id }, headers: {} };
    }
    if (url === `${appUrl}/_toggle` && method === 'POST') {
      state.app = { ...state.app, enabled: data.enabled };
      return { data: { enabled: data.enabled, ids: [app.id] }, headers: {} };
    }
    if (url === accessUrl && method === 'GET') return { data: state.access, headers: {} };
    if (url === accessUrl && method === 'PUT') {
      const granted = new Set(data.grant || []);
      const revoked = new Set(data.revoke || []);
      state.access = {
        ...state.access,
        groups: state.access.groups.map(group => {
          if (granted.has(group.id)) return { ...group, granted: true, effective: true };
          if (revoked.has(group.id)) return { ...group, granted: false, effective: false };
          return group;
        })
      };
      return { data: { ...state.access, changed: true }, headers: {} };
    }
    throw httpError(404, `No stand-in for ${method} ${url}`);
  };

  return {
    request,
    calls,
    writes: () => calls.filter(call => call.method !== 'GET'),
    state,
    failures
  };
}

/**
 * A group of the editor as the contract describes it: a header button and a
 * panel that stays mounted and is hidden while the group is collapsed, with
 * the DOM ids of `groupDomIds`.
 */
function MockEditorGroup({ id, groups, children }) {
  const ids = groupDomIds(id);
  const open = groups.isOpen(id);
  return (
    <section id={ids.group} data-testid={`group-${id}`}>
      <button
        id={ids.header}
        type="button"
        aria-expanded={open}
        aria-controls={ids.panel}
        onClick={() => groups.toggle(id)}
      >
        {`group:${id}`}
      </button>
      <div id={ids.panel} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** The index of the groups: only what the page hands it. */
function MockEditorGroupNav({ groups, compact }) {
  return (
    <nav data-testid="group-nav" data-compact={String(Boolean(compact))}>
      {groups.groups.map(group => group.id).join(' ')}
    </nav>
  );
}

/**
 * The form in place of `DualModeEditor`: enough fields to edit the app, the
 * form's group "Instructions and inputs", a switch to the JSON mode, and two
 * buttons that report validation the way the form does.
 */
function MockDualModeEditor({ value, onChange, onValidationChange, onModeChange, formProps }) {
  const groups = formProps?.groups;
  const nameLanguage = Object.keys(value?.name || {})[0] || 'en';
  return (
    <div data-testid="app-form">
      <output data-testid="form-value">{JSON.stringify(value ?? null)}</output>
      <input
        aria-label="Name"
        value={value?.name?.[nameLanguage] ?? ''}
        onChange={event =>
          onChange({ ...value, name: { ...value.name, [nameLanguage]: event.target.value } })
        }
      />
      {groups && (
        <MockEditorGroup id="instructions" groups={groups}>
          <textarea
            id="system"
            aria-label="Instructions"
            value={value?.system?.en ?? ''}
            onChange={event => onChange({ ...value, system: { en: event.target.value } })}
          />
        </MockEditorGroup>
      )}
      <button
        type="button"
        onClick={() =>
          onValidationChange({
            isValid: false,
            errors: [{ field: 'system', message: 'Enter instructions.', severity: 'error' }]
          })
        }
      >
        report one error
      </button>
      <button
        type="button"
        onClick={() =>
          onValidationChange({
            isValid: false,
            errors: [
              { field: 'system', message: 'Enter instructions.', severity: 'error' },
              { field: 'starterPrompts.0.title', message: 'Enter a text.', severity: 'error' }
            ]
          })
        }
      >
        report two errors
      </button>
      <button type="button" onClick={() => onValidationChange({ isValid: true, errors: [] })}>
        report valid
      </button>
      <button type="button" onClick={() => onModeChange('json')}>
        JSON mode
      </button>
    </div>
  );
}

module.exports = {
  createAppServer,
  httpError,
  MockDualModeEditor,
  MockEditorGroup,
  MockEditorGroupNav
};
