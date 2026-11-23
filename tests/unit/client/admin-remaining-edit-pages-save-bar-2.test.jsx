// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Save bar on the global prompt variables (Admin → Prompts → Variables): the bar shows
 * only after a change, goes away when the change is reverted, Discard restores what the
 * server has, a failed save is reported in the bar and keeps it, and a save sends only
 * this section and clears the bar. The real unsaved-changes hook is used.
 */

jest.mock('react-i18next', () => {
  const t = (key, fallback, options) => {
    const text = typeof fallback === 'string' ? fallback : key;
    return Object.entries(options || {}).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      text
    );
  };
  const value = { t, i18n: { language: 'en' } };
  return { useTranslation: () => value };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminPrompts: jest.fn(async () => ({ prompts: [] })),
  makeAdminApiCall: jest.fn(),
  togglePrompts: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/api', () => ({ fetchUIConfig: jest.fn(async () => ({})) }));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: () => true })
}));
jest.mock('../../../client/src/features/admin/components/AdminUserPromptsTab', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/prompts/components/PromptDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));

const { makeAdminApiCall } = require('../../../client/src/api/adminApi');
const AdminPromptsPage =
  require('../../../client/src/features/admin/pages/AdminPromptsPage').default;

const SAVED = { context: 'Be brief.', variables: { team: 'Search' } };

function renderVariables() {
  return render(
    <MemoryRouter initialEntries={['/admin/prompts?tab=variables']}>
      <Routes>
        <Route path="/admin/prompts" element={<AdminPromptsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const bar = () => screen.queryByRole('region', { name: 'Save changes' });
const contextBox = () => screen.getByDisplayValue('Be brief.');

beforeEach(() => {
  makeAdminApiCall.mockReset();
  makeAdminApiCall.mockImplementation(async (url, options = {}) => {
    if (options.method === 'POST') return { data: {} };
    return { data: { globalPromptVariables: structuredClone(SAVED) } };
  });
});

describe('global prompt variables save bar', () => {
  it('shows no bar until something changes, and none again when the change is reverted', async () => {
    renderVariables();
    await screen.findByDisplayValue('Be brief.');
    expect(bar()).toBeNull();

    fireEvent.change(contextBox(), { target: { value: 'Be brief!' } });
    expect(bar()).not.toBeNull();

    fireEvent.change(screen.getByDisplayValue('Be brief!'), { target: { value: 'Be brief.' } });
    expect(bar()).toBeNull();
  });

  it('counts an edited variable value as a change', async () => {
    renderVariables();
    await screen.findByDisplayValue('Search');
    fireEvent.change(screen.getByDisplayValue('Search'), { target: { value: 'Apps' } });
    expect(bar()).not.toBeNull();
  });

  it('Discard restores the loaded context and variables', async () => {
    renderVariables();
    await screen.findByDisplayValue('Be brief.');
    fireEvent.change(contextBox(), { target: { value: 'Other' } });
    fireEvent.change(screen.getByDisplayValue('Search'), { target: { value: 'Apps' } });

    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));

    expect(bar()).toBeNull();
    expect(screen.getByDisplayValue('Be brief.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Search')).toBeInTheDocument();
  });

  it('saves only this section and the bar goes away; the next edit shows it again', async () => {
    renderVariables();
    await screen.findByDisplayValue('Be brief.');
    fireEvent.change(contextBox(), { target: { value: 'Be brief!' } });

    await act(async () => {
      const buttons = within(bar()).getAllByRole('button');
      fireEvent.click(buttons[buttons.length - 1]);
    });

    const post = makeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post[0]).toBe('/admin/configs/platform');
    expect(post[1].body).toEqual({
      globalPromptVariables: { context: 'Be brief!', variables: { team: 'Search' } }
    });
    await waitFor(() => expect(bar()).toBeNull());

    // What was saved is the new baseline: Discard after the next edit returns to it.
    fireEvent.change(screen.getByDisplayValue('Be brief!'), { target: { value: 'Again' } });
    expect(bar()).not.toBeNull();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));
    expect(screen.getByDisplayValue('Be brief!')).toBeInTheDocument();
  });

  it('a failed save keeps the bar, with the reason in it, and the edit', async () => {
    makeAdminApiCall.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') throw new Error('Revision conflict');
      return { data: { globalPromptVariables: structuredClone(SAVED) } };
    });
    renderVariables();
    await screen.findByDisplayValue('Be brief.');
    fireEvent.change(contextBox(), { target: { value: 'Be brief!' } });

    await act(async () => {
      const buttons = within(bar()).getAllByRole('button');
      fireEvent.click(buttons[buttons.length - 1]);
    });

    expect(bar()).not.toBeNull();
    expect(within(bar()).getByText('Revision conflict')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Be brief!')).toBeInTheDocument();
  });
});
