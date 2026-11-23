// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminAgentEditPage from '../../../client/src/features/admin/pages/AdminAgentEditPage';
import { fetchAgentProfile, updateAgentProfile } from '../../../client/src/api/agentsAdminApi';
import { fetchAdminGroups } from '../../../client/src/api/adminApi';

/**
 * Contract of the agent profile editor (AX-B1, AX-B2, AX-B3, AX-B21):
 *
 * - Loading a profile and saving it unchanged sends the profile as loaded,
 *   including a schedule trigger the editor no longer shows.
 * - The Schedule field is not rendered: schedules are not run yet.
 * - JSON mode keeps text that is not valid JSON yet, so structural edits
 *   (a new key, a comma) survive typing.
 * - A comma can be typed into the approver and service-account group fields.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/agentsAdminApi', () => ({
  fetchAgentProfile: jest.fn(),
  createAgentProfile: jest.fn(),
  updateAgentProfile: jest.fn()
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: jest.fn().mockResolvedValue([]),
  fetchAdminModels: jest.fn().mockResolvedValue([]),
  fetchAdminGroups: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

// The Monaco editor loads from a CDN; a textarea stands in for it so the real
// MonacoJsonEditor wrapper (which owns the typed text) is exercised.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, onChange }) => (
    <textarea aria-label="JSON" value={value} onChange={e => onChange(e.target.value)} />
  )
}));

jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  // Always dirty: the page's save bar is shown only for unsaved changes.
  useUnsavedChanges: () => ({
    isDirty: true,
    blocker: { state: 'unblocked' },
    markSaved: jest.fn()
  })
}));

jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => <nav data-testid="breadcrumb" />
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));
jest.mock('../../../client/src/shared/components/IconPicker', () => ({
  __esModule: true,
  default: () => <div data-testid="icon-picker" />
}));
jest.mock('../../../client/src/shared/components/CapabilityFields', () => ({
  __esModule: true,
  default: () => <div data-testid="capabilities" />
}));
// The Skills field is shown only while the skills feature is on (#3778).
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (name, fallback) => (name === 'skills' ? true : fallback) })
}));
jest.mock('../../../client/src/shared/components/SkillsSelector', () => ({
  __esModule: true,
  default: ({ helperText }) => <p data-testid="skills">{helperText}</p>
}));
jest.mock('../../../client/src/features/admin/components/ProjectPicker', () => ({
  __esModule: true,
  default: () => <div data-testid="projects" />
}));

/** A profile as the server returns it, every field set so nothing is defaulted. */
const STORED_PROFILE = {
  id: 'nightly-digest',
  name: { en: 'Nightly digest', de: 'Nächtliche Zusammenfassung' },
  description: { en: 'Summarises the inbox' },
  system: { en: 'You summarise.' },
  color: '#6366F1',
  icon: 'robot',
  workflow: {
    ref: 'embedded',
    definition: {
      triggers: [
        { id: 'nightly', type: 'schedule', config: { cron: '0 2 * * *', timezone: 'UTC' } }
      ]
    }
  },
  preferredModel: 'gpt-4o',
  maxIterations: 10,
  integrations: {},
  systemTools: [],
  webSearch: false,
  projects: [],
  apps: [],
  skills: [],
  memory: {
    enabled: true,
    autoInclude: true,
    maxBytes: 8192,
    modelId: 'gpt-4o',
    system: { en: 'Memory system' },
    prompt: { en: 'Memory prompt' }
  },
  inboxId: '',
  hitl: { approverGroups: ['agent-operators', 'admins'] },
  planner: {
    enabled: false,
    maxTasks: 10,
    system: { en: 'Plan' },
    goal: { en: 'Goal' },
    modelId: 'gpt-4o'
  },
  synthesizer: {
    enabled: true,
    system: { en: 'Synth' },
    prompt: { en: 'Synth prompt' },
    modelId: 'gpt-4o'
  },
  dynamicTasks: { enabled: false, maxDepth: 3 },
  review: { enabled: false, strictness: 'balanced', modelId: 'gpt-4o', system: { en: 'Review' } },
  budgets: { maxWallTimeSec: 600 },
  concurrency: { maxConcurrent: 1 },
  artifacts: { outputDir: 'auto', primary: 'report.md' },
  groups: [],
  serviceAccount: { groups: ['agents', 'authenticated'] },
  enabled: true,
  order: 3
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function renderEditor() {
  render(
    <MemoryRouter initialEntries={['/admin/agents/nightly-digest']}>
      <Routes>
        <Route path="/admin/agents/:profileId" element={<AdminAgentEditPage />} />
        <Route path="/admin/agents" element={<p>agents list</p>} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

/** The save bar's primary button (its last button; Discard comes first). */
function saveBarButton() {
  const bar = screen.getByRole('region', { name: 'Save changes' });
  const buttons = within(bar).getAllByRole('button');
  return buttons[buttons.length - 1];
}

async function save() {
  fireEvent.click(saveBarButton());
  await flush();
  expect(updateAgentProfile).toHaveBeenCalledTimes(1);
  return updateAgentProfile.mock.calls[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchAgentProfile.mockResolvedValue(structuredClone(STORED_PROFILE));
  updateAgentProfile.mockResolvedValue({});
  fetchAdminGroups.mockResolvedValue({
    groups: { admins: { id: 'admins', name: 'Admins' }, users: { id: 'users', name: 'Users' } }
  });
});

test('saving an unchanged profile sends it exactly as loaded, schedule included', async () => {
  await renderEditor();
  const payload = await save();
  expect(updateAgentProfile.mock.calls[0][0]).toBe('nightly-digest');
  expect(payload).toEqual(STORED_PROFILE);
});

test('the Schedule field is not shown while agent schedules are not run', async () => {
  await renderEditor();
  expect(screen.queryByText('Schedule')).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText('*/15 * * * *')).not.toBeInTheDocument();
});

test('the skill picker speaks of this agent, not of an app', async () => {
  await renderEditor();
  expect(screen.getByTestId('skills')).toHaveTextContent('add to this agent');
});

test('JSON mode keeps text that is not valid yet and saves the finished edit', async () => {
  await renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  const editor = screen.getByLabelText('JSON');

  // Half-typed: the JSON is invalid after the comma. The text must stay.
  const text = editor.value;
  const halfTyped = text.replace(/\n}\s*$/, ',\n  "x"\n}');
  fireEvent.change(editor, { target: { value: halfTyped } });
  expect(screen.getByLabelText('JSON').value).toBe(halfTyped);

  const finished = text.replace(/\n}\s*$/, ',\n  "inboxId": "triage"\n}');
  fireEvent.change(screen.getByLabelText('JSON'), { target: { value: finished } });
  expect(screen.getByLabelText('JSON').value).toBe(finished);

  const payload = await save();
  expect(payload.inboxId).toBe('triage');
});

