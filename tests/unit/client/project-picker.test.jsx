// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProjectPicker (#1036): picks the projects linked to apps, workflow prompt
 * nodes and agent profiles. Bare string ids come in and leave as normalized
 * `{ id, mode, write }` links; each link has a mode select and a token count;
 * disabled projects are not offered; the picker hides itself when the
 * projects feature is off.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockFetchAdminProjects = jest.fn();
const mockFetchAdminProjectTokens = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminProjects: (...args) => mockFetchAdminProjects(...args),
  fetchAdminProjectTokens: (...args) => mockFetchAdminProjectTokens(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const ProjectPicker =
  require('../../../client/src/features/admin/components/ProjectPicker').default;

const PROJECTS = [
  { id: 'handbook', name: { en: 'Employee handbook' }, enabled: true, items: [{}, {}] },
  { id: 'faq', name: { en: 'FAQ' }, enabled: true, items: [] },
  { id: 'archive', name: { en: 'Old archive' }, enabled: false, items: [] }
];

beforeEach(() => {
  mockFetchAdminProjects.mockReset().mockResolvedValue(PROJECTS);
  mockFetchAdminProjectTokens.mockReset().mockResolvedValue({
    loadAllBudgetTokens: 1000,
    toolResultBudgetTokens: 400,
    projects: { handbook: { tokens: 5000, items: 2, bytes: 20000 }, faq: { tokens: 300 } }
  });
});

describe('ProjectPicker', () => {
  test('normalizes bare string ids when the mode changes', async () => {
    const onChange = jest.fn();
    render(<ProjectPicker value={['handbook', 'faq']} onChange={onChange} />);

    const select = await screen.findByLabelText('Mode of Employee handbook');
    expect(select).toHaveValue('auto');
    fireEvent.change(select, { target: { value: 'tools' } });

    expect(onChange).toHaveBeenCalledWith([
      { id: 'handbook', mode: 'tools', write: false },
      { id: 'faq', mode: 'auto', write: false }
    ]);
  });

  test('keeps the write flag of an object link', async () => {
    const onChange = jest.fn();
    render(
      <ProjectPicker value={[{ id: 'faq', mode: 'context', write: true }]} onChange={onChange} />
    );

    fireEvent.change(await screen.findByLabelText('Mode of FAQ'), { target: { value: 'auto' } });

    expect(onChange).toHaveBeenCalledWith([{ id: 'faq', mode: 'auto', write: true }]);
  });

  test('links a project in auto mode and unlinks it again', async () => {
    const onChange = jest.fn();
    const { rerender } = render(<ProjectPicker value={[]} onChange={onChange} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'FAQ' }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'faq', mode: 'auto', write: false }]);

    rerender(
      <ProjectPicker value={[{ id: 'faq', mode: 'auto', write: false }]} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unlink FAQ' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  test('does not offer disabled projects but explains a linked one', async () => {
    render(<ProjectPicker value={['archive']} onChange={jest.fn()} />);

    expect(await screen.findByText('This project is disabled.')).toBeInTheDocument();
    render(<ProjectPicker value={[]} onChange={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('checkbox', { name: 'FAQ' })).toHaveLength(2));
    // Only the picker that links it lists the disabled project.
    expect(screen.getAllByRole('checkbox', { name: 'Old archive' })).toHaveLength(1);
  });

  test('shows the size against the mode budgets', async () => {
    render(
      <ProjectPicker value={['handbook', { id: 'faq', mode: 'context' }]} onChange={jest.fn()} />
    );

    const handbook = await screen.findByTestId('project-link-handbook');
    await waitFor(() =>
      expect(
        within(handbook).getByText(/5(\.0)?K tokens|5,000 tokens|5000 tokens/)
      ).toBeInTheDocument()
    );
    expect(
      within(handbook).getByText('too large to load; searched with tools')
    ).toBeInTheDocument();

    const faq = screen.getByTestId('project-link-faq');
    expect(within(faq).getByText('sent with every request')).toBeInTheDocument();
  });

  test('renders nothing when the projects feature is disabled', async () => {
    mockFetchAdminProjects.mockRejectedValue({
      response: { status: 403, data: { code: 'FEATURE_DISABLED' } }
    });
    const { container } = render(<ProjectPicker value={[]} onChange={jest.fn()} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
