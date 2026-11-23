// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The agent, agent inbox and page editors save through the shared bottom bar: no bar while
 * nothing changed, the bar with Discard once something did, "Create" on a new resource, and
 * a Save that runs the page's own save. The change tracking is the real one (not mocked).
 */

jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const mockCreatePage = jest.fn();
const mockUpdatePage = jest.fn();
const mockFetchAdminPage = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  createPage: (...a) => mockCreatePage(...a),
  updatePage: (...a) => mockUpdatePage(...a),
  fetchAdminPage: (...a) => mockFetchAdminPage(...a),
  fetchAdminApps: jest.fn().mockResolvedValue([]),
  fetchAdminModels: jest.fn().mockResolvedValue([]),
  fetchAdminGroups: jest.fn().mockResolvedValue({ groups: {} }),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

const mockFetchAgentProfile = jest.fn();
const mockUpdateAgentProfile = jest.fn();
const mockFetchInbox = jest.fn();
const mockWriteInbox = jest.fn();
jest.mock('../../../client/src/api/agentsAdminApi', () => ({
  fetchAgentProfile: (...a) => mockFetchAgentProfile(...a),
  createAgentProfile: jest.fn(),
  updateAgentProfile: (...a) => mockUpdateAgentProfile(...a),
  fetchInbox: (...a) => mockFetchInbox(...a),
  writeInbox: (...a) => mockWriteInbox(...a)
}));

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, onChange }) => (
    <textarea aria-label="JSON" value={value} onChange={e => onChange(e.target.value)} />
  )
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/IconPicker', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/CapabilityFields', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (name, fallback) => fallback })
}));
jest.mock('../../../client/src/shared/components/SkillsSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ProjectPicker', () => ({
  __esModule: true,
  default: () => null
}));

const AdminPageEditPage =
  require('../../../client/src/features/admin/pages/AdminPageEditPage').default;
const AdminAgentEditPage =
  require('../../../client/src/features/admin/pages/AdminAgentEditPage').default;
const AdminAgentInboxEditPage =
  require('../../../client/src/features/admin/pages/AdminAgentInboxEditPage').default;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const renderAt = async path => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/pages/:pageId" element={<AdminPageEditPage />} />
        <Route path="/admin/pages" element={<p>pages list</p>} />
        <Route path="/admin/agents/inboxes/:inboxId" element={<AdminAgentInboxEditPage />} />
        <Route path="/admin/agents/:profileId" element={<AdminAgentEditPage />} />
        <Route path="/admin/agents" element={<p>agents list</p>} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
};

const bar = () => screen.queryByRole('region', { name: 'Save changes' });
const barButtons = () => within(bar()).getAllByRole('button');
const saveButton = () => barButtons()[barButtons().length - 1];
const discardButton = () => within(bar()).getByRole('button', { name: 'Discard' });

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatePage.mockResolvedValue({});
  mockUpdatePage.mockResolvedValue({});
  mockUpdateAgentProfile.mockResolvedValue({});
  mockWriteInbox.mockResolvedValue({ data: { version: 2 } });
});

