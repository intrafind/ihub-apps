// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The item text dialog (#1036): the preview of what the model reads, and —
 * for a written, uploaded or imported document — editing that text in
 * place, the successor of editing a source file in the admin editor.
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
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, def, options) =>
      typeof def === 'string'
        ? def.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));

const ProjectItemTextDialog =
  require('../../../client/src/features/projects/components/ProjectItemTextDialog').default;
const {
  ITEM_TEXT_EDIT_CHARS,
  ITEM_TEXT_PREVIEW_CHARS,
  isItemTextEditable
} = require('../../../client/src/features/projects/utils/projectItems');

const written = {
  id: 'itm_1',
  name: 'Notes.md',
  kind: 'upload',
  storage: 'text',
  status: 'ready',
  text: { chars: 9, tokens: 3 },
  provenance: { origin: 'written' }
};
const picked = {
  ...written,
  id: 'itm_2',
  kind: 'office365',
  provenance: { origin: 'picked' }
};
const errorMessage = err => err.message;

function renderDialog({ item = written, onSave, fetchText } = {}) {
  const loader =
    fetchText || jest.fn(async () => ({ text: 'Old notes.', chars: 10, truncated: false }));
  const utils = render(
    <ProjectItemTextDialog
      projectId="prj_case"
      item={item}
      onClose={() => {}}
      fetchText={loader}
      onSave={onSave}
      errorMessage={errorMessage}
    />
  );
  return { ...utils, loader };
}

describe('isItemTextEditable', () => {
  it('allows a readable stored text written, uploaded or imported, nothing else', () => {
    expect(isItemTextEditable(written)).toBe(true);
    expect(isItemTextEditable({ ...written, provenance: { origin: 'uploaded' } })).toBe(true);
    expect(isItemTextEditable({ ...written, provenance: { origin: 'imported' } })).toBe(true);
    expect(isItemTextEditable({ ...written, status: 'stale' })).toBe(true);
    expect(isItemTextEditable(picked)).toBe(false);
    expect(isItemTextEditable({ ...written, storage: 'link', text: null })).toBe(false);
    expect(isItemTextEditable({ ...written, status: 'extracting' })).toBe(false);
    expect(isItemTextEditable({ ...written, text: null })).toBe(false);
    expect(isItemTextEditable(null)).toBe(false);
  });
});

describe('ProjectItemTextDialog', () => {
  it('shows the text, and offers no editing without a save handler', async () => {
    renderDialog();
    expect(await screen.findByText('Old notes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
  });

  it('offers editing only for a written, uploaded or imported document', async () => {
    const onSave = jest.fn();
    const { unmount } = renderDialog({ onSave });
    expect(await screen.findByRole('button', { name: 'Edit text' })).toBeInTheDocument();
    unmount();
    renderDialog({ item: picked, onSave });
    expect(await screen.findByText('Old notes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
  });

  it('edits the text in place and shows what was saved', async () => {
    const onSave = jest.fn(async () => ({ ...written, text: { chars: 9 } }));
    renderDialog({ onSave });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
    const area = screen.getByRole('textbox', { name: 'Text of the document' });
    expect(area).toHaveValue('Old notes.');
    fireEvent.change(area, { target: { value: 'New notes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('New notes.'));
    expect(await screen.findByText('New notes.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit text' })).toBeInTheDocument();
  });

  it('refuses an empty text, keeps the draft on a failure and can cancel', async () => {
    const onSave = jest.fn(async () => {
      throw new Error('The project is read-only.');
    });
    renderDialog({ onSave });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
    const area = screen.getByRole('textbox', { name: 'Text of the document' });
    fireEvent.change(area, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(area, { target: { value: 'Draft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The project is read-only.');
    expect(screen.getByRole('textbox')).toHaveValue('Draft.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Old notes.')).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('loads the whole text before editing a document the preview cut', async () => {
    const whole = 'x'.repeat(ITEM_TEXT_PREVIEW_CHARS + 5);
    const fetchText = jest.fn(async (_projectId, _itemId, { maxChars }) =>
      maxChars >= whole.length
        ? { text: whole, chars: whole.length, truncated: false }
        : { text: whole.slice(0, maxChars), chars: whole.length, truncated: true }
    );
    renderDialog({ onSave: jest.fn(), fetchText });
    expect(await screen.findByText(/Showing the first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
    const area = await screen.findByRole('textbox', { name: 'Text of the document' });
    expect(area).toHaveValue(whole);
    expect(fetchText).toHaveBeenLastCalledWith('prj_case', 'itm_1', {
      maxChars: ITEM_TEXT_EDIT_CHARS
    });
  });
});
