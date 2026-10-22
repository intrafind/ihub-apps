// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The URL and iFinder pickers of the project "Add item" dialog (#1036): a
 * slow URL check never reports on an earlier URL, Enter cannot start a
 * second iFinder search while one runs, and the item name follows the picked
 * iFinder document until the user types a name of their own.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, def, options) =>
      typeof def === 'string'
        ? Object.entries(options || {}).reduce(
            (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
            def
          )
        : key,
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const {
  IFinderDocumentPicker,
  UrlPicker
} = require('../../../client/src/features/projects/components/item-dialog/ItemPickers');

const errorMessage = err => err.message;

/** The dialog's draft, held in state the way `ItemFormBody` holds it. */
function WithDraft({ picker: Picker, initial, probe, ...props }) {
  const [draft, setDraft] = useState(initial);
  const update = changes => setDraft(prev => ({ ...prev, ...changes }));
  return (
    <>
      <Picker draft={draft} update={update} {...props} />
      <output data-testid="draft">{JSON.stringify(probe ? probe(draft) : draft)}</output>
      <input
        aria-label="Item name"
        value={draft.name || ''}
        onChange={e => update({ name: e.target.value })}
      />
    </>
  );
}

const draftOf = () => JSON.parse(screen.getByTestId('draft').textContent);

function deferred() {
  let resolve;
  const promise = new Promise(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('UrlPicker', () => {
  test('a slow check for an earlier URL does not report on the current one', async () => {
    const first = deferred();
    const second = deferred();
    const checkUrl = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://old.example' }}
        checkUrl={checkUrl}
        errorMessage={errorMessage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(checkUrl).toHaveBeenLastCalledWith('https://new.example');

    // The earlier URL's answer arrives while the new check runs: dropped.
    await act(async () => {
      first.resolve({ ok: false, error: 'not found' });
    });
    expect(screen.queryByText(/cannot be read/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Checking...' })).toBeInTheDocument();

    await act(async () => {
      second.resolve({ ok: true });
    });
    expect(screen.getByText('The page can be read.')).toBeInTheDocument();
  });

  test('a check that answers after the URL was edited shows nothing', async () => {
    const pending = deferred();
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://old.example' }}
        checkUrl={() => pending.promise}
        errorMessage={errorMessage}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.example' } });
    await act(async () => {
      pending.resolve({ ok: true });
    });
    expect(screen.queryByText('The page can be read.')).toBeNull();
  });
});

describe('IFinderDocumentPicker', () => {
  const RESULTS = [
    { documentId: 'd1', title: 'Lease agreement' },
    { documentId: 'd2', title: 'Notice letter' }
  ];

  test('Enter does not start a second search while one runs', async () => {
    const pending = deferred();
    const searchIFinder = jest.fn(() => pending.promise);
    render(
      <WithDraft
        picker={IFinderDocumentPicker}
        initial={{ documentId: '', documentTitle: '', name: '' }}
        searchIFinder={searchIFinder}
        errorMessage={errorMessage}
      />
    );
    const field = screen.getByLabelText('Search iFinder');
    fireEvent.change(field, { target: { value: 'lease' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(searchIFinder).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(RESULTS);
    });
    expect(screen.getByText('Lease agreement')).toBeInTheDocument();
  });

  async function searchAndShow() {
    render(
      <WithDraft
        picker={IFinderDocumentPicker}
        initial={{ documentId: '', documentTitle: '', name: '' }}
        searchIFinder={() => Promise.resolve(RESULTS)}
        errorMessage={errorMessage}
      />
    );
    const field = screen.getByLabelText('Search iFinder');
    fireEvent.change(field, { target: { value: 'lease' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
  }

  test('the name follows the picked document until the user types their own', async () => {
    await searchAndShow();
    fireEvent.click(screen.getByText('Lease agreement'));
    expect(draftOf()).toMatchObject({ documentId: 'd1', name: 'Lease agreement' });

    // Another pick: the name was taken from the first document, so it follows.
    fireEvent.click(screen.getByText('Notice letter'));
    expect(draftOf()).toMatchObject({ documentId: 'd2', name: 'Notice letter' });

    // A name of the user's own stays through the next pick.
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Our lease' } });
    fireEvent.click(screen.getByText('Lease agreement'));
    expect(draftOf()).toMatchObject({ documentId: 'd1', name: 'Our lease' });
  });
});
