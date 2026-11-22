// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rendered app editor has exactly one control that changes whether the
 * app is published (plan section 3.5): "Publish" in the header while it is
 * not, "Unpublish" under "More" while it is. The form has none.
 *
 * Here the page renders its real form (`AppFormEditor` in the real
 * `DualModeEditor`) and the real access section. Two checks:
 *
 * - by name: one control is called Publish, Unpublish, Enabled, Published or
 *   Not published, collapsed groups included;
 * - by behaviour: toggling every checkbox, switch and radio button of the page
 *   never changes the app's `enabled` and never sends a toggle.
 *
 * `app-editor-publish.test.jsx` covers what the one control does.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockI18n = i18next.createInstance();
const mockT = (...args) => mockI18n.t(...args);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: mockI18n }),
  Trans: ({ children }) => children
}));

const mockRequest = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: (...args) => mockRequest(...args)
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => p,
  buildApiUrl: p => `/api${p}`,
  buildAssetUrl: p => p,
  getBasePath: () => ''
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));
jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(() => Promise.resolve([{ id: 'stub', name: 'Stub model', default: true }])),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: jest.fn(() => Promise.resolve({ id: 'chat', type: 'chat' }))
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/pages/AppChat', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);

// The real form, with a listener on what it hands back to the page.
const mockFormChanges = [];
jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => {
  const RealForm = jest.requireActual(
    '../../../client/src/features/admin/components/AppFormEditor'
  ).default;
  return function ObservedForm(props) {
    return (
      <RealForm
        {...props}
        onChange={next => {
          mockFormChanges.push(next);
          props.onChange(next);
        }}
      />
    );
  };
});
// The form's two group components belong to the form; the page only places them.
jest.mock(
  '../../../client/src/features/admin/components/app-form/EditorGroup',
  () => require('./helpers/appEditorHarness').MockEditorGroup,
  { virtual: true }
);
jest.mock(
  '../../../client/src/features/admin/components/app-form/EditorGroupNav',
  () => require('./helpers/appEditorHarness').MockEditorGroupNav,
  { virtual: true }
);

const { createAppServer } = require('./helpers/appEditorHarness');
const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;

const TEXT = en.admin.apps.edit;
const STATUS = en.admin.apps.status;
/** Every name a control that publishes or unpublishes an app has had. */
const PUBLISH_NAMES = new Set([
  TEXT.publish.action,
  TEXT.unpublish.action,
  TEXT.enabled,
  STATUS.published,
  STATUS.notPublished,
  'Enabled'
]);
const APP = {
  id: 'chat',
  type: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  system: { en: 'You are a helpful assistant.' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  enabled: false
};

let server;

async function renderEditor(app) {
  server = createAppServer({ app });
  mockRequest.mockImplementation(server.request);
  render(
    <MemoryRouter initialEntries={['/admin/apps/chat']}>
      <Routes>
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByRole('heading', { level: 1 });
  // Let the form's own requests (models, projects, templates) settle.
  await act(async () => {});
}

const TOGGLES = 'input[type="checkbox"], input[type="radio"], [role="switch"]';

/**
 * What a toggle is called on the page: the label around it or tied to it,
 * else the label that stands beside it without being tied to it, else its
 * name or ID.
 */
function toggleLabel(toggle) {
  const sibling = toggle.nextElementSibling || toggle.previousElementSibling;
  const label =
    toggle.closest('label') ||
    (toggle.id ? document.querySelector(`label[for="${toggle.id}"]`) : null) ||
    (sibling?.tagName === 'LABEL' ? sibling : null);
  return (
    label?.textContent.trim() ||
    toggle.getAttribute('aria-label') ||
    toggle.getAttribute('name') ||
    toggle.id ||
    '(unnamed)'
  );
}

/**
 * The controls that publish or unpublish, hidden ones included: by accessible
 * name, and for a toggle also by the label beside it (a label that is not
 * tied to its checkbox gives it no accessible name, yet names it for the eye).
 */
function publishControls() {
  const byName = ['button', 'menuitem', 'checkbox', 'switch', 'radio', 'option'].flatMap(role =>
    screen.queryAllByRole(role, { hidden: true, name: name => PUBLISH_NAMES.has(name.trim()) })
  );
  const byLabel = [...document.querySelectorAll(TOGGLES)].filter(toggle =>
    PUBLISH_NAMES.has(toggleLabel(toggle))
  );
  return [...new Set([...byName, ...byLabel])];
}

/**
 * Toggles every checkbox, switch and radio button the page shows right now.
 *
 * @param {boolean} enabled - The app's `enabled` before.
 * @returns {Promise<{count: number, offenders: string[]}>} How many were toggled, and
 *   the labels of those after which the form handed back another `enabled`.
 */
async function toggleEverything(enabled) {
  const toggles = [...document.querySelectorAll(TOGGLES)];
  const offenders = [];
  let count = 0;
  for (const toggle of toggles) {
    // A toggle can remove another one from the page.
    if (!toggle.isConnected) continue;
    const label = toggleLabel(toggle);
    const before = mockFormChanges.length;
    await act(async () => {
      fireEvent.click(toggle);
    });
    count += 1;
    if (mockFormChanges.slice(before).some(next => next.enabled !== enabled)) {
      offenders.push(label);
      // Put it back, so that the toggles after it are judged on their own.
      await act(async () => {
        fireEvent.click(toggle);
      });
    }
  }
  return { count, offenders };
}

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(() => {
  mockRequest.mockReset();
  mockFormChanges.length = 0;
  window.localStorage.clear();
  // The form's own requests have no stand-in here and report that.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the rendered editor with its real form', () => {
  test.each([
    ['an app that is not published', false, TEXT.publish.action],
    ['a published app', true, TEXT.unpublish.action]
  ])('%s has one control with a name that publishes or unpublishes', async (_, enabled, label) => {
    await renderEditor({ ...APP, enabled });
    // The form is there: the checks below would pass on an empty page.
    expect(document.querySelectorAll('input, textarea, select').length).toBeGreaterThan(5);
    fireEvent.click(screen.getByRole('button', { name: TEXT.more }));

    const controls = publishControls();

    expect(controls.map(control => control.textContent.trim() || toggleLabel(control))).toEqual([
      label
    ]);
    // It is the page's control, not one of the form.
    expect(controls[0].closest('.form-editor')).toBeNull();
  });

  test.each([
    ['an app that is not published', false],
    ['a published app', true]
  ])('no checkbox, switch or radio button of %s changes it', async (_, enabled) => {
    await renderEditor({ ...APP, enabled });

    const { count, offenders } = await toggleEverything(enabled);

    // The form has such controls, and what they change reached the page.
    expect(count).toBeGreaterThan(5);
    expect(mockFormChanges.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    expect(server.writes().filter(call => call.url.endsWith('/_toggle'))).toEqual([]);
    expect(screen.getByTestId('app-status')).toHaveTextContent(
      enabled ? STATUS.published : STATUS.notPublished
    );
  });
});