test('JSON mode holds back Save and Form while the text does not parse (no Monaco markers)', async () => {
  await renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  const editor = screen.getByLabelText('JSON');
  const text = editor.value;

  // The stand-in editor never publishes markers, so only the text itself can
  // tell the page that it is invalid.
  fireEvent.change(editor, { target: { value: text.replace(/\n}\s*$/, ',\n  "x"\n}') } });
  expect(screen.getByRole('button', { name: 'Form' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('The JSON is not valid');
  // The bar says why, and its Save saves nothing while the text does not parse.
  expect(
    within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status')
  ).toHaveTextContent('The JSON is not valid');
  fireEvent.click(saveBarButton());
  await flush();
  expect(updateAgentProfile).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('JSON'), { target: { value: text } });
  expect(screen.getByRole('button', { name: 'Form' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status')
  ).not.toHaveTextContent('The JSON is not valid');
  const payload = await save();
  expect(payload.id).toBe(STORED_PROFILE.id);
});

test('a comma separates names in the approver and service-account group fields', async () => {
  await renderEditor();
  const approverField = document.getElementById('agent-hitl-approver-groups');
  fireEvent.focus(approverField);
  // Typing "users,qa" key by key: the comma commits "users"; "qa" is added when
  // the field loses focus.
  for (const ch of 'users,qa') {
    if (ch === ',') {
      fireEvent.keyDown(approverField, { key: ',' });
    } else {
      fireEvent.change(approverField, { target: { value: approverField.value + ch } });
    }
  }
  fireEvent.blur(approverField);

  const serviceField = document.getElementById('agent-service-account-groups');
  fireEvent.focus(serviceField);
  // Pasted at once: both names are kept, not joined into one.
  fireEvent.change(serviceField, { target: { value: 'reporting, writers' } });
  fireEvent.blur(serviceField);

  const payload = await save();
  expect(payload.hitl.approverGroups).toEqual(['agent-operators', 'admins', 'users', 'qa']);
  expect(payload.serviceAccount.groups).toEqual([
    'agents',
    'authenticated',
    'reporting',
    'writers'
  ]);
});
