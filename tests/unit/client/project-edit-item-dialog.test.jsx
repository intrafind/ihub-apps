// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "For the AI" lives in the edit dialog of an item, not in the items table:
 * every kind of item can be edited for its name and that setting, a link item
 * also for what it points at.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, children }) => (isOpen ? <div role="dialog">{children}</div> : null)
}));
jest.mock('../../../client/src/features/projects/components/item-dialog/ItemPickers', () => ({
  __esModule: true,
  LinkKindPicker: ({ kind }) => <div data-testid="link-picker">{kind}</div>
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, def) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en' }
  })
}));

const EditItemDialog =
  require('../../../client/src/features/projects/components/EditItemDialog').default;
const ProjectItemsTable =
  require('../../../client/src/features/projects/components/ProjectItemsTable').default;

const api = { fetchPages: jest.fn().mockResolvedValue([]), errorMessage: err => err.message };
const upload = { id: 'i1', name: 'handbook.md', kind: 'upload', status: 'ready', storage: 'text' };

describe('EditItemDialog', () => {
  it('offers For the AI for an upload, without the link pickers', () => {
    render(<EditItemDialog item={upload} api={api} onClose={jest.fn()} onSave={jest.fn()} />);
    expect(screen.getByLabelText('For the AI')).toHaveValue('normal');
    expect(screen.queryByTestId('link-picker')).not.toBeInTheDocument();
  });

  it('shows the link pickers for a link item', () => {
    const link = { id: 'i2', name: 'Site', kind: 'url', ref: { url: 'https://a.example' } };
    render(<EditItemDialog item={link} api={api} onClose={jest.fn()} onSave={jest.fn()} />);
    expect(screen.getByTestId('link-picker')).toBeInTheDocument();
    expect(screen.getByLabelText('For the AI')).toBeInTheDocument();
  });

  it('saves the chosen setting alone', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    render(<EditItemDialog item={upload} api={api} onClose={onClose} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('For the AI'), { target: { value: 'excluded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ pinned: false, excludedFromAi: true })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('starts from the setting the item has and saves nothing when it is unchanged', async () => {
    const onSave = jest.fn();
    const onClose = jest.fn();
    render(
      <EditItemDialog
        item={{ ...upload, pinned: true }}
        api={api}
        onClose={onClose}
        onSave={onSave}
      />
    );
    expect(screen.getByLabelText('For the AI')).toHaveValue('pinned');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('ProjectItemsTable', () => {
  it('has no For the AI column or select, and offers Edit for every kind', () => {
    render(<ProjectItemsTable items={[upload]} kinds={[]} onEdit={jest.fn()} />);
    expect(screen.queryByText('For the AI')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('marks a pinned or Not for AI item in its name cell', () => {
    render(
      <ProjectItemsTable
        items={[
          { ...upload, id: 'a', name: 'A', pinned: true },
          { ...upload, id: 'b', name: 'B', excludedFromAi: true },
          { ...upload, id: 'c', name: 'C' }
        ]}
        kinds={[]}
      />
    );
    expect(screen.getAllByText('Pinned')).toHaveLength(1);
    expect(screen.getAllByText('Not for AI')).toHaveLength(1);
  });
});
