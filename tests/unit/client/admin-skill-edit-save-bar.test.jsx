// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The skill page keeps its overrides behind the bottom save bar: the bar shows only after
 * an edit (from any tab), Discard restores the stored text, Save sends the overrides.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockUpdateSkill = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  deleteSkill: jest.fn(),
  exportSkill: jest.fn(),
  fetchAdminSkillDetail: jest.fn().mockResolvedValue({
    name: 'summarizer',
    displayName: 'Summarizer',
    description: 'Packaged description',
    enabled: true,
    isSystem: false,
    files: [],
    body: ''
  }),
  getAdminApiErrorMessage: err => err?.message || 'error',
  toggleSkill: jest.fn(),
  updateSkill: (...a) => mockUpdateSkill(...a)
}));
const stub = () => ({ __esModule: true, default: () => null });
jest.mock('../../../client/src/shared/components/Icon', () => stub());
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => stub());
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => stub());
jest.mock('../../../client/src/features/admin/components/SystemSkillBadge', () => stub());
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const en = require('../../../shared/i18n/en.json');
const AdminSkillEditPage =
  require('../../../client/src/features/admin/pages/AdminSkillEditPage').default;

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/skills/summarizer']}>
      <Routes>
        <Route path="/admin/skills/:skillName" element={<AdminSkillEditPage />} />
        <Route path="/admin/skills" element={<div>skills list</div>} />
      </Routes>
    </MemoryRouter>
  );

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);

const openConfigTab = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Configuration/ }));
  return screen.findByLabelText('Custom Description');
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateSkill.mockResolvedValue({});
});

describe('AdminSkillEditPage save bar', () => {
  it('has no bar until the overrides change; it stays when another tab is opened', async () => {
    renderPage();
    const description = await openConfigTab();
    expect(bar()).toBeNull();

    fireEvent.change(description, { target: { value: 'Custom text' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Overview/ }));
    expect(bar()).toBeInTheDocument();
  });

  it('Discard restores the stored description', async () => {
    renderPage();
    const description = await openConfigTab();
    expect(description).toHaveValue('Packaged description');

    fireEvent.change(description, { target: { value: 'Custom text' } });
    fireEvent.click(within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard }));

    expect(screen.getByLabelText('Custom Description')).toHaveValue('Packaged description');
    expect(bar()).toBeNull();
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });

  it('Save sends the overrides', async () => {
    renderPage();
    const description = await openConfigTab();
    fireEvent.change(description, { target: { value: 'Custom text' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockUpdateSkill).toHaveBeenCalledWith('summarizer', {
      configOverrides: { description: 'Custom text' }
    });
  });
});