describe('page editor', () => {
  test('a new page shows no bar until something is typed, then offers Create and Discard', async () => {
    await renderAt('/admin/pages/new');
    expect(bar()).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Page ID'), { target: { value: 'faq' } });

    expect(bar()).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent('Create');
    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Page ID')).toHaveValue('');
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save in the bar runs the form submit: the page is created', async () => {
    await renderAt('/admin/pages/new');
    fireEvent.change(screen.getByLabelText('Page ID'), { target: { value: 'faq' } });

    fireEvent.click(saveButton());
    await flush();

    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(mockCreatePage.mock.calls[0][0].id).toBe('faq');
    expect(await screen.findByText('pages list')).toBeInTheDocument();
  });

  test('the bar saves nothing for an id of only spaces and says so at the field', async () => {
    await renderAt('/admin/pages/new');
    fireEvent.change(screen.getByLabelText('Page ID'), { target: { value: '   ' } });

    fireEvent.click(saveButton());
    await flush();

    expect(mockCreatePage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ID is required');
  });
});

describe('agent inbox editor', () => {
  beforeEach(() => {
    mockFetchInbox.mockResolvedValue({
      data: { body: '# triage\n- [ ] (P2) first item\n', version: 1 }
    });
  });

  test('no bar for an unchanged inbox; adding an item shows it, Discard takes the item away', async () => {
    await renderAt('/admin/agents/inboxes/triage');
    expect(bar()).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Item text'), { target: { value: 'second item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(bar()).toBeInTheDocument();
    expect(screen.getByDisplayValue('second item')).toBeInTheDocument();
    fireEvent.click(discardButton());
    expect(screen.queryByDisplayValue('second item')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('first item')).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save writes the inbox with its version and the bar goes away', async () => {
    await renderAt('/admin/agents/inboxes/triage');
    fireEvent.change(screen.getByLabelText('Item text'), { target: { value: 'second item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    fireEvent.click(saveButton());
    await flush();

    expect(mockWriteInbox).toHaveBeenCalledTimes(1);
    const [id, body, version] = mockWriteInbox.mock.calls[0];
    expect(id).toBe('triage');
    expect(body).toContain('second item');
    expect(version).toBe(1);
    expect(bar()).not.toBeInTheDocument();
  });

  // The parsed form reads `*` and `-` bullets alike and drops the layout of what it cannot
  // parse, so these edits change nothing in the parsed view. The Raw view saves the text as
  // typed, so they are real changes that must show the bar.
  describe('raw view', () => {
    const STORED = '# triage\n- [ ] (P2) first item\n';
    const EDITED = '# triage\n* [ ] (P2) first item\n\n';

    const openRaw = async () => {
      await renderAt('/admin/agents/inboxes/triage');
      fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
      return screen.getByDisplayValue(/# triage/);
    };

    test('an edit the parser drops shows the bar and is saved as typed', async () => {
      const raw = await openRaw();
      expect(bar()).not.toBeInTheDocument();

      fireEvent.change(raw, { target: { value: EDITED } });
      expect(bar()).toBeInTheDocument();

      fireEvent.click(saveButton());
      await flush();

      expect(mockWriteInbox).toHaveBeenCalledWith('triage', EDITED, 1);
      expect(bar()).not.toBeInTheDocument();
    });

    test('Discard brings back the stored text exactly', async () => {
      const raw = await openRaw();
      fireEvent.change(raw, { target: { value: EDITED } });

      fireEvent.click(discardButton());

      expect(screen.getByDisplayValue(/# triage/).value).toBe(STORED);
      expect(bar()).not.toBeInTheDocument();
    });

    test('typing the stored text back leaves nothing to save', async () => {
      const raw = await openRaw();
      fireEvent.change(raw, { target: { value: EDITED } });
      fireEvent.change(raw, { target: { value: STORED } });
      expect(bar()).not.toBeInTheDocument();
    });
  });
});

describe('agent editor', () => {
  beforeEach(() => {
    mockFetchAgentProfile.mockResolvedValue({
      id: 'digest',
      name: { en: 'Digest' },
      maxIterations: 7
    });
  });

  test('no bar for an unchanged profile; a change shows it, Discard restores the value', async () => {
    await renderAt('/admin/agents/digest');
    expect(bar()).not.toBeInTheDocument();
    // The old always-visible Save is gone.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '9' } });

    expect(bar()).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent('Save Changes');
    fireEvent.click(discardButton());
    expect(screen.getByDisplayValue('7')).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save in the bar updates the profile with the change and returns to the list', async () => {
    await renderAt('/admin/agents/digest');
    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '9' } });

    fireEvent.click(saveButton());
    await flush();

    expect(mockUpdateAgentProfile).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgentProfile.mock.calls[0][0]).toBe('digest');
    expect(mockUpdateAgentProfile.mock.calls[0][1].maxIterations).toBe(9);
    expect(await screen.findByText('agents list')).toBeInTheDocument();
  });

  test('a profile that is not valid JSON is not saved, and the bar says why', async () => {
    await renderAt('/admin/agents/digest');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const text = screen.getByLabelText('JSON').value;
    // A finished edit makes the profile dirty; half-typed text after it is not valid.
    fireEvent.change(screen.getByLabelText('JSON'), {
      target: { value: text.replace(/\n}\s*$/, ',\n  "inboxId": "triage"\n}') }
    });
    expect(bar()).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('JSON'), {
      target: { value: text.replace(/\n}\s*$/, ',\n  "inboxId": "triage",\n  "x"\n}') }
    });

    expect(within(bar()).getByRole('status')).toHaveTextContent('The JSON is not valid');
    fireEvent.click(saveButton());
    await flush();
    expect(mockUpdateAgentProfile).not.toHaveBeenCalled();
  });

  test('the new agent page offers Create once it changed', async () => {
    await renderAt('/admin/agents/new');
    expect(bar()).not.toBeInTheDocument();

    fireEvent.change(document.querySelector('input[type="number"][max="50"]'), {
      target: { value: '12' }
    });

    expect(saveButton()).toHaveTextContent('Create');
  });
});
