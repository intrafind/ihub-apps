// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `DualModeEditor` and the value that is stored.
 *
 * The editor shows "Unsaved changes" and a Reset button. Without `savedValue`
 * both refer to the value the editor was mounted with, so after a save made by
 * the page they still say "unsaved", and Reset would undo what was saved. A
 * page that hands in `savedValue` (the app editor) gets both tied to it.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DualModeEditor from '../../../client/src/shared/components/DualModeEditor';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
jest.mock('../../../client/src/shared/components/Icon', () => () => null);
jest.mock('../../../client/src/shared/components/MonacoJsonEditor', () => () => null);
jest.mock('../../../client/src/hooks/useDarkMode', () => () => ({ isDark: false }));

/** A form with one field, in place of a real form component. */
function NameForm({ value, onChange }) {
  return (
    <input
      aria-label="Name"
      value={value.name}
      onChange={event => onChange({ ...value, name: event.target.value })}
    />
  );
}

let page;

/** A page that holds the value and, when `followSaved` is set, what is stored. */
function Page({ followSaved }) {
  const [value, setValue] = useState({ name: 'Summarizer' });
  const [saved, setSaved] = useState(value);
  page = { value, save: () => setSaved(value) };
  return (
    <DualModeEditor
      value={value}
      onChange={setValue}
      formComponent={NameForm}
      {...(followSaved ? { savedValue: saved } : {})}
    />
  );
}

const type = name => fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
const unsaved = () => screen.queryByText('Unsaved changes');
const resetButton = () => screen.queryByRole('button', { name: 'Reset' });

describe('DualModeEditor with savedValue', () => {
  test('a save by the page clears "Unsaved changes" and the Reset button', () => {
    render(<Page followSaved />);
    expect(unsaved()).not.toBeInTheDocument();

    type('Summarizer 2');
    expect(unsaved()).toBeInTheDocument();
    expect(resetButton()).toBeInTheDocument();

    act(() => page.save());
    expect(unsaved()).not.toBeInTheDocument();
    expect(resetButton()).not.toBeInTheDocument();
    expect(screen.getByText('All valid')).toBeInTheDocument();
  });

  test('Reset goes back to what is stored, not to what the editor was opened with', () => {
    render(<Page followSaved />);
    type('Summarizer 2');
    act(() => page.save());
    type('Summarizer 3');

    fireEvent.click(resetButton());
    fireEvent.click(screen.getByRole('button', { name: 'Reset changes' }));

    expect(page.value).toEqual({ name: 'Summarizer 2' });
    expect(unsaved()).not.toBeInTheDocument();
  });

  test('typing the stored value again is no unsaved change', () => {
    render(<Page followSaved />);
    type('Other');
    type('Summarizer');
    expect(unsaved()).not.toBeInTheDocument();
  });

  test('a switch of the mode with unsaved changes keeps them unsaved', () => {
    render(<Page followSaved />);
    type('Summarizer 2');

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch editor' }));

    expect(unsaved()).toBeInTheDocument();
  });
});

describe('DualModeEditor without savedValue (every other admin editor)', () => {
  test('compares with the value it was opened with, whatever the page saved', () => {
    render(<Page followSaved={false} />);
    type('Summarizer 2');
    act(() => page.save());
    expect(unsaved()).toBeInTheDocument();

    fireEvent.click(resetButton());
    fireEvent.click(screen.getByRole('button', { name: 'Reset changes' }));
    expect(page.value).toEqual({ name: 'Summarizer' });
  });

  test('a confirmed switch of the mode makes the current value the one to compare with', () => {
    render(<Page followSaved={false} />);
    type('Summarizer 2');

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch editor' }));

    expect(unsaved()).not.toBeInTheDocument();
  });
});
