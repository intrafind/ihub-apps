// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Moving, copying and merging admin projects (#1036): the move/copy dialog
 * for items, the merge dialog for projects, and the selection column of the
 * shared items table.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApi = {
  fetchAdminProjects: jest.fn(),
  fetchAdminProjectDependencies: jest.fn(),
  transferAdminProjectItems: jest.fn(),
  mergeAdminProjects: jest.fn()
};

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminProjects: (...args) => mockApi.fetchAdminProjects(...args),
  fetchAdminProjectDependencies: (...args) => mockApi.fetchAdminProjectDependencies(...args),
  transferAdminProjectItems: (...args) => mockApi.transferAdminProjectItems(...args),
  mergeAdminProjects: (...args) => mockApi.mergeAdminProjects(...args),
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/data-table', () => ({
  DataTable: ({ columns, data }) => (
    <table>
      <thead>
        <tr>
          {columns.map(column => (
            <th key={column.key}>{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map(row => (
          <tr key={row.id}>
            {columns.map(column => (
              <td key={column.key}>{column.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
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

const TransferItemsDialog =
  require('../../../client/src/features/admin/components/TransferItemsDialog').default;
const MergeProjectsDialog =
  require('../../../client/src/features/admin/components/MergeProjectsDialog').default;
const ProjectItemsTable =
  require('../../../client/src/features/projects/components/ProjectItemsTable').default;

const ITEMS = [
  { id: 'i1', name: 'handbook.md', kind: 'upload', status: 'ready', storage: 'text' },
  { id: 'i2', name: 'Website', kind: 'url', status: 'ready', storage: 'link' }
];
const SITE = { id: 'site', name: { en: 'Website' }, items: ITEMS };
const PROJECTS = [
  SITE,
  { id: 'faq', name: { en: 'FAQ' }, items: [{ id: 'f1' }] },
  { id: 'news', name: { en: 'News' }, items: [], instructions: 'Be brief.' }
];

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchAdminProjects.mockResolvedValue(PROJECTS);
  mockApi.fetchAdminProjectDependencies.mockResolvedValue([]);
});

describe('TransferItemsDialog', () => {
  function renderDialog(props = {}) {
    const onClose = jest.fn();
    const onDone = jest.fn();
    render(
      <TransferItemsDialog
        project={SITE}
        items={ITEMS}
        onClose={onClose}
        onDone={onDone}
        {...props}
      />
    );
    return { onClose, onDone };
  }

  it('offers every other project as the target', async () => {
    renderDialog();
    const select = await screen.findByLabelText('Target project');
    await waitFor(() => expect(select).not.toBeDisabled());
    const labels = within(select)
      .getAllByRole('option')
      .map(option => option.textContent);
    expect(labels.some(label => label.includes('FAQ (faq)'))).toBe(true);
    expect(labels.some(label => label.includes('News (news)'))).toBe(true);
    expect(labels.some(label => label.includes('(site)'))).toBe(false);
  });

  it('moves the items and closes when all of them went', async () => {
    mockApi.transferAdminProjectItems.mockResolvedValue({
      mode: 'move',
      transferred: [{ itemId: 'i1' }, { itemId: 'i2' }],
      failed: [],
      source: SITE,
      target: PROJECTS[1]
    });
    const { onClose, onDone } = renderDialog();
    const select = await screen.findByLabelText('Target project');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: 'faq' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move items' }));

    await waitFor(() =>
      expect(mockApi.transferAdminProjectItems).toHaveBeenCalledWith('site', {
        itemIds: ['i1', 'i2'],
        targetProjectId: 'faq',
        mode: 'move'
      })
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it('copies when asked to', async () => {
    mockApi.transferAdminProjectItems.mockResolvedValue({
      mode: 'copy',
      transferred: [{ itemId: 'i1' }],
      failed: [],
      source: SITE,
      target: PROJECTS[1]
    });
    renderDialog({ items: [ITEMS[0]], initialMode: 'copy' });
    const select = await screen.findByLabelText('Target project');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: 'faq' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy items' }));
    await waitFor(() =>
      expect(mockApi.transferAdminProjectItems).toHaveBeenCalledWith('site', {
        itemIds: ['i1'],
        targetProjectId: 'faq',
        mode: 'copy'
      })
    );
  });

  it('stays open and lists the items that could not go', async () => {
    mockApi.transferAdminProjectItems.mockResolvedValue({
      mode: 'move',
      transferred: [{ itemId: 'i2' }],
      failed: [
        {
          itemId: 'i1',
          name: 'handbook.md',
          code: 'ITEM_NOT_READY',
          message: 'The item is still being processed'
        }
      ],
      source: SITE,
      target: PROJECTS[1]
    });
    const { onClose, onDone } = renderDialog();
    const select = await screen.findByLabelText('Target project');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: 'faq' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move items' }));

    const result = await screen.findByTestId('transfer-result');
    expect(result).toHaveTextContent('1 of 2 items went to "FAQ"');
    expect(result).toHaveTextContent('handbook.md');
    expect(result).toHaveTextContent('The item is still being processed');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server message when the request fails', async () => {
    mockApi.transferAdminProjectItems.mockRejectedValue(new Error('Project not found'));
    const { onDone } = renderDialog();
    const select = await screen.findByLabelText('Target project');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: 'faq' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Project not found');
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('MergeProjectsDialog', () => {
  it('keeps the biggest project by default and summarises what happens', async () => {
    mockApi.fetchAdminProjectDependencies.mockImplementation(async id =>
      id === 'faq' ? [{ type: 'app', id: 'support', name: 'Support' }] : []
    );
    render(<MergeProjectsDialog projects={PROJECTS} onClose={jest.fn()} onDone={jest.fn()} />);
    expect(screen.getByRole('radio', { name: /Website/ })).toBeChecked();
    const summary = screen.getByTestId('merge-summary');
    expect(summary).toHaveTextContent('1 items move from 2 projects into "Website"');
    await waitFor(() =>
      expect(summary).toHaveTextContent('1 apps, workflows or agents will link the kept project')
    );
  });

  it('warns about instructions that are not carried over', () => {
    render(<MergeProjectsDialog projects={PROJECTS} onClose={jest.fn()} onDone={jest.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('These projects have some: News');
  });

  it('merges into the chosen project and reports each source', async () => {
    mockApi.mergeAdminProjects.mockResolvedValue({
      target: SITE,
      sources: [
        {
          id: 'faq',
          moved: 1,
          failed: [],
          relinked: [{ type: 'app', id: 'a' }],
          merged: true,
          deleted: true
        },
        {
          id: 'news',
          moved: 0,
          failed: [
            { itemId: 'n1', name: 'Stuck', code: 'ITEM_NOT_READY', message: 'Still extracting' }
          ],
          relinked: [],
          merged: false,
          deleted: false
        }
      ]
    });
    const onClose = jest.fn();
    const onDone = jest.fn();
    render(<MergeProjectsDialog projects={PROJECTS} onClose={onClose} onDone={onDone} />);

    fireEvent.click(screen.getByRole('button', { name: 'Merge projects' }));

    await waitFor(() =>
      expect(mockApi.mergeAdminProjects).toHaveBeenCalledWith({
        sourceIds: ['faq', 'news'],
        targetId: 'site',
        deleteSources: true
      })
    );
    const result = await screen.findByTestId('merge-result');
    expect(result).toHaveTextContent('FAQ');
    expect(result).toHaveTextContent('1 items moved · deleted · 1 links updated');
    expect(result).toHaveTextContent('Kept with its links');
    expect(result).toHaveTextContent('Stuck — Still extracting');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('can keep the emptied projects and pick another target', async () => {
    mockApi.mergeAdminProjects.mockResolvedValue({ target: PROJECTS[1], sources: [] });
    render(<MergeProjectsDialog projects={PROJECTS} onClose={jest.fn()} onDone={jest.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /FAQ/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Delete the emptied projects/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge projects' }));
    await waitFor(() =>
      expect(mockApi.mergeAdminProjects).toHaveBeenCalledWith({
        sourceIds: ['site', 'news'],
        targetId: 'faq',
        deleteSources: false
      })
    );
  });
});

describe('ProjectItemsTable selection', () => {
  it('offers no checkboxes without a selection handler', () => {
    render(<ProjectItemsTable items={ITEMS} kinds={[]} />);
    expect(screen.queryByLabelText('Select all items')).not.toBeInTheDocument();
  });

  it('selects single items and all of them', () => {
    const onSelectionChange = jest.fn();
    render(
      <ProjectItemsTable
        items={ITEMS}
        kinds={[]}
        selectedIds={new Set(['i1'])}
        onSelectionChange={onSelectionChange}
      />
    );
    fireEvent.click(screen.getByLabelText('Select Website'));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['i1', 'i2']));
    fireEvent.click(screen.getByLabelText('Select handbook.md'));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    fireEvent.click(screen.getByLabelText('Select all items'));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['i1', 'i2']));
  });

  it('hides selection for a read-only reader', () => {
    render(
      <ProjectItemsTable
        items={ITEMS}
        kinds={[]}
        readOnly
        selectedIds={new Set()}
        onSelectionChange={jest.fn()}
      />
    );
    expect(screen.queryByLabelText('Select all items')).not.toBeInTheDocument();
  });
});
